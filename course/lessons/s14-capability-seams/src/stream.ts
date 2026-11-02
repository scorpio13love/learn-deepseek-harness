/**
 * s13 · capability seams：沿用前序课程的实现（本课改动见 README）。
 */

import type {
  AssistantStreamFrame,
  ContentBlock,
  StreamChunk,
  TimedStreamChunk,
  TokenUsage,
} from './types.ts'
import { deepFreeze } from './types.ts'

/** 把零散的 StreamChunk 组装成模型内容块。 */
export class StreamAssembler {
  #blocks = new Map<number, ContentBlock>()
  #open = new Map<number, { type: ContentBlock['type']; text: string; id: string; name: string; args: string }>()
  usage: TokenUsage | undefined
  finish: Extract<StreamChunk, { type: 'finish' }> | undefined

  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start':
        this.#open.set(chunk.index, {
          type: chunk.blockType,
          text: '',
          id: '',
          name: '',
          args: '',
        })
        break
      case 'text-delta':
      case 'reasoning-delta': {
        const open = this.#open.get(chunk.index)
        if (open !== undefined) open.text += chunk.text
        break
      }
      case 'tool-call-delta': {
        const open = this.#open.get(chunk.index)
        if (open !== undefined) {
          open.id = chunk.id
          if (chunk.name !== undefined) open.name = chunk.name
          open.args += chunk.argumentsDelta
        }
        break
      }
      case 'block-end':
        this.#blocks.set(chunk.index, chunk.block)
        this.#open.delete(chunk.index)
        break
      case 'usage':
        this.usage = chunk.usage
        break
      case 'finish':
        this.finish = chunk
        break
    }
  }

  get finished(): Extract<StreamChunk, { type: 'finish' }> | undefined {
    return this.finish
  }

  /** 组装完整内容块；没有 block-end 的块从 delta 合成。 */
  blocks(): ContentBlock[] {
    const indexes = new Set<number>([...this.#blocks.keys(), ...this.#open.keys()])
    return [...indexes]
      .sort((a, b) => a - b)
      .map((index) => {
        const completed = this.#blocks.get(index)
        if (completed !== undefined) return completed
        const open = this.#open.get(index)
        if (open === undefined) return undefined
        if (open.type === 'text') return { type: 'text' as const, text: open.text }
        if (open.type === 'reasoning') return { type: 'reasoning' as const, text: open.text }
        return {
          type: 'tool-call' as const,
          id: open.id,
          name: open.name,
          arguments: open.args,
        }
      })
      .filter((block): block is ContentBlock => block !== undefined)
      .filter(block => block.type !== 'text' || block.text.length > 0)
      .filter(block => block.type !== 'reasoning' || block.text.length > 0)
  }

  /** 取消时保留已交付的可见前缀；未完成的工具调用不进入历史。 */
  partialBlocks(): ContentBlock[] {
    return this.blocks().filter(block => block.type !== 'tool-call')
  }
}

/** 从持久 stream 重新组装内容块，用于重放/测试。 */
export function expandStream(records: readonly TimedStreamChunk[]): {
  blocks: ContentBlock[]
  usage?: TokenUsage
  finish?: Extract<StreamChunk, { type: 'finish' }>
} {
  const assembler = new StreamAssembler()
  for (const record of records) assembler.push(record.chunk)
  return {
    blocks: assembler.blocks(),
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    ...assembler.finished === undefined ? {} : { finish: assembler.finished },
  }
}

export interface AssistantStreamAttemptOptions {
  attemptId: string
  turn: number
  step: number
  /** 进程内 live 帧；真实 DSH 通过 `agent/assistant-stream` 发布。 */
  onFrame?: (frame: AssistantStreamFrame) => void
}

/**
 * 一次模型请求的流式 attempt。
 *
 * - 每个 chunk 同时进入 assembler 和持久 stream；
 * - 成功/失败/取消都保留同一份 stream；
 * - live 帧只用于 UI，持久结算由 agent 在 append 之后调用 `settle()`。
 */
export class AssistantStreamAttempt {
  readonly attemptId: string
  readonly turn: number
  readonly step: number
  #assembler = new StreamAssembler()
  #records: TimedStreamChunk[] = []
  #index = 0
  #started = false
  #ended = false
  #onFrame: ((frame: AssistantStreamFrame) => void) | undefined

  constructor(options: AssistantStreamAttemptOptions) {
    this.attemptId = options.attemptId
    this.turn = options.turn
    this.step = options.step
    this.#onFrame = options.onFrame
  }

  get ended(): boolean {
    return this.#ended
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#onFrame?.({ type: 'start', attemptId: this.attemptId, turn: this.turn, step: this.step })
  }

  push(chunk: StreamChunk): void {
    const time = Date.now()
    const record = deepFreeze({ time, chunk: structuredClone(chunk) })
    this.#records.push(record)
    this.#assembler.push(record.chunk)
    this.#onFrame?.({
      type: 'chunk',
      attemptId: this.attemptId,
      index: this.#index,
      time,
      chunk: record.chunk,
    })
    this.#index += 1
  }

  /** 已持久化的完整 stream；调用方负责把它写进 assistant/message 或 attempt。 */
  get stream(): TimedStreamChunk[] {
    return this.#records
  }

  get blocks(): ContentBlock[] {
    return this.#assembler.blocks()
  }

  get partialBlocks(): ContentBlock[] {
    return this.#assembler.partialBlocks()
  }

  get usage(): TokenUsage | undefined {
    return this.#assembler.usage
  }

  get finish(): Extract<StreamChunk, { type: 'finish' }> | undefined {
    return this.#assembler.finished
  }

  /** 在持久结算 append 成功后发布 end 帧。 */
  settle(outcome: 'committed' | 'abandoned', eventType?: 'assistant/message' | 'assistant/attempt'): void {
    if (this.#ended) return
    this.#ended = true
    this.#onFrame?.({
      type: 'end',
      attemptId: this.attemptId,
      outcome,
      ...eventType === undefined ? {} : { eventType },
    })
  }
}
