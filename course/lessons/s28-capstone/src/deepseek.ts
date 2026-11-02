/** 真实 DeepSeek 客户端：流式 Chat Completions + tool calls，零依赖。 */

import { SseDecoder } from './sse.ts'
import type {
  AssistantTurn,
  ChatMessage,
  JsonObject,
  JsonValue,
  Model,
  ModelFailure,
  ModelOptions,
  ModelRequest,
  ToolCall,
  Usage,
} from './types.ts'
import { emptyUsage } from './types.ts'

export interface DeepSeekConfig {
  apiKey: string
  baseUrl?: string
  model?: string
  maxTokens?: number
  timeoutMs?: number
}

interface ToolCallPart {
  id: string
  name: string
  arguments: string
}

export class DeepSeekModel implements Model {
  readonly provider = 'deepseek'
  readonly model: string
  #apiKey: string
  #baseUrl: string
  #maxTokens: number
  #timeoutMs: number

  constructor(config: DeepSeekConfig) {
    if (config.apiKey.trim() === '') throw new TypeError('DeepSeek apiKey is required')
    this.#apiKey = config.apiKey
    this.#baseUrl = (config.baseUrl ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '')
    this.model = config.model ?? 'deepseek-flash'
    this.#maxTokens = config.maxTokens ?? 4_096
    this.#timeoutMs = config.timeoutMs ?? 120_000
  }

  async complete(request: ModelRequest, options: ModelOptions = {}): Promise<AssistantTurn> {
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])

    let response: Response
    try {
      response = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: toWireMessages(request.messages),
          ...request.tools.length === 0 ? {} : { tools: toWireTools(request.tools) },
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: this.#maxTokens,
        }),
        signal,
      })
    } catch (error) {
      return failureTurn(normalizeRequestError(error))
    }

    if (!response.ok) {
      let body = ''
      try {
        body = await response.text()
      } catch {
        body = '(unreadable error body)'
      }
      return failureTurn(mapHttpError(response.status, body))
    }
    if (response.body === null) {
      return failureTurn({ kind: 'network', message: 'response has no body', retryable: true })
    }

    const decoder = new SseDecoder()
    const textDecoder = new TextDecoder()
    const reader = response.body.getReader()
    const parts = new Map<number, ToolCallPart>()
    let text = ''
    let usage: Usage = emptyUsage()
    let finishReason: string | null = null

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = textDecoder.decode(value, { stream: true })
        for (const data of decoder.push(chunk)) {
          if (data === '[DONE]') continue
          const payload = safeJson(data)
          if (payload === undefined) continue

          const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined
          const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : undefined
          if (delta !== undefined && typeof delta.content === 'string' && delta.content !== '') {
            text += delta.content
            options.onText?.(delta.content)
          }

          if (delta !== undefined && Array.isArray(delta.tool_calls)) {
            for (const rawPart of delta.tool_calls) {
              if (!isRecord(rawPart)) continue
              const index = typeof rawPart.index === 'number' ? rawPart.index : 0
              const existing = parts.get(index) ?? { id: '', name: '', arguments: '' }
              if (typeof rawPart.id === 'string' && rawPart.id !== '') existing.id = rawPart.id
              const fn = isRecord(rawPart.function) ? rawPart.function : undefined
              if (fn !== undefined) {
                if (typeof fn.name === 'string' && fn.name !== '') existing.name = fn.name
                if (typeof fn.arguments === 'string') existing.arguments += fn.arguments
              }
              parts.set(index, existing)
            }
          }

          if (isRecord(choice) && typeof choice.finish_reason === 'string') {
            finishReason = choice.finish_reason
          }

          if (isRecord(payload.usage)) {
            usage = {
              inputTokens: typeof payload.usage.prompt_tokens === 'number' ? payload.usage.prompt_tokens : usage.inputTokens,
              outputTokens: typeof payload.usage.completion_tokens === 'number' ? payload.usage.completion_tokens : usage.outputTokens,
            }
          }
        }
      }
    } catch (error) {
      try {
        await reader.cancel()
      } catch {
        // ignore
      }
      return failureTurn(normalizeRequestError(error))
    } finally {
      reader.releaseLock()
    }

    const toolCalls: ToolCall[] = [...parts.entries()]
      .sort(([left], [right]) => left - right)
      .filter(([, part]) => part.name !== '')
      .map(([index, part]) => ({
        id: part.id === '' ? `call-${index}` : part.id,
        name: part.name,
        arguments: parseArguments(part.arguments),
      }))

    return {
      text,
      toolCalls,
      usage,
      finishReason: finishReason === 'length'
        ? 'length'
        : toolCalls.length > 0
          ? 'tool-calls'
          : 'stop',
    }
  }
}

export function mapHttpError(status: number, body: string): ModelFailure {
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 300)
  const message = `HTTP ${status}${snippet === '' ? '' : `: ${snippet}`}`
  if (status === 401 || status === 403) {
    return { kind: 'auth', message, status, retryable: false }
  }
  if (status === 429) {
    return { kind: 'rate-limit', message, status, retryable: true }
  }
  if (status === 408 || status === 504) {
    return { kind: 'timeout', message, status, retryable: true }
  }
  if (status >= 500) {
    return { kind: 'server', message, status, retryable: true }
  }
  return { kind: 'unknown', message, status, retryable: false }
}

function normalizeRequestError(error: unknown): ModelFailure {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') {
      return { kind: 'timeout', message: error.message, retryable: true }
    }
    if (error.name === 'AbortError') {
      return { kind: 'timeout', message: 'request aborted', retryable: true }
    }
    return { kind: 'network', message: error.message, retryable: true }
  }
  return { kind: 'network', message: String(error), retryable: true }
}

function failureTurn(failure: ModelFailure): AssistantTurn {
  return {
    text: '',
    toolCalls: [],
    usage: emptyUsage(),
    finishReason: 'error',
    failure,
  }
}

function parseArguments(raw: string): JsonValue {
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    return null
  }
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toWireMessages(messages: readonly ChatMessage[]): unknown[] {
  return messages.map(message => {
    if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
      }
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content,
      }
    }
    return { role: message.role, content: message.content }
  })
}

function toWireTools(tools: ModelRequest['tools']): unknown[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as JsonObject,
    },
  }))
}

export { toWireMessages, toWireTools }
