/** s28 的公共类型：消息、工具、模型回合与事件。 */

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
  arguments: JsonValue
}

export interface ToolSpec {
  name: string
  description: string
  parameters: JsonObject
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  /** 仅内部使用；转成 provider wire 格式时 tool 角色不带 name。 */
  name?: string
  isError?: boolean
}

export interface ModelRequest {
  messages: ChatMessage[]
  tools: ToolSpec[]
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export type ModelFailureKind =
  | 'auth'
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown'

export interface ModelFailure {
  kind: ModelFailureKind
  message: string
  status?: number
  retryable?: boolean
}

export interface AssistantTurn {
  text: string
  toolCalls: ToolCall[]
  usage: Usage
  finishReason: 'stop' | 'tool-calls' | 'length' | 'error'
  failure?: ModelFailure
}

export interface ModelOptions {
  signal?: AbortSignal
  onText?: (text: string) => void
}

export interface Model {
  readonly provider: string
  readonly model: string
  complete(request: ModelRequest, options?: ModelOptions): Promise<AssistantTurn>
}

export type Outcome =
  | { kind: 'ok' }
  | { kind: 'error'; failure: ModelFailure }

export interface AgentResult {
  outcome: Outcome
  steps: number
  usage: Usage
  toolCalls: Array<{ name: string; args: JsonValue; ok: boolean }>
  text: string
  messages: ChatMessage[]
}

export interface SessionEvent {
  seq: number
  at: number
  type: string
  data: JsonObject
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 })

export function createClock(start = 0, step = 100): () => number {
  let time = start
  return () => {
    const now = time
    time += step
    return now
  }
}
