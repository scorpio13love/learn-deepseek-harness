/**
 * 真实 DeepSeek 适配器（OpenAI-compatible Chat Completions + SSE）。
 *
 * s06 继续沿用 s05 的实现：把 `ChatRequest` 变成一条流式 HTTP 请求，再把
 * SSE 转成我们的 `StreamChunk`。s08 会把它升级成正式的 provider seam：
 * prepareCall、能力协商、重试、错误分类。
 *
 * 关键映射：
 *   messages             → OpenAI wire messages
 *   tools                → { type: 'function', function: {...} }
 *   delta.content        → text-delta
 *   delta.reasoning_content → reasoning-delta
 *   delta.tool_calls     → tool-call-delta（按 index 合并）
 *   finish_reason        → FinishReason
 *   usage                → TokenUsage（DeepSeek 的 cache 字段是 disjoint 的）
 */

import type {
  ChatRequest,
  ContentBlock,
  FinishReason,
  Message,
  Model,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from './types.ts'
import { isToolCall } from './types.ts'
import type { DeepSeekEnvConfig } from './env.ts'

export class DeepSeekError extends Error {
  readonly code: string
  readonly status: number | undefined

  constructor(message: string, code: string, status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DeepSeekError'
    this.code = code
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Wire 类型与纯转换函数（单元测试直接覆盖）
// ---------------------------------------------------------------------------

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

function textContent(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** 把内部消息投影成 OpenAI-compatible wire messages。 */
export function toWireMessages(messages: readonly Message[]): WireMessage[] {
  return messages.map((message): WireMessage => {
    if (message.role === 'assistant') {
      const toolCalls = message.content.filter(isToolCall).map(call => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      }))
      const content = textContent(message)
      return {
        role: 'assistant',
        content: content.length > 0 ? content : toolCalls.length > 0 ? null : '',
        ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
      }
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: textContent(message) || '(no output)',
      }
    }
    if (message.role === 'developer') {
      // s02 只记录 developer 消息，不生成工具增量；这里把文本和工具变更投影成 system 文本。
      const changes = message.content
        .filter(block => block.type === 'tool-addition' || block.type === 'tool-removal')
        .map(block => block.type === 'tool-addition'
          ? `Tool added: ${block.toolName}`
          : `Tool removed: ${block.toolName}`)
      return {
        role: 'system',
        content: [textContent(message), ...changes].filter(text => text.length > 0).join('\n'),
      }
    }
    return { role: message.role, content: textContent(message) }
  })
}

/** 把工具声明投影成 OpenAI-compatible tools。 */
export function toWireTools(tools: readonly ToolSchema[]): WireTool[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

/** SSE 帧解码器：处理跨 chunk 切割、CRLF、多个 data 行。 */
export class SseDecoder {
  #buffer = ''

  push(text: string): string[] {
    this.#buffer = (this.#buffer + text).replace(/\r\n/g, '\n')
    const events: string[] = []
    while (true) {
      const end = this.#buffer.indexOf('\n\n')
      if (end < 0) break
      const block = this.#buffer.slice(0, end)
      this.#buffer = this.#buffer.slice(end + 2)
      const data = block
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
      if (data.length > 0) events.push(data)
    }
    return events
  }

  flush(): string[] {
    const block = this.#buffer
    this.#buffer = ''
    if (block.trim().length === 0) return []
    const data = block
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    return data.length > 0 ? [data] : []
  }
}

interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * DeepSeek 的 usage：
 *   prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens
 * 我们的 `inputTokens` 只算未命中的输入，缓存命中单独记。
 */
export function mapUsage(raw: WireUsage): TokenUsage {
  const prompt = numberOrUndefined(raw.prompt_tokens) ?? 0
  const hit = numberOrUndefined(raw.prompt_cache_hit_tokens)
  const miss = numberOrUndefined(raw.prompt_cache_miss_tokens)
  const inputTokens = miss ?? (hit === undefined ? prompt : Math.max(0, prompt - hit))
  const outputTokens = numberOrUndefined(raw.completion_tokens) ?? 0
  const totalTokens = numberOrUndefined(raw.total_tokens)
  const reasoningTokens = numberOrUndefined(raw.completion_tokens_details?.reasoning_tokens)
  return {
    inputTokens,
    outputTokens,
    ...totalTokens === undefined ? {} : { totalTokens },
    ...hit === undefined ? {} : { cacheReadTokens: hit },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
  }
}

/** 把 provider 的 finish_reason 映射成内部词汇。 */
export function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case null:
    case undefined:
    case 'stop':
      return { kind: 'stop' }
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'content_filter':
      return { kind: 'error', failure: { message: 'response blocked by content filter', code: 'CONTENT_FILTER' } }
    case 'insufficient_system_resource':
      return { kind: 'error', failure: { message: 'provider ran out of resources', code: 'INSUFFICIENT_RESOURCE' } }
    default:
      return { kind: 'error', failure: { message: `unknown finish_reason "${reason}"`, code: 'UNKNOWN_FINISH_REASON' } }
  }
}

interface WireDeltaToolCall {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: WireDeltaToolCall[]
    }
    finish_reason?: string | null
  }>
  usage?: WireUsage | null
  error?: { message?: string; type?: string; code?: string }
}

interface WireErrorBody {
  error?: { message?: string; type?: string; code?: string }
}

function errorDetail(text: string, status: number): { message: string; code: string } {
  try {
    const parsed = JSON.parse(text) as WireErrorBody
    const message = parsed.error?.message
    const code = parsed.error?.code
    return {
      message: message ?? (text.slice(0, 500) || `HTTP ${status}`),
      code: typeof code === 'string' && code.length > 0 ? code : `HTTP_${status}`,
    }
  } catch {
    return { message: text.slice(0, 500) || `HTTP ${status}`, code: `HTTP_${status}` }
  }
}

// ---------------------------------------------------------------------------
// 模型实现
// ---------------------------------------------------------------------------

export interface DeepSeekModelConfig extends DeepSeekEnvConfig {}

export class DeepSeekModel implements Model {
  readonly provider = 'deepseek'
  readonly model: string
  #config: DeepSeekModelConfig

  constructor(config: DeepSeekModelConfig) {
    this.#config = config
    this.model = config.model
  }

  get baseUrl(): string {
    return this.#config.baseUrl
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const endpoint = `${this.#config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toWireMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...request.tools.length === 0 ? {} : { tools: toWireTools(request.tools) },
      ...this.#config.maxTokens === undefined ? {} : { max_tokens: this.#config.maxTokens },
    }

    const timeout = this.#config.timeoutMs === undefined
      ? undefined
      : AbortSignal.timeout(this.#config.timeoutMs)
    const signal = timeout === undefined
      ? request.signal
      : AbortSignal.any([request.signal, timeout])

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${this.#config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason
      throw new DeepSeekError(
        `DeepSeek request failed: ${error instanceof Error ? error.message : String(error)}`,
        'NETWORK',
        undefined,
        { cause: error },
      )
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      const detail = errorDetail(raw, response.status)
      throw new DeepSeekError(`DeepSeek HTTP ${response.status}: ${detail.message}`, detail.code, response.status)
    }
    if (response.body === null) {
      throw new DeepSeekError('DeepSeek returned an empty body', 'EMPTY_BODY', response.status)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const sse = new SseDecoder()

    const reasoning = { index: 0, started: false, text: '' }
    const text = { index: 1, started: false, text: '' }
    const toolCalls = new Map<number, { id: string; name: string; arguments: string; started: boolean }>()
    let finish: FinishReason | undefined
    let usage: TokenUsage | undefined

    try {
      outer: while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (request.signal.aborted) throw request.signal.reason

        for (const data of sse.push(decoder.decode(value, { stream: true }))) {
          if (data === '[DONE]') break outer

          let chunk: WireChunk
          try {
            chunk = JSON.parse(data) as WireChunk
          } catch (error) {
            throw new DeepSeekError(`invalid SSE JSON: ${data.slice(0, 200)}`, 'PROTOCOL', response.status, { cause: error })
          }

          if (chunk.error !== undefined) {
            throw new DeepSeekError(
              chunk.error.message ?? 'DeepSeek stream error',
              chunk.error.code ?? 'STREAM_ERROR',
              response.status,
            )
          }
          if (chunk.usage !== undefined && chunk.usage !== null) usage = mapUsage(chunk.usage)

          const choice = chunk.choices?.[0]
          if (choice === undefined) continue
          const delta = choice.delta

          const reasoningDelta = delta?.reasoning_content
          if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
            if (!reasoning.started) {
              reasoning.started = true
              yield { type: 'block-start', index: reasoning.index, blockType: 'reasoning' }
            }
            reasoning.text += reasoningDelta
            yield { type: 'reasoning-delta', index: reasoning.index, text: reasoningDelta }
          }

          const contentDelta = delta?.content
          if (typeof contentDelta === 'string' && contentDelta.length > 0) {
            if (!text.started) {
              text.started = true
              yield { type: 'block-start', index: text.index, blockType: 'text' }
            }
            text.text += contentDelta
            yield { type: 'text-delta', index: text.index, text: contentDelta }
          }

          for (const tool of delta?.tool_calls ?? []) {
            const index = tool.index ?? toolCalls.size
            let entry = toolCalls.get(index)
            if (entry === undefined) {
              entry = { id: '', name: '', arguments: '', started: false }
              toolCalls.set(index, entry)
            }
            if (typeof tool.id === 'string' && tool.id.length > 0) entry.id = tool.id
            if (typeof tool.function?.name === 'string' && tool.function.name.length > 0) {
              entry.name = tool.function.name
            }
            const argumentsDelta = tool.function?.arguments
            if (typeof argumentsDelta === 'string') entry.arguments += argumentsDelta

            if (!entry.started) {
              entry.started = true
              yield { type: 'block-start', index: 2 + index, blockType: 'tool-call' }
            }
            yield {
              type: 'tool-call-delta',
              index: 2 + index,
              id: entry.id || `call_${index}`,
              ...entry.name.length === 0 ? {} : { name: entry.name },
              argumentsDelta: typeof argumentsDelta === 'string' ? argumentsDelta : '',
            }
          }

          if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
            finish = mapFinishReason(choice.finish_reason)
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    // 流结束时补齐 block-end，确保 assembler 拿到权威的完整块。
    if (reasoning.started) {
      yield {
        type: 'block-end',
        index: reasoning.index,
        block: { type: 'reasoning', text: reasoning.text },
      }
    }
    if (text.started) {
      yield { type: 'block-end', index: text.index, block: { type: 'text', text: text.text } }
    }
    for (const [index, tool] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      const block: ContentBlock = {
        type: 'tool-call',
        id: tool.id || `call_${index}`,
        name: tool.name,
        arguments: tool.arguments.length === 0 ? '{}' : tool.arguments,
      }
      yield { type: 'block-end', index: 2 + index, block }
    }

    if (usage !== undefined) yield { type: 'usage', usage }
    yield {
      type: 'finish',
      reason: finish ?? (toolCalls.size > 0 ? { kind: 'tool-calls' } : { kind: 'stop' }),
    }
  }
}
