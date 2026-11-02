/**
 * s16 · web：沿用前序课程的实现（本课改动见 README）。
 */

import type { Message, Model, SessionEvent } from './types.ts'
import { createMessage, createTextMessage, Session } from './session.ts'
import { StreamAssembler } from './stream.ts'
import { isToolCall, textOf } from './types.ts'

export interface Summarizer {
  (input: string, signal: AbortSignal): Promise<string>
}

export interface CompactionConfig {
  /** 路由的上下文窗口；prepared capability 可以覆盖。 */
  contextWindow: number
  /** 超过 contextWindow * thresholdRatio 时触发。 */
  thresholdRatio?: number
  /** 保留最近 contextWindow * retainRatio 的 token。 */
  retainRatio?: number
  /** 少于这个数量的消息不压缩。 */
  minMessages?: number
  /** 单个工具结果超过这个字符数时先裁剪。 */
  maxToolResultChars?: number
  summarizer?: Summarizer
}

export interface CompactionResult {
  compacted: boolean
  prunedToolResults: number
  summarizedMessages: number
  estimatedFreedTokens: number
  reason: string
}

interface SurfaceMessage {
  seq: number
  message: Message
}

function messageOf(event: SessionEvent): Message | undefined {
  switch (event.type) {
    case 'user/message':
    case 'tool/result':
      return event.data.message
    case 'system/message':
    case 'developer/message':
    case 'assistant/message':
      return event.data.message.content.length === 0 ? undefined : event.data.message
    default:
      return undefined
  }
}

function surfaceMessages(session: Session): SurfaceMessage[] {
  const out: SurfaceMessage[] = []
  for (const seq of session.surfaceSeqs) {
    const event = session.events[seq]
    if (event === undefined) continue
    const message = messageOf(event)
    if (message !== undefined) out.push({ seq, message })
  }
  return out
}

function messageTokens(message: Message): number {
  let chars = 0
  for (const block of message.content) {
    if (block.type === 'text' || block.type === 'reasoning') chars += block.text.length
    else if (block.type === 'tool-call') chars += block.name.length + block.arguments.length
  }
  return Math.ceil(chars / 4) + 4
}

function estimateTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0)
}

export async function summarizeWithModel(model: Model, input: string, signal: AbortSignal): Promise<string> {
  const assembler = new StreamAssembler()
  const request = {
    sessionId: 'compaction',
    provider: model.provider,
    model: model.model,
    messages: [createTextMessage('user', [
      'Summarize the conversation below for future context.',
      'Keep decisions, tool results, unresolved work, and user constraints.',
      'Write one concise paragraph.',
      '',
      input,
    ].join('\n'))],
    tools: [],
    signal,
  }
  for await (const chunk of model.stream(request)) assembler.push(chunk)
  const summary = assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
  if (summary.length === 0) throw new Error('compaction summarizer returned empty text')
  return summary
}

export class Compaction {
  #config: Required<Pick<CompactionConfig, 'contextWindow' | 'thresholdRatio' | 'retainRatio' | 'minMessages' | 'maxToolResultChars'>> & { summarizer?: Summarizer }

  constructor(config: CompactionConfig) {
    this.#config = {
      contextWindow: config.contextWindow,
      thresholdRatio: config.thresholdRatio ?? 0.8,
      retainRatio: config.retainRatio ?? 0.16,
      minMessages: config.minMessages ?? 4,
      maxToolResultChars: config.maxToolResultChars ?? 4_000,
      ...config.summarizer === undefined ? {} : { summarizer: config.summarizer },
    }
  }

  get threshold(): number {
    return Math.floor(this.#config.contextWindow * this.#config.thresholdRatio)
  }

  get retainTokens(): number {
    return Math.floor(this.#config.contextWindow * this.#config.retainRatio)
  }

  estimate(session: Session): number {
    return estimateTokens(session.deriveMessages())
  }

  /** 超过阈值时压缩；返回是否发生压缩。 */
  async beforeStep(
    session: Session,
    model: Model,
    signal: AbortSignal,
    contextWindow?: number,
  ): Promise<CompactionResult> {
    const threshold = contextWindow === undefined
      ? this.threshold
      : Math.floor(contextWindow * this.#config.thresholdRatio)
    if (this.estimate(session) < threshold) {
      return { compacted: false, prunedToolResults: 0, summarizedMessages: 0, estimatedFreedTokens: 0, reason: 'below-threshold' }
    }
    return this.compact(session, model, signal)
  }

  /** 无条件压缩一次（用于 overflow 恢复）。 */
  async compact(session: Session, model: Model, signal: AbortSignal): Promise<CompactionResult> {
    const before = this.estimate(session)
    let prunedToolResults = 0
    let nodes = surfaceMessages(session)
    if (nodes.length < this.#config.minMessages) {
      return { compacted: false, prunedToolResults: 0, summarizedMessages: 0, estimatedFreedTokens: 0, reason: 'too-few-messages' }
    }

    // 1. 先裁剪过大的工具结果。
    for (const node of [...nodes]) {
      if (node.message.role !== 'tool') continue
      const text = textOf(node.message)
      if (text.length <= this.#config.maxToolResultChars) continue
      const event = session.events[node.seq]
      if (event?.type !== 'tool/result') continue
      const short = `${text.slice(0, this.#config.maxToolResultChars)}\n… [truncated by compaction]`
      const replacement = createMessage({
        role: 'tool',
        ...node.message.toolCallId === undefined ? {} : { toolCallId: node.message.toolCallId },
        ...node.message.isError === undefined ? {} : { isError: node.message.isError },
        content: [{ type: 'text', text: short }],
      })
      session.append('tool/result', {
        turn: event.data.turn,
        step: event.data.step,
        message: replacement,
      }, {
        surfaceOp: { op: 'replace', startSeq: node.seq, endSeq: node.seq },
        sourceEventSeqs: [node.seq],
      })
      prunedToolResults += 1
    }

    nodes = surfaceMessages(session)
    const systemHead = nodes[0]?.message.role === 'system' ? nodes[0] : undefined
    const tail: SurfaceMessage[] = []
    let tailTokens = 0
    for (let index = nodes.length - 1; index >= (systemHead === undefined ? 0 : 1); index -= 1) {
      const node = nodes[index]!
      const tokens = messageTokens(node.message)
      if (tail.length > 0 && tailTokens + tokens > this.retainTokens) break
      tail.unshift(node)
      tailTokens += tokens
    }

    const old = nodes.filter(node => node !== systemHead && !tail.includes(node))
    if (old.length === 0) {
      return {
        compacted: prunedToolResults > 0,
        prunedToolResults,
        summarizedMessages: 0,
        estimatedFreedTokens: Math.max(0, before - this.estimate(session)),
        reason: prunedToolResults > 0 ? 'pruned-only' : 'nothing-to-compact',
      }
    }

    // 2. 摘要旧段落。
    const transcript = old.map(({ message }) => `${message.role}: ${textOf(message)}`).join('\n')
    const summary = this.#config.summarizer === undefined
      ? await summarizeWithModel(model, transcript, signal)
      : await this.#config.summarizer(transcript, signal)
    const summaryMessage = createTextMessage('user', `（压缩摘要）\n${summary}`)
    session.append('user/message', { message: summaryMessage }, {
      surfaceOp: {
        op: 'replace',
        startSeq: old[0]!.seq,
        endSeq: old[old.length - 1]!.seq,
      },
      sourceEventSeqs: old.map(node => node.seq),
    })

    const after = this.estimate(session)
    return {
      compacted: true,
      prunedToolResults,
      summarizedMessages: old.length,
      estimatedFreedTokens: Math.max(0, before - after),
      reason: 'compacted',
    }
  }
}

/** 简单判断模型失败是否是上下文溢出。 */
export function isContextOverflow(failure: { code: string; message: string }): boolean {
  return failure.code === 'CONTEXT_OVERFLOW'
    || failure.code === 'context_length_exceeded'
    || /context (window|length)|too many tokens|prompt is too long/i.test(failure.message)
}

export { estimateTokens, surfaceMessages }
