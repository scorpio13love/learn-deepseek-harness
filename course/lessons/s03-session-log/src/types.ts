/**
 * s02 的词汇表：在 s01 的基础上补上「完整事件信封 + surface」。
 *
 * 与 s01 的差别：
 * - 每个事件有可选的 `ignorable`；
 * - surface 事件必须带 `surfaceOp`（append / replace）；
 * - replace 必须用 `sourceEventSeqs` 引用被它遮蔽的旧节点；
 * - 增加 `developer/message`、`request/context`、`session/end-seed`。
 *
 * 真实源码对照：
 * - packages/core/session/src/types.ts
 * - packages/core/session/src/surface.ts
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
}

export interface ToolContext {
  signal: AbortSignal
  callId: string
  sessionId: string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonObject
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult> | ToolResult
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
    usage?: TokenUsage
    interrupted?: true
  }
  'assistant/attempt': {
    turn: number
    step: number
    failure: LlmFailure
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
