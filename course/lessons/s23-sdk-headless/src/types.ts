/**
 * s17 · SDK / headless：沿用前序课程的实现（本课改动见 README）。
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

// ---------------------------------------------------------------------------
// 消息与内容块
// ---------------------------------------------------------------------------

export type ContentBlockType = 'text' | 'reasoning' | 'tool-call' | 'tool-addition' | 'tool-removal'

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/** 模型请求的一次工具调用。arguments 是原始 JSON 字符串，未解析。 */
export interface ToolCallBlock {
  type: 'tool-call'
  id: string
  name: string
  arguments: string
}

/** developer 消息里的「新增工具」增量，schema 由更早的 request/header 提供。 */
export interface ToolAdditionBlock {
  type: 'tool-addition'
  toolName: string
}

/** developer 消息里的「移除工具」增量。 */
export interface ToolRemovalBlock {
  type: 'tool-removal'
  toolName: string
}

export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ToolCallBlock
  | ToolAdditionBlock
  | ToolRemovalBlock

export type MessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool'

export interface Message {
  /** 稳定身份；跨重放/持久化保持不变。 */
  id: string
  role: MessageRole
  content: ContentBlock[]
  /** 仅 tool 角色：对应的工具调用 id。 */
  toolCallId?: string
  /** 仅 tool 角色：这次调用是否失败。 */
  isError?: boolean
  /** 仅 assistant：流被取消时保留已交付前缀。 */
  interrupted?: true
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export interface ToolSchema {
  name: string
  description: string
  parameters: JsonObject
}

export interface ToolResult {
  content: ContentBlock[]
  isError: boolean
  /** 工具自有的可回放展示数据；核心不解释它。 */
  meta?: JsonValue
  /** 工具/策略附带的下一请求上下文，在 tool/result 之后注入。 */
  additionalContexts?: Message[]
  /** 成功结果主动结束当前轮次。 */
  concludesTurn?: true
}

export interface ToolContext {
  signal: AbortSignal
  callId: string
  sessionId: string
  /** 工具作用域；scoped 注册通过它解析。 */
  scope?: string
  /** 工具可延迟一条上下文到本次结果之后。 */
  deferContext?(message: Message): void
  /** 工具可标记本次成功结果结束轮次。 */
  concludeTurn?(): void
}

/** 工具输出的规范契约：schema + 渲染 + 可选的展示投影。 */
export interface ToolOutputDefinition {
  /** 规范值必须满足的 JSON Schema。 */
  schema: JsonObject
  render(args: unknown, value: JsonValue): ContentBlock[]
  presentationMeta?(args: unknown, value: JsonValue): JsonValue
}

export interface ToolDefinition extends ToolSchema {
  output: ToolOutputDefinition
  /** 只返回规范 JSON 值；渲染由 output.render 负责。 */
  execute(args: unknown, ctx: ToolContext): Promise<unknown> | unknown
  /** 纯同步分类器；s05 用于并发调度。 */
  isConcurrencySafe?(args: unknown): boolean
  /** 协作式超时；到点后通过 signal 取消工具。 */
  timeoutMs?: number
  /** 由 defineTool 编译出的参数校验器；原始 JSON Schema 工具可省略。 */
  parameterValidator?(args: unknown): string[]
  /** 由 defineTool 编译出的规范值校验器；原始 JSON Schema 工具可省略。 */
  outputValidator?(value: JsonValue): string[]
}

/** 一个步骤级解析后的工具集；dispose 后不可再开始新调用。 */
export interface ResolvedToolSet {
  readonly names: readonly string[]
  get(name: string): ToolDefinition | undefined
  schemas(): ToolSchema[]
  dispose(): void
}

/** 条件工具求值上下文。 */
export interface ToolActivationContext {
  signal: AbortSignal
  scope?: string
}

/** 注册选项：作用域与步骤级条件。 */
export interface ToolRegistrationOptions {
  /** scoped 工具遮蔽同名全局工具；只用在该作用域可见。 */
  scope?: string
  /** 每个步骤求值一次；false 排除，抛错则步骤准备失败。 */
  when?: (context: ToolActivationContext) => boolean | Promise<boolean>
}

/** 对全局工具的 allow/deny 掩码；多个掩码取交集。 */
export interface ToolRestriction {
  allow?: readonly string[]
  deny?: readonly string[]
}

// ---------------------------------------------------------------------------
// 模型请求与流
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface LlmFailure {
  message: string
  code: string
  status?: number
}

export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure }

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }

/** Why an active agent was cancelled. */
export type AgentCancelCause =
  | { kind: 'user' }
  | { kind: 'parent' }
  | { kind: 'disposed' }
  | { kind: 'hook'; reason: string }

export interface CancelOptions {
  /** 保留 pending 队列表项，只中止当前活动。 */
  keepInbox?: boolean
}

/** Immutable storage metadata, outside the event log. */
export interface SessionHeader {
  version: 1
  id: string
  createdAt: number
  cwd?: string
  parentSession?: string
  isSeeded?: boolean
}

/** Provider-neutral model capabilities resolved by prepareCall. */
export interface ModelCapabilities {
  contextWindow?: number
  defaultMaxTokens?: number
  /** 'in-history' routes read the latest system message anywhere in the history. */
  systemPromptUpdate?: 'in-history'
  /** How the route accepts mid-conversation tool declaration changes. */
  toolUpdate?: 'in-history' | 'addition-only'
}

export interface RetryPolicy {
  maxRetries: number
  retryableCodes: readonly string[]
}

/** One prepared call: config + capabilities + retry policy + bound stream. */
export interface PreparedCall {
  readonly config: { provider: string; model: string; maxTokens?: number }
  readonly capabilities: ModelCapabilities
  readonly retryPolicy: RetryPolicy
  stream(request: ChatRequest): AsyncIterable<StreamChunk>
}

export interface ChatRequest {
  sessionId: string
  provider: string
  model: string
  messages: readonly Message[]
  tools: readonly ToolSchema[]
  signal: AbortSignal
}

export interface Model {
  readonly provider: string
  readonly model: string
  stream(request: ChatRequest): AsyncIterable<StreamChunk>
  /** Optional provider seam; models without it use the legacy direct path. */
  prepare?(options?: { signal?: AbortSignal }): Promise<PreparedCall>
}

/** 一个 chunk 及其原始时间戳；s03 的持久 stream 记录。 */
export interface TimedStreamChunk {
  time: number
  chunk: StreamChunk
}

/** 进程内的 assistant 流生命周期；真实 DSH 的 `agent/assistant-stream` 同形。 */
export type AssistantStreamFrame =
  | { type: 'start'; attemptId: string; turn: number; step: number }
  | { type: 'chunk'; attemptId: string; index: number; time: number; chunk: StreamChunk }
  | {
    type: 'end'
    attemptId: string
    outcome: 'committed' | 'abandoned'
    eventType?: 'assistant/message' | 'assistant/attempt'
  }

// ---------------------------------------------------------------------------
// 会话事件信封
// ---------------------------------------------------------------------------

export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'aborted'; reason: 'user' | 'parent' | 'hook' | 'disposed' }
  | { kind: 'error'; failure: LlmFailure }
  | { kind: 'max-tokens' }
  | { kind: 'max-steps' }
  | { kind: 'interrupted' }
  | { kind: 'forked' }

/** 请求信封：call config + 工具声明。它是 log-only，不进模型历史。 */
export interface EpochHeader {
  config: {
    provider: string
    model: string
    maxTokens?: number
  }
  tools: ToolSchema[]
}

/** 路由元数据；只在变化时记录，不参与请求重建。 */
export interface RequestContext {
  provider: string
  model: string
  contextWindow?: number
  systemPromptUpdate?: 'in-history'
}

export type RequestHeaderReason = 'initial' | 'resume' | 'change' | 'series'

export interface SessionEventDataMap {
  'turn/start': { turn: number }
  'turn/end': { turn: number; reason: TurnEndReason }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }
  'system/message': { message: Message }
  'developer/message': { message: Message }
  'user/message': { message: Message }
  'assistant/message': {
    message: Message
    /** 产生这条消息的精确 chunk 记录，重放时据此还原。 */
    stream: TimedStreamChunk[]
    usage?: TokenUsage
    interrupted?: true
  }
  'assistant/attempt': {
    turn: number
    step: number
    failure: LlmFailure
    /** 失败/取消/重试的 attempt 也保留完整 stream，但不进模型历史。 */
    stream: TimedStreamChunk[]
  }
  'tool/call': {
    turn: number
    step: number
    callId: string
    name: string
    arguments: string
  }
  'tool/result': {
    turn: number
    step: number
    message: Message
    meta?: JsonValue
  }
  'request/header': {
    header: EpochHeader
    reason: RequestHeaderReason
  }
  'request/context': RequestContext
  /** fork / restore 的继承边界；s09 会深入。 */
  'session/end-seed': { inherited?: true }
}

export type SessionEventType = keyof SessionEventDataMap

/** 进入模型历史的五种事件；只有它们允许携带 surface 元数据。 */
export type SurfaceEventType =
  | 'system/message'
  | 'developer/message'
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'

export type SurfaceOp =
  | 'append'
  | { op: 'replace'; startSeq: number; endSeq: number }

export interface SurfaceIntent {
  surfaceOp: SurfaceOp
  /** replace 时必须覆盖所有被遮蔽的 surface 节点。 */
  sourceEventSeqs?: number[]
}

export interface AppendIntent extends Partial<SurfaceIntent> {
  /** 未知类型的阅读器可安全跳过；默认不可忽略。 */
  ignorable?: true
}

export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    seq: number
    time: number
    data: SessionEventDataMap[K]
    ignorable?: true
  } & (K extends SurfaceEventType
    ? { surfaceOp: SurfaceOp; sourceEventSeqs?: number[] }
    : { surfaceOp?: never; sourceEventSeqs?: never })
}[T]

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set<SurfaceEventType>([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

export function isSurfaceEventType(type: SessionEventType): type is SurfaceEventType {
  return SURFACE_EVENT_TYPES.has(type)
}

export function isToolCall(block: ContentBlock): block is ToolCallBlock {
  return block.type === 'tool-call'
}

export function textOf(message: Message): string {
  return message.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

export function toLlmFailure(error: unknown): LlmFailure {
  if (error instanceof Error) {
    const candidate = (error as Error & { code?: unknown }).code
    return { message: error.message, code: typeof candidate === 'string' ? candidate : 'UNKNOWN' }
  }
  return { message: String(error), code: 'UNKNOWN' }
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

/**
 * 无损 JSON 校验：事件数据必须能写进 JSONL 并在另一端原样读回。
 * 拒绝 undefined、函数、symbol、bigint、NaN/Infinity、Date、Map、循环引用。
 */
export function assertJsonValue(value: unknown, path = '$'): asserts value is JsonValue {
  const ancestors = new WeakSet<object>()

  function visit(current: unknown, at: string): void {
    if (current === null) return
    switch (typeof current) {
      case 'string':
      case 'boolean':
        return
      case 'number':
        if (!Number.isFinite(current)) throw new TypeError(`${at} is not a finite number`)
        return
      case 'object':
        break
      default:
        throw new TypeError(`${at} is not JSON (${typeof current})`)
    }

    const object = current as object
    if (ancestors.has(object)) throw new TypeError(`${at} contains a cycle`)
    ancestors.add(object)
    try {
      if (Array.isArray(object)) {
        object.forEach((item, index) => visit(item, `${at}[${index}]`))
        return
      }
      const prototype = Object.getPrototypeOf(object)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${at} is not a plain object`)
      }
      for (const [key, item] of Object.entries(object)) {
        visit(item, `${at}.${key}`)
      }
    } finally {
      ancestors.delete(object)
    }
  }

  visit(value, path)
}
