/**
 * s01 的最小词汇表：消息、流、工具、会话事件。
 *
 * 这些类型刻意贴近真实 DSH 的 `dsh-llm` / `dsh-session` / `dsh-tools`：
 * - 模型输出是 `ContentBlock[]`，不是字符串；
 * - 流是 `StreamChunk`，块用 index 关联交错的 delta；
 * - 会话是 `SessionEvent[]`，消息历史由日志派生；
 * - 工具只返回「规范结果」，不直接拼 UI 文本。
 *
 * 真实源码对照：
 * - packages/llm/llm/src/types.ts
 * - packages/llm/llm/src/message.ts
 * - packages/core/session/src/types.ts
 * - packages/core/tools/src/contracts.ts
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

export type ContentBlockType = 'text' | 'reasoning' | 'tool-call'

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

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

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

/** 模型可见的工具声明。parameters 是 JSON Schema 对象。 */
export interface ToolSchema {
  name: string
  description: string
  parameters: JsonObject
}

/** 工具执行后返回给 loop 的结果。 */
export interface ToolResult {
  content: ContentBlock[]
  isError: boolean
}

export interface ToolContext {
  /** 取消信号；工具必须观察它。 */
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

/**
 * 原始流协议。block-start 开启一个块，delta 按 index 追加，
 * block-end 携带组装好的完整块；usage 在 finish 之前；finish 终止流。
 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }

/** 一次完整的模型请求。loop 从会话日志派生 messages。 */
export interface ChatRequest {
  sessionId: string
  provider: string
  model: string
  messages: readonly Message[]
  tools: readonly ToolSchema[]
  signal: AbortSignal
}

/** 模型适配器的最小契约。s08 会扩展成完整的 provider seam。 */
export interface Model {
  readonly provider: string
  readonly model: string
  stream(request: ChatRequest): AsyncIterable<StreamChunk>
}

// ---------------------------------------------------------------------------
// 会话事件
// ---------------------------------------------------------------------------

export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'aborted'; reason: 'user' | 'parent' | 'hook' | 'disposed' }
  | { kind: 'error'; failure: LlmFailure }
  | { kind: 'max-tokens' }
  /** s01 的教学守卫：真实 DSH 不靠 loop 的步数上限结束轮次。 */
  | { kind: 'max-steps' }

export interface SessionEventDataMap {
  'turn/start': { turn: number }
  'turn/end': { turn: number; reason: TurnEndReason }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }
  'system/message': { message: Message }
  'user/message': { message: Message }
  'assistant/message': {
    message: Message
    usage?: TokenUsage
    interrupted?: true
  }
  /** s01 只记录失败事实；s03 会扩展成完整的 attempt 结算。 */
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
    provider: string
    model: string
    tools: string[]
  }
}

export type SessionEventType = keyof SessionEventDataMap

export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** 单调递增、连续。 */
    seq: number
    /** Unix epoch 毫秒。 */
    time: number
    data: SessionEventDataMap[K]
  }
}[T]

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

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
