/**
 * s07 沿用 s06 的单次工具调用流水线：
 *
 *   pre-execute waterfall
 *     → 单调 guard
 *     → approval（ask）
 *     → execute wrapper（超时/重试/指标）
 *     → 工具体
 *     → post-execute waterfall
 *     → result observer
 *
 * 真实实现见 `packages/core/tools/src/pipeline.ts`；本课保留
 * allow/deny/ask/cancel、guard、around wrapper、accept/block 和 result 观察。
 */

import type {
  ContentBlock,
  JsonValue,
  Message,
  ToolCallBlock,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from './types.ts'
import { assertJsonValue } from './types.ts'

export interface ToolExecution {
  callId: string
  name: string
  arguments: string
  args: unknown
  tool: ToolDefinition
  signal: AbortSignal
  scope?: string
}

export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'cancel'; reason?: string }
  | { kind: 'ask'; reason?: string }

export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: JsonValue; additionalContexts?: Message[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: Message[] }

export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined

export interface ApprovalRequest {
  toolName: string
  args: unknown
  reason?: string
  signal: AbortSignal
}

export interface ApprovalService {
  /** 一次性授权；不是 allowed-once 一律拒绝（fail closed）。 */
  request(request: ApprovalRequest): Promise<'allowed-once' | 'denied' | 'unavailable'>
}

export interface PreListener {
  (execution: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
}

export interface ExecuteWrapper {
  (execution: ToolExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
}

export interface PostListener {
  (
    execution: ToolExecution,
    result: ToolExecutionResult,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision>
}

export interface ResultObserver {
  (execution: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void
}

export type ToolExecutionResult =
  | {
    isError: false
    value: JsonValue
    content: ContentBlock[]
    meta?: JsonValue
    additionalContexts?: Message[]
    concludesTurn?: true
  }
  | {
    isError: true
    error: { message: string; code: string }
    content: ContentBlock[]
    meta?: JsonValue
    additionalContexts?: Message[]
  }

export interface ToolPipelineOptions {
  approval?: ApprovalService
}

function errorContent(text: string): ContentBlock[] {
  return [{ type: 'text', text: `Error: ${text}` }]
}

export class ToolPipeline {
  #pre: PreListener[] = []
  #around: ExecuteWrapper[] = []
  #post: PostListener[] = []
  #guards: ToolGuard[] = []
  #observers: ResultObserver[] = []
  #approval: ApprovalService | undefined

  constructor(options: ToolPipelineOptions = {}) {
    this.#approval = options.approval
  }

  usePre(listener: PreListener): () => void {
    this.#pre.push(listener)
    return () => {
      const index = this.#pre.indexOf(listener)
      if (index >= 0) this.#pre.splice(index, 1)
    }
  }

  useExecute(wrapper: ExecuteWrapper): () => void {
    this.#around.push(wrapper)
    return () => {
      const index = this.#around.indexOf(wrapper)
      if (index >= 0) this.#around.splice(index, 1)
    }
  }

  usePost(listener: PostListener): () => void {
    this.#post.push(listener)
    return () => {
      const index = this.#post.indexOf(listener)
      if (index >= 0) this.#post.splice(index, 1)
    }
  }

  /** 单调守卫：只能返回拒绝原因，不能把 deny 翻回 allow。 */
  guard(guard: ToolGuard): () => void {
    this.#guards.push(guard)
    return () => {
      const index = this.#guards.indexOf(guard)
      if (index >= 0) this.#guards.splice(index, 1)
    }
  }

  onResult(observer: ResultObserver): () => void {
    this.#observers.push(observer)
    return () => {
      const index = this.#observers.indexOf(observer)
      if (index >= 0) this.#observers.splice(index, 1)
    }
  }

  async run(tool: ToolDefinition, call: ToolCallBlock, ctx: ToolContext): Promise<ToolResult> {
    let args: unknown
    try {
      args = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments)
    } catch {
      return { content: errorContent(`invalid JSON arguments for tool "${call.name}"`), isError: true }
    }

    const argumentErrors = tool.parameterValidator?.(args) ?? []
    if (argumentErrors.length > 0) {
      return { content: errorContent(`invalid arguments for tool "${call.name}": ${argumentErrors.join('; ')}`), isError: true }
    }

    const exec: ToolExecution = {
      callId: call.id,
      name: call.name,
      arguments: call.arguments,
      args,
      tool,
      signal: ctx.signal,
      ...ctx.scope === undefined ? {} : { scope: ctx.scope },
    }

    let decision = await this.#runPre(exec)
    if (decision.kind === 'ask') decision = await this.#approve(exec, decision)
    if (decision.kind !== 'allow') {
      return this.#finalizeDenied(exec, decision)
    }

    for (const guard of this.#guards) {
      const reason = guard(exec)
      if (reason !== undefined) return this.#finalizeDenied(exec, { kind: 'deny', reason })
    }

    const callCtx: ToolContext = { ...ctx, callId: exec.callId }
    let result: ToolExecutionResult
    try {
      result = await this.#runExecute(exec, () => this.#invoke(exec, callCtx))
    } catch (error) {
      if (exec.signal.aborted) throw exec.signal.reason
      result = {
        isError: true,
        error: { message: error instanceof Error ? error.message : String(error), code: 'TOOL_ERROR' },
        content: errorContent(error instanceof Error ? error.message : String(error)),
      }
    }

    const post = await this.#runPost(exec, result)
    if (post.kind === 'block') {
      result = {
        isError: true,
        error: { message: 'tool result blocked by post-execute policy', code: 'BLOCKED_BY_POLICY' },
        content: post.feedback.length > 0 ? post.feedback : errorContent('blocked by policy'),
        ...post.additionalContexts === undefined ? {} : { additionalContexts: post.additionalContexts },
      }
    } else {
      result = {
        ...result,
        ...post.content === undefined ? {} : { content: post.content },
        ...post.value === undefined || result.isError ? {} : { value: post.value },
        ...post.additionalContexts === undefined
          ? {}
          : { additionalContexts: [...result.additionalContexts ?? [], ...post.additionalContexts] },
      }
    }

    for (const observer of this.#observers) {
      try {
        observer(exec, result)
      } catch {
        // 观察者失败不能改变已提交的结果。
      }
    }

    return result.isError
      ? {
        content: result.content,
        isError: true,
        ...result.meta === undefined ? {} : { meta: result.meta },
        ...result.additionalContexts === undefined ? {} : { additionalContexts: result.additionalContexts },
      }
      : {
        content: result.content,
        isError: false,
        ...result.meta === undefined ? {} : { meta: result.meta },
        ...result.additionalContexts === undefined ? {} : { additionalContexts: result.additionalContexts },
        ...result.concludesTurn === true ? { concludesTurn: true as const } : {},
      }
  }

  async #runPre(exec: ToolExecution, index = 0): Promise<PreToolDecision> {
    const listener = this.#pre[index]
    if (listener === undefined) return { kind: 'allow' }
    return listener(exec, () => this.#runPre(exec, index + 1))
  }

  async #approve(exec: ToolExecution, decision: Extract<PreToolDecision, { kind: 'ask' }>): Promise<PreToolDecision> {
    if (this.#approval === undefined) {
      return { kind: 'deny', reason: 'approval unavailable' }
    }
    const outcome = await this.#approval.request({
      toolName: exec.name,
      args: exec.args,
      ...decision.reason === undefined ? {} : { reason: decision.reason },
      signal: exec.signal,
    })
    return outcome === 'allowed-once'
      ? { kind: 'allow' }
      : { kind: 'deny', reason: `approval ${outcome}` }
  }

  async #runExecute(exec: ToolExecution, dispatch: () => Promise<ToolExecutionResult>, index = 0): Promise<ToolExecutionResult> {
    const wrapper = this.#around[index]
    if (wrapper === undefined) return dispatch()
    return wrapper(exec, () => this.#runExecute(exec, dispatch, index + 1))
  }

  async #runPost(exec: ToolExecution, result: ToolExecutionResult, index = 0): Promise<PostToolDecision> {
    const listener = this.#post[index]
    if (listener === undefined) return { kind: 'accept' }
    return listener(exec, result, () => this.#runPost(exec, result, index + 1))
  }

  async #finalizeDenied(exec: ToolExecution, decision: PreToolDecision): Promise<ToolResult> {
    const reason = decision.kind === 'deny'
      ? decision.reason
      : decision.kind === 'cancel'
        ? decision.reason ?? 'canceled'
        : 'denied by policy'
    const result: ToolExecutionResult = {
      isError: true,
      error: {
        message: reason,
        code: decision.kind === 'cancel' ? 'ABORTED' : 'DENIED',
      },
      content: errorContent(reason),
    }
    const post = await this.#runPost(exec, result)
    if (post.kind === 'accept' && post.content !== undefined) {
      return { content: post.content, isError: true }
    }
    return { content: result.content, isError: true }
  }

  async #invoke(exec: ToolExecution, ctx: ToolContext): Promise<ToolExecutionResult> {
    const timeout = exec.tool.timeoutMs === undefined ? undefined : AbortSignal.timeout(exec.tool.timeoutMs)
    const signal = timeout === undefined ? exec.signal : AbortSignal.any([exec.signal, timeout])
    const deferred: Message[] = []
    let concludesTurn = false
    const runCtx: ToolContext = {
      ...ctx,
      signal,
      deferContext: message => deferred.push(message),
      concludeTurn: () => { concludesTurn = true },
    }

    let value: unknown
    try {
      value = await exec.tool.execute(exec.args, runCtx)
    } catch (error) {
      if (timeout?.aborted === true && !exec.signal.aborted) {
        return {
          isError: true,
          error: { message: `tool "${exec.name}" timed out after ${exec.tool.timeoutMs}ms`, code: 'TIMEOUT' },
          content: errorContent(`tool "${exec.name}" timed out`),
        }
      }
      if (exec.signal.aborted) throw exec.signal.reason
      return {
        isError: true,
        error: { message: error instanceof Error ? error.message : String(error), code: 'TOOL_ERROR' },
        content: errorContent(error instanceof Error ? error.message : String(error)),
      }
    }

    if (signal.aborted) throw signal.reason
    try {
      assertJsonValue(value, `tool "${exec.name}" output`)
    } catch (error) {
      return {
        isError: true,
        error: { message: error instanceof Error ? error.message : String(error), code: 'INVALID_TOOL_OUTPUT' },
        content: errorContent(`tool "${exec.name}" returned non-JSON value`),
      }
    }

    const outputErrors = exec.tool.outputValidator?.(value as JsonValue) ?? []
    if (outputErrors.length > 0) {
      return {
        isError: true,
        error: { message: outputErrors.join('; '), code: 'INVALID_TOOL_OUTPUT' },
        content: errorContent(`tool "${exec.name}" returned invalid output: ${outputErrors.join('; ')}`),
      }
    }

    let content: ContentBlock[]
    try {
      content = exec.tool.output.render(exec.args, value as JsonValue)
    } catch (error) {
      return {
        isError: true,
        error: { message: error instanceof Error ? error.message : String(error), code: 'RENDER_FAILED' },
        content: errorContent(`tool "${exec.name}" render failed`),
      }
    }

    let meta: JsonValue | undefined
    if (exec.tool.output.presentationMeta !== undefined) {
      try {
        meta = exec.tool.output.presentationMeta(exec.args, value as JsonValue)
        assertJsonValue(meta, `tool "${exec.name}" presentation meta`)
      } catch (error) {
        return {
          isError: true,
          error: { message: error instanceof Error ? error.message : String(error), code: 'PRESENTATION_FAILED' },
          content: errorContent(`tool "${exec.name}" presentation meta failed`),
        }
      }
    }

    return {
      isError: false,
      value: value as JsonValue,
      content: content.length > 0 ? content : [{ type: 'text', text: '(no output)' }],
      ...meta === undefined ? {} : { meta },
      ...deferred.length === 0 ? {} : { additionalContexts: deferred },
      ...concludesTurn ? { concludesTurn: true as const } : {},
    }
  }
}
