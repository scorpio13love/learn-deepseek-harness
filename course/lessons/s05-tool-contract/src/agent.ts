/**
 * s04 的 driver：在 s03 的流式结算上接入每步工具集。
 *
 * s04 新增：
 * - 每个 step 调用 `tools.resolve()`，得到 `ResolvedToolSet`；
 * - prompt 的 `tools` 与执行用的定义来自同一份 ToolSet；
 * - `toolScope` 传给 resolve/execute，支持 scoped 工具；
 * - 步骤结束 `toolSet.dispose()`，未开始的新调用不再可见。
 *
 * s03 已有：AssistantStreamAttempt、持久 stream、attempt、取消前缀、live 帧。
 * 仍不包含 pre-step、inbox、持久化、并发/审批（s07/s09/s05）。
 */

import type {
  AssistantStreamFrame,
  ChatRequest,
  EpochHeader,
  LlmFailure,
  Message,
  Model,
  RequestContext,
  ResolvedToolSet,
  ToolCallBlock,
  ToolSchema,
  TurnEndReason,
} from './types.ts'
import {
  isToolCall,
  toLlmFailure,
} from './types.ts'
import { createMessage, createTextMessage, Session } from './session.ts'
import { AssistantStreamAttempt } from './stream.ts'
import type { ToolRegistry } from './tools.ts'

export interface AgentOptions {
  /** 教学守卫：防止模型无限调用工具。真实 DSH 没有这个上限。 */
  maxSteps?: number
  /** 写入 request/header 的每请求输出上限。 */
  maxTokens?: number
  /** 进程内 assistant 流帧；持久结算仍以 session event 为准。 */
  onAssistantStream?: (frame: AssistantStreamFrame) => void
  /** 本 agent 的工具作用域；scoped 注册按它解析。 */
  toolScope?: string
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
  #onAssistantStream: ((frame: AssistantStreamFrame) => void) | undefined
  #toolScope: string | undefined
  #turn = 0
  #attempt = 0
  #lastHeader: string | undefined
  #lastContext: string | undefined

  constructor(session: Session, model: Model, tools: ToolRegistry, options: AgentOptions = {}) {
    this.session = session
    this.#model = model
    this.#tools = tools
    this.#maxSteps = options.maxSteps ?? 8
    this.#maxTokens = options.maxTokens
    this.#onAssistantStream = options.onAssistantStream
    this.#toolScope = options.toolScope
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

          // 每个步骤解析一次工具集：prompt 与执行看到同一份快照。
          const toolSet = await this.#tools.resolve({
            signal,
            ...this.#toolScope === undefined ? {} : { scope: this.#toolScope },
          })
          try {
            const outcome = await this.#runStep(turn, step, signal, toolSet)
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
                ...this.#toolScope === undefined ? {} : { scope: this.#toolScope },
              }, toolSet)

              signal.throwIfAborted()
              const message = createMessage({
                role: 'tool',
                toolCallId: call.id,
                isError: result.isError,
                content: result.content,
              })
              this.session.append('tool/result', {
                turn,
                step,
                message,
                ...result.meta === undefined ? {} : { meta: result.meta },
              }, { surfaceOp: 'append' })
            }

            if (step === this.#maxSteps) {
              reason = { kind: 'max-steps' }
              break
            }
          } finally {
            toolSet.dispose()
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

  async #runStep(
    turn: number,
    step: number,
    signal: AbortSignal,
    toolSet: ResolvedToolSet,
  ): Promise<StepOutcome> {
    const request = this.#buildRequest(signal, toolSet.schemas())
    const attempt = new AssistantStreamAttempt({
      attemptId: `${this.session.id}:${++this.#attempt}`,
      turn,
      step,
      ...this.#onAssistantStream === undefined ? {} : { onFrame: this.#onAssistantStream },
    })
    attempt.start()

    try {
      for await (const chunk of this.#model.stream(request)) {
        signal.throwIfAborted()
        attempt.push(chunk)
      }
      signal.throwIfAborted()
    } catch (error) {
      try {
        if (signal.aborted) {
          this.#settleInterrupted(attempt)
        } else {
          this.#appendAttempt(attempt, toLlmFailure(error))
        }
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          'model stream failed and its durable settlement was rejected',
          { cause: error },
        )
      }
      throw error
    }

    const finish = attempt.finish
    if (finish?.reason.kind === 'error' || finish?.reason.kind === 'aborted') {
      const failure = finish.reason.failure
      this.#appendAttempt(attempt, failure)
      throw new LlmError(failure)
    }

    const message = createMessage({ role: 'assistant', content: attempt.blocks })
    try {
      this.session.append('assistant/message', {
        message,
        stream: attempt.stream,
        ...attempt.usage === undefined ? {} : { usage: attempt.usage },
      }, { surfaceOp: 'append' })
    } catch (error) {
      attempt.settle('abandoned')
      throw error
    }
    attempt.settle('committed', 'assistant/message')

    if (finish?.reason.kind === 'max-tokens') {
      return { message, reason: { kind: 'max-tokens' } }
    }

    const toolCalls = message.content.filter(isToolCall)
    if (toolCalls.length > 0) {
      return { message, toolCalls: [...toolCalls] }
    }

    return { message, reason: { kind: 'completed' } }
  }

  /** 失败 attempt 的持久结算；stream 保留，但不进入模型历史。 */
  #appendAttempt(attempt: AssistantStreamAttempt, failure: LlmFailure): void {
    try {
      this.session.append('assistant/attempt', {
        turn: attempt.turn,
        step: attempt.step,
        failure,
        stream: attempt.stream,
      })
    } catch (error) {
      attempt.settle('abandoned')
      throw error
    }
    attempt.settle('committed', 'assistant/attempt')
  }

  /** 取消时保留已交付的可见前缀；没有可见内容则只记录 attempt。 */
  #settleInterrupted(attempt: AssistantStreamAttempt): void {
    const partial = attempt.partialBlocks
    if (partial.length > 0) {
      const message = createMessage({ role: 'assistant', content: partial })
      try {
        this.session.append('assistant/message', {
          message,
          stream: attempt.stream,
          interrupted: true,
          ...attempt.usage === undefined ? {} : { usage: attempt.usage },
        }, { surfaceOp: 'append' })
      } catch (error) {
        attempt.settle('abandoned')
        throw error
      }
      attempt.settle('committed', 'assistant/message')
      return
    }
    this.#appendAttempt(attempt, {
      message: 'model stream aborted before producing content',
      code: 'ABORTED',
    })
  }

  /**
   * 每次请求都从日志派生历史。
   * header 只在首次/变化时写完整快照；request/context 只在路由变化时写。
   */
  #buildRequest(signal: AbortSignal, tools: ToolSchema[]): ChatRequest {
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
