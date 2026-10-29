/**
 * s02 的 driver：在 s01 的 turn/step 状态机上接入 surface 日志。
 *
 * 与 s01 的差别：
 * - 每个消息事件都必须声明 `surfaceOp: 'append'`，否则 `Session.append()` 拒绝；
 * - `request/header` 记录完整的 `EpochHeader`（config + tools），只在首次/变化时写；
 * - `request/context` 单独记录路由元数据，只在变化时写；
 * - 请求仍然从 `deriveMessages()` 派生，所以一次 surface replace 会立刻影响下一步请求；
 * - 仍不包含 pre-step、inbox、持久化、并发和完整流式结算（分别留给 s07/s09/s03）。
 *
 * 真实 DSH 的 driver 在 `packages/core/agent-loop/src/agent.ts`：
 * - `turn()` 打开轮次，并在 finally 里保证 `turn/end`；
 * - `preStep()` 领取输入、解析工具、组装提示词、跑 pre-step waterfall；
 * - `step()` 准备请求、写入系统/用户消息、流式调用、结算、分发工具；
 * - `prepareRequest()` 绑定适配器，`buildRequest()` 从日志派生并冻结请求。
 */

import type {
  ChatRequest,
  ContentBlock,
  EpochHeader,
  LlmFailure,
  Message,
  Model,
  RequestContext,
  StreamChunk,
  TokenUsage,
  ToolCallBlock,
  TurnEndReason,
} from './types.ts'
import {
  isToolCall,
  toLlmFailure,
} from './types.ts'
import { createMessage, createTextMessage, Session } from './session.ts'
import type { ToolRegistry } from './tools.ts'

export interface AgentOptions {
  /** 教学守卫：防止模型无限调用工具。真实 DSH 没有这个上限。 */
  maxSteps?: number
  /** 写入 request/header 的每请求输出上限。 */
  maxTokens?: number
}

export interface RunOptions {
  signal?: AbortSignal
}

export interface RunResult {
  reason: TurnEndReason
  /** 本轮的最终 assistant 消息；没有模型输出时为 undefined。 */
  finalMessage?: Message
  /** 实际执行的步骤数。 */
  steps: number
}

export class LlmError extends Error {
  readonly failure: LlmFailure

  constructor(failure: LlmFailure) {
    super(failure.message)
    this.name = 'LlmError'
    this.failure = failure
  }
}

/**
 * 把零散的 StreamChunk 组装成模型消息。
 * 真实实现见 `packages/llm/llm/src/assembler.ts`；s03 会补齐交错块、
 * tool-call 参数分片、attempt 与 interrupted 的完整语义。
 */
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

interface StepOutcome {
  message: Message
  /** 需要继续执行工具时给出调用列表。 */
  toolCalls?: ToolCallBlock[]
  reason?: TurnEndReason
}

export class Agent {
  readonly session: Session
  #model: Model
  #tools: ToolRegistry
  #maxSteps: number
  #maxTokens: number | undefined
  #turn = 0
  #lastHeader: string | undefined
  #lastContext: string | undefined

  constructor(session: Session, model: Model, tools: ToolRegistry, options: AgentOptions = {}) {
    this.session = session
    this.#model = model
    this.#tools = tools
    this.#maxSteps = options.maxSteps ?? 8
    this.#maxTokens = options.maxTokens
  }

  get turns(): number {
    return this.#turn
  }

  /**
   * 运行一个完整轮次。
   *
   * 失败不会让异常穿透到调用方：轮次总会以 `turn/end` 关闭，并把原因
   * 放在 `RunResult.reason` 里。这与真实 DSH「driver 边界兜住失败」一致。
   */
  async run(prompt: string, options: RunOptions = {}): Promise<RunResult> {
    const signal = options.signal ?? new AbortController().signal
    const turn = this.#turn + 1
    this.#turn = turn

    this.session.append('turn/start', { turn })

    let reason: TurnEndReason = { kind: 'completed' }
    let finalMessage: Message | undefined
    let steps = 0

    try {
      for (let step = 1; step <= this.#maxSteps; step += 1) {
        steps = step
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })

        try {
          // 真实 loop 在 pre-step 接纳输入之后、step/start 之后才把 user/message
          // 写进日志；这一课没有 pre-step，因此把首次接纳放在第一步的入口。
          if (step === 1) {
            this.session.append('user/message', {
              message: createTextMessage('user', prompt),
            }, { surfaceOp: 'append' })
          }

          const outcome = await this.#runStep(turn, step, signal)
          finalMessage = outcome.message

          const calls = outcome.toolCalls ?? []
          if (calls.length === 0) {
            reason = outcome.reason ?? { kind: 'completed' }
            break
          }

          for (const call of calls) {
            signal.throwIfAborted()
            this.session.append('tool/call', {
              turn,
              step,
              callId: call.id,
              name: call.name,
              arguments: call.arguments,
            })

            const result = await this.#tools.execute(call, {
              signal,
              callId: call.id,
              sessionId: this.session.id,
            })

            signal.throwIfAborted()
            const message = createMessage({
              role: 'tool',
              toolCallId: call.id,
              isError: result.isError,
              content: result.content,
            })
            this.session.append('tool/result', { turn, step, message }, { surfaceOp: 'append' })
          }

          if (step === this.#maxSteps) {
            reason = { kind: 'max-steps' }
            break
          }
        } finally {
          // 真实 loop 同样在 finally 中关闭步骤，保证失败/取消也能回放。
          this.session.append('step/end', { turn, step })
        }
      }
    } catch (error) {
      if (signal.aborted) {
        reason = { kind: 'aborted', reason: cancelReason(signal) }
      } else if (error instanceof LlmError) {
        reason = { kind: 'error', failure: error.failure }
      } else {
        reason = { kind: 'error', failure: toLlmFailure(error) }
      }
    } finally {
      this.session.append('turn/end', { turn, reason })
    }

    return { reason, finalMessage, steps }
  }

  async #runStep(turn: number, step: number, signal: AbortSignal): Promise<StepOutcome> {
    const request = this.#buildRequest(signal)
    const assembler = new StreamAssembler()

    try {
      for await (const chunk of this.#model.stream(request)) {
        signal.throwIfAborted()
        assembler.push(chunk)
      }
      signal.throwIfAborted()
    } catch (error) {
      if (signal.aborted) {
        this.#settleInterrupted(assembler, turn, step)
      } else {
        this.session.append('assistant/attempt', {
          turn,
          step,
          failure: toLlmFailure(error),
        })
      }
      throw error
    }

    const finish = assembler.finished
    if (finish?.reason.kind === 'error' || finish?.reason.kind === 'aborted') {
      const failure = finish.reason.failure
      this.session.append('assistant/attempt', { turn, step, failure })
      throw new LlmError(failure)
    }

    const content = assembler.blocks()
    const message = createMessage({ role: 'assistant', content })
    this.session.append('assistant/message', {
      message,
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    }, { surfaceOp: 'append' })

    if (finish?.reason.kind === 'max-tokens') {
      return { message, reason: { kind: 'max-tokens' } }
    }

    const toolCalls = message.content.filter(isToolCall)
    if (toolCalls.length > 0) {
      return { message, toolCalls: [...toolCalls] }
    }

    return { message, reason: { kind: 'completed' } }
  }

  #settleInterrupted(assembler: StreamAssembler, turn: number, step: number): void {
    const partial = assembler.partialBlocks()
    if (partial.length > 0) {
      const message = createMessage({ role: 'assistant', content: partial })
      this.session.append('assistant/message', {
        message,
        interrupted: true,
        ...assembler.usage === undefined ? {} : { usage: assembler.usage },
      }, { surfaceOp: 'append' })
      return
    }
    this.session.append('assistant/attempt', {
      turn,
      step,
      failure: { message: 'model stream aborted before producing content', code: 'ABORTED' },
    })
  }

  /**
   * 每次请求都从日志派生历史。
   * header 只在首次/变化时写完整快照；request/context 只在路由变化时写。
   */
  #buildRequest(signal: AbortSignal): ChatRequest {
    const tools = this.#tools.schemas()
    const header: EpochHeader = {
      config: {
        provider: this.#model.provider,
        model: this.#model.model,
        ...this.#maxTokens === undefined ? {} : { maxTokens: this.#maxTokens },
      },
      tools,
    }
    const headerKey = JSON.stringify(header)
    if (headerKey !== this.#lastHeader) {
      this.session.append('request/header', {
        header,
        reason: this.#lastHeader === undefined ? 'initial' : 'change',
      })
      this.#lastHeader = headerKey
    }

    const context: RequestContext = {
      provider: this.#model.provider,
      model: this.#model.model,
    }
    const contextKey = JSON.stringify(context)
    if (contextKey !== this.#lastContext) {
      this.session.append('request/context', context)
      this.#lastContext = contextKey
    }

    return Object.freeze({
      sessionId: this.session.id,
      provider: this.#model.provider,
      model: this.#model.model,
      messages: Object.freeze(this.session.deriveMessages()),
      tools: Object.freeze(tools),
      signal,
    })
  }
}

function cancelReason(signal: AbortSignal): 'user' | 'parent' | 'hook' | 'disposed' {
  const kind = (signal.reason as { kind?: unknown } | undefined)?.kind
  return kind === 'parent' || kind === 'hook' || kind === 'disposed' ? kind : 'user'
}
