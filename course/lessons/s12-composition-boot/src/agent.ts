/**
 * s12 · composition / boot：沿用前序课程的实现（本课改动见 README）。
 */

import type {
  AgentCancelCause,
  AssistantStreamFrame,
  CancelOptions,
  ChatRequest,
  EpochHeader,
  LlmFailure,
  Message,
  Model,
  PreparedCall,
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
import { Inbox } from './inbox.ts'
import type { InboxTarget } from './inbox.ts'
import type { PromptAssembly, SystemPrompt } from './prompt.ts'
import { renderContextMessage, renderPrompt } from './prompt.ts'
import { isRetryable, retryDelayMs, sleep } from './llm.ts'
import type { Compaction } from './compaction.ts'
import { isContextOverflow } from './compaction.ts'
import { recoverMissingToolResults } from './recovery.ts'
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
  /** 并发安全工具的上限；1 表示串行。 */
  maxParallelToolCalls?: number
  /** 可选的系统提示词注册表；没有时请求里没有 system 节点。 */
  prompt?: SystemPrompt
  /** 可选的上下文压缩器；在每步提示词准入前检查。 */
  compaction?: Compaction
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
  #maxParallelToolCalls: number
  #prompt: SystemPrompt | undefined
  #compaction: Compaction | undefined
  #inbox = new Inbox()
  #activity: Promise<void> | undefined
  #controller: AbortController | undefined
  #runSignal: AbortSignal | undefined
  #lastResult: RunResult | undefined
  #lastSystemSeq: number | undefined
  #lastPromptText: string | undefined
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
    this.#maxParallelToolCalls = options.maxParallelToolCalls ?? 10
    this.#prompt = options.prompt
    this.#compaction = options.compaction
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
  get status(): 'idle' | 'running' {
    return this.#activity === undefined ? 'idle' : 'running'
  }

  get lastResult(): RunResult | undefined {
    return this.#lastResult
  }

  /**
   * 运行一个 prompt 并等待整个 agent 回到 idle。
   * 队列中已有的输入会先于这个 prompt 被消费。
   */
  async run(prompt: string, options: RunOptions = {}): Promise<RunResult> {
    this.#runSignal = options.signal
    this.#inbox.append('next-turn', createTextMessage('user', prompt))
    this.#wake()
    await this.whenIdle()
    return this.#lastResult ?? { reason: { kind: 'completed' }, steps: 0 }
  }

  /** 排队一个 follow-up 并立即返回。 */
  followup(message: Message): void {
    this.send(message, 'next-turn', true)
  }

  /** 把输入排队到最近的下一个步骤边界。 */
  steer(message: Message): void {
    this.send(message, 'next-step', true)
  }

  /** 排队上下文但不唤醒 idle agent。 */
  inject(message: Message): void {
    this.send(message, 'next-step', false)
  }

  send(message: Message, target: InboxTarget, wakeup: boolean): void {
    this.#inbox.append(target, message)
    if (wakeup) this.#wake()
  }

  /** 取消当前活动；默认清空 pending 队列。 */
  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) this.#inbox.clear()
    this.#controller?.abort(cause)
  }

  /** 等待当前活动（可能跨多个排队轮次）结束。 */
  async whenIdle(): Promise<void> {
    while (this.#activity !== undefined) await this.#activity
  }

  start(prompt: string): void {
    this.followup(createTextMessage('user', prompt))
  }

  #wake(): void {
    if (this.#activity !== undefined) return
    const controller = new AbortController()
    this.#controller = controller
    const external = this.#runSignal
    const signal = external === undefined ? controller.signal : AbortSignal.any([external, controller.signal])
    let activity: Promise<void>
    activity = this.#drive(signal).finally(() => {
      if (this.#activity !== activity) return
      this.#activity = undefined
      this.#controller = undefined
      this.#runSignal = undefined
    })
    this.#activity = activity
  }

  async #drive(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const claimed = this.#inbox.claim('turn')
      if (claimed.length === 0) return
      this.#lastResult = await this.#runTurn(claimed, signal)
      if (signal.aborted || !this.#inbox.hasPending) return
    }
  }

  async #runTurn(claimed: readonly Message[], signal: AbortSignal): Promise<RunResult> {
    const turn = this.#turn + 1
    this.#turn = turn
    this.session.append('turn/start', { turn })

    let reason: TurnEndReason = { kind: 'completed' }
    let finalMessage: Message | undefined
    let steps = 0

    try {
      for (let step = 1; step <= this.#maxSteps; step += 1) {
        let hadCalls = false
        let concluded = false
        let stepReason: TurnEndReason | undefined
        steps = step
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })

        try {
          const toolSet = await this.#tools.resolve({
            signal,
            ...this.#toolScope === undefined ? {} : { scope: this.#toolScope },
          })
          try {
            const prepared = await this.#model.prepare?.({ signal })
            if (this.#compaction !== undefined) {
              await this.#compaction.beforeStep(
                this.session,
                this.#model,
                signal,
                prepared?.capabilities.contextWindow,
              )
            }
            const assembly = await this.#admitPrompt(toolSet, signal, prepared)
            if (step === 1) {
              for (const message of claimed) {
                this.session.append('user/message', { message }, { surfaceOp: 'append' })
              }
              this.#admitContext(assembly)
            }

            const outcome = await this.#runStep(turn, step, signal, toolSet, prepared)
            finalMessage = outcome.message
            const calls = outcome.toolCalls ?? []
            hadCalls = calls.length > 0
            stepReason = outcome.reason

            if (calls.length > 0) {
              for (const call of calls) {
                signal.throwIfAborted()
                this.session.append('tool/call', {
                  turn,
                  step,
                  callId: call.id,
                  name: call.name,
                  arguments: call.arguments,
                })
              }

              const batch = await this.#tools.executeBatch(calls, {
                signal,
                callId: calls[0]?.id ?? '',
                sessionId: this.session.id,
                ...this.#toolScope === undefined ? {} : { scope: this.#toolScope },
              }, toolSet, this.#maxParallelToolCalls)

              for (const [index, call] of calls.entries()) {
                const result = batch.results[index]
                if (result === undefined) continue
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
              for (const context of batch.additionalContexts) {
                this.session.append('user/message', { message: context }, { surfaceOp: 'append' })
              }
              if (batch.aborted) signal.throwIfAborted()
              concluded = batch.concluded
            }

          } finally {
            toolSet.dispose()
          }
        } catch (error) {
          recoverMissingToolResults(this.session, turn, step)
          throw error
        } finally {
          this.session.append('step/end', { turn, step })
        }

        // step/end 之后、下一步之前领取 steering / injected context。
        const steering = this.#inbox.claim('step')
        for (const message of steering) {
          this.session.append('user/message', { message }, { surfaceOp: 'append' })
        }

        if (concluded) {
          reason = { kind: 'completed' }
          break
        }
        if (!hadCalls && steering.length === 0) {
          reason = stepReason ?? { kind: 'completed' }
          break
        }
        if (step === this.#maxSteps) {
          reason = { kind: 'max-steps' }
          break
        }
      }
    } catch (error) {
      if (signal.aborted) {
        reason = { kind: 'aborted', reason: cancelCause(signal) }
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

  /** 组装提示词并把它准入为 surface node 0；变化时替换 head。 */
  async #admitPrompt(
    toolSet: ResolvedToolSet,
    signal: AbortSignal,
    prepared?: PreparedCall,
  ): Promise<PromptAssembly | undefined> {
    if (this.#prompt === undefined) return undefined
    const assembly = await this.#prompt.assemble({
      modelSelection: { provider: this.#model.provider, model: this.#model.model },
      toolSet,
      signal,
    })
    const text = renderPrompt(assembly)
    const message = createMessage({
      role: 'system',
      content: text.length === 0 ? [] : [{ type: 'text', text }],
    })

    if (this.#lastSystemSeq === undefined) {
      const event = this.session.append('system/message', { message }, { surfaceOp: 'append' })
      this.#lastSystemSeq = event.seq
      this.#lastPromptText = text
    } else if (text !== this.#lastPromptText) {
      if (prepared?.capabilities.systemPromptUpdate === 'in-history') {
        // 路由能读历史中任意位置的 system 节点：追加，保留缓存前缀。
        const event = this.session.append('system/message', { message }, { surfaceOp: 'append' })
        this.#lastSystemSeq = event.seq
        this.#lastPromptText = text
      } else {
        // 只读首个 system 的路由：替换 head，保持位置。
        const previous = this.#lastSystemSeq
        const event = this.session.append('system/message', { message }, {
          surfaceOp: { op: 'replace', startSeq: previous, endSeq: previous },
          sourceEventSeqs: [previous],
        })
        this.#lastSystemSeq = event.seq
        this.#lastPromptText = text
      }
    }
    return assembly
  }

  /** 运行时上下文作为 user-role 快照，跟在首次用户消息之后。 */
  #admitContext(assembly: PromptAssembly | undefined): void {
    if (assembly === undefined) return
    const message = renderContextMessage(assembly)
    if (message !== undefined) this.session.append('user/message', { message }, { surfaceOp: 'append' })
  }

  /** 在同一个 step 内按 retryPolicy 重试失败的模型调用。 */
  async #runStep(
    turn: number,
    step: number,
    signal: AbortSignal,
    toolSet: ResolvedToolSet,
    prepared?: PreparedCall,
  ): Promise<StepOutcome> {
    const policy = prepared?.retryPolicy ?? { maxRetries: 0, retryableCodes: [] as const }
    let overflowRetries = 0
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#runStepOnce(turn, step, signal, toolSet, prepared)
      } catch (error) {
        if (signal.aborted || !(error instanceof LlmError)) throw error
        if (this.#compaction !== undefined && isContextOverflow(error.failure) && overflowRetries < 1) {
          overflowRetries += 1
          const result = await this.#compaction.compact(this.session, this.#model, signal)
          if (result.compacted) continue
          throw error
        }
        if (attempt >= policy.maxRetries || !isRetryable(error.failure, policy)) throw error
        await sleep(retryDelayMs(attempt), signal)
      }
    }
  }

  async #runStepOnce(
    turn: number,
    step: number,
    signal: AbortSignal,
    toolSet: ResolvedToolSet,
    prepared?: PreparedCall,
  ): Promise<StepOutcome> {
    const request = this.#buildRequest(signal, toolSet.schemas(), prepared)
    const attempt = new AssistantStreamAttempt({
      attemptId: `${this.session.id}:${++this.#attempt}`,
      turn,
      step,
      ...this.#onAssistantStream === undefined ? {} : { onFrame: this.#onAssistantStream },
    })
    attempt.start()

    try {
      const stream = prepared?.stream(request) ?? this.#model.stream(request)
      for await (const chunk of stream) {
        signal.throwIfAborted()
        attempt.push(chunk)
      }
      signal.throwIfAborted()
    } catch (error) {
      const failure = toLlmFailure(error)
      try {
        if (signal.aborted) {
          this.#settleInterrupted(attempt)
        } else {
          this.#appendAttempt(attempt, failure)
        }
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          'model stream failed and its durable settlement was rejected',
          { cause: error },
        )
      }
      if (signal.aborted) throw error
      throw new LlmError(failure)
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
  #buildRequest(signal: AbortSignal, tools: ToolSchema[], prepared?: PreparedCall): ChatRequest {
    const provider = prepared?.config.provider ?? this.#model.provider
    const model = prepared?.config.model ?? this.#model.model
    const maxTokens = prepared?.config.maxTokens ?? this.#maxTokens
    const header: EpochHeader = {
      config: {
        provider,
        model,
        ...maxTokens === undefined ? {} : { maxTokens },
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
      provider,
      model,
      ...prepared?.capabilities.contextWindow === undefined
        ? {}
        : { contextWindow: prepared.capabilities.contextWindow },
      ...prepared?.capabilities.systemPromptUpdate === undefined
        ? {}
        : { systemPromptUpdate: prepared.capabilities.systemPromptUpdate },
    }
    const contextKey = JSON.stringify(context)
    if (contextKey !== this.#lastContext) {
      this.session.append('request/context', context)
      this.#lastContext = contextKey
    }

    return Object.freeze({
      sessionId: this.session.id,
      provider,
      model,
      messages: Object.freeze(this.session.deriveMessages()),
      tools: Object.freeze(tools),
      signal,
    })
  }
}

function cancelCause(signal: AbortSignal): 'user' | 'parent' | 'hook' | 'disposed' {
  const kind = (signal.reason as { kind?: unknown } | undefined)?.kind
  return kind === 'parent' || kind === 'hook' || kind === 'disposed' ? kind : 'user'
}
