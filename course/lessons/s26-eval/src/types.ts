/** s26 的类型：模型 chunk、归一化失败、run 结果与快照。 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

export interface ToolCall {
  id: string
  name: string
  /** 已解析的参数；解析失败时由 agent 转成 tool-error。 */
  arguments: JsonValue
}

export interface ToolSpec {
  name: string
  description: string
  parameters: JsonObject
}

export interface Tool {
  name: string
  description: string
  parameters: JsonObject
  run(args: JsonValue, signal?: AbortSignal): JsonValue | Promise<JsonValue>
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

export interface ModelRequest {
  messages: ChatMessage[]
  tools: ToolSpec[]
}

export type FailureKind =
  | 'rate-limit'
  | 'timeout'
  | 'disconnect'
  | 'tool-error'
  | 'model-error'

/** 公共边界上的唯一失败形状；上层只判断 kind。 */
export interface Failure {
  kind: FailureKind
  message: string
  code?: string
  status?: number
  retryable?: boolean
}

export type ModelChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'finish'; reason: 'stop' | 'tool-calls' | 'error'; failure?: Failure }

export interface Model {
  readonly provider: string
  readonly model: string
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelChunk>
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface RunEvent {
  seq: number
  at: number
  type: string
  data: JsonObject
}

export type RunOutcome =
  | { kind: 'ok' }
  | { kind: 'error'; failure: Failure }

export interface ToolCallRecord {
  id: string
  name: string
  args: JsonValue
  ok: boolean
}

export interface RunResult {
  events: RunEvent[]
  messages: ChatMessage[]
  outcome: RunOutcome
  /** 包含终止失败和可恢复的工具错误。 */
  failures: Failure[]
  usage: Usage
  steps: number
  toolCalls: ToolCallRecord[]
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 })

/** 逻辑时钟：保证同一 scenario 的重复运行时间线一致。 */
export function createClock(start = 0, step = 10): () => number {
  let time = start
  return () => {
    const now = time
    time += step
    return now
  }
}
