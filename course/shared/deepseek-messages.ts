/**
 * 共享的 DeepSeek Messages 适配器。
 *
 * 真实 DSH 的 `llm-deepseek` 走 DeepSeek 的 Anthropic-compatible Messages：
 *   POST {baseURL}/v1/messages
 *   x-api-key + anthropic-version: 2023-06-01
 *
 * 本文件只依赖标准 fetch / Web Streams，不依赖任何课程目录里的类型，
 * 因此 28 课可以共用同一份 wire 实现；各课仍保留自己的 Message/StreamChunk
 * 词汇表，结构上兼容。
 */

interface DeepSeekConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  maxTokens?: number
  timeoutMs?: number
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  temperature?: number
}

interface ChatMessage {
  role: string
  content: unknown
  toolCallId?: string
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>
  isError?: boolean
  id?: string
}

interface CompletionUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

interface CompletionResult {
  text: string
  usage: CompletionUsage
}

interface Block {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  signature?: string
}

interface WireBlock {
  type: string
  [key: string]: unknown
}

interface WireMessage {
  role: 'user' | 'assistant' | 'system'
  content: WireBlock[]
}

const DEFAULT_BASE = 'https://api.deepseek.com/anthropic'
const ANTHROPIC_VERSION = '2023-06-01'
const TOOL_CHANGES_BETA = 'mid-conversation-tool-changes-2026-07-01'

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

/** SSE 帧解码：只处理 data 行；Messages 的事件类型在 JSON 的 type 字段。 */
export class SseDecoder {
  #buffer = ''
  push(text: string): string[] {
    this.#buffer = (this.#buffer + text).replace(/\r\n/g, '\n')
    const events: string[] = []
    for (;;) {
      const end = this.#buffer.indexOf('\n\n')
      if (end < 0) break
      const block = this.#buffer.slice(0, end)
      this.#buffer = this.#buffer.slice(end + 2)
      const data = block.split('\n')
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
    const data = block.split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    return data.length > 0 ? [data] : []
  }
}

function blocksOf(message: ChatMessage): Block[] {
  if (Array.isArray(message.content)) return message.content as Block[]
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }]
  return []
}

function textOf(blocks: readonly Block[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

function wireInput(block: Block): WireBlock | undefined {
  if (block.type === 'text') return block.text ? { type: 'text', text: block.text } : undefined
  return undefined
}

/** Project the course's internal messages onto Messages wire messages. */
export function toWireMessages(messages: readonly ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = []
  const push = (role: WireMessage['role'], blocks: WireBlock[]) => {
    if (blocks.length === 0) return
    const previous = out.at(-1)
    if (previous?.role === role) previous.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  for (const message of messages) {
    const blocks = blocksOf(message)
    if (message.role === 'system') {
      push('system', blocks.map(wireInput).filter((block): block is WireBlock => block !== undefined))
      continue
    }
    if (message.role === 'developer') {
      const changes = blocks.flatMap((block): WireBlock[] => block.type === 'tool-addition'
        ? [{ type: 'tool_addition', tool: { type: 'tool_reference', name: (block as Block & { toolName?: string }).toolName } }]
        : block.type === 'tool-removal'
          ? [{ type: 'tool_removal', tool: { type: 'tool_reference', name: (block as Block & { toolName?: string }).toolName } }]
          : block.type === 'text' && block.text ? [{ type: 'text', text: block.text }] : [])
      push('system', changes)
      continue
    }
    if (message.role === 'tool') {
      push('user', [{
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: blocks.map(wireInput).filter((block): block is WireBlock => block !== undefined),
        ...message.isError === true ? { is_error: true } : {},
      }])
      continue
    }
    if (message.role === 'assistant') {
      const assistant: WireBlock[] = []
      for (const block of blocks) {
        if (block.type === 'text' && block.text) assistant.push({ type: 'text', text: block.text })
        else if (block.type === 'reasoning' && block.text) assistant.push({ type: 'thinking', thinking: block.text })
        else if (block.type === 'tool-call' && block.id && block.name) {
          const raw = (block as Block & { arguments?: string }).arguments ?? block.input
          let input: unknown = {}
          if (typeof raw === 'string') { try { input = JSON.parse(raw) } catch { input = {} } }
          else if (raw !== undefined && raw !== null) input = raw
          assistant.push({ type: 'tool_use', id: block.id, name: block.name, input })
        }
      }
      for (const call of message.toolCalls ?? []) {
        assistant.push({
          type: 'tool_use', id: call.id, name: call.name,
          input: typeof call.arguments === 'string' ? safeJson(call.arguments) : call.arguments,
        })
      }
      push('assistant', assistant)
      continue
    }
    push('user', blocks.map(wireInput).filter((block): block is WireBlock => block !== undefined))
  }
  return out
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return {} }
}

export function toWireTools(tools: readonly { name: string; description: string; parameters?: unknown }[]): Array<{ name: string; description: string; input_schema: unknown }> {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters ?? { type: 'object', properties: {} },
  }))
}

function messagesRoot(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return base.endsWith('/v1') ? base : `${base}/v1`
}

function splitSystem(messages: readonly ChatMessage[]): { system?: string; wire: WireMessage[] } {
  const wire = toWireMessages(messages)
  const systems = wire.filter(message => message.role === 'system')
  const rest = wire.filter(message => message.role !== 'system')
  const system = systems.flatMap(message => message.content.map(block => String(block.text ?? ''))).filter(Boolean).join('\n\n')
  return { ...system.length === 0 ? {} : { system }, wire: rest }
}

function bodyFor(config: DeepSeekConfig, messages: readonly ChatMessage[], tools: readonly { name: string; description: string; parameters?: unknown }[] = []) {
  const { system, wire } = splitSystem(messages)
  return {
    model: config.model ?? 'deepseek-flash',
    max_tokens: config.maxTokens ?? 4096,
    stream: true,
    thinking: { type: config.thinking === 'disabled' ? 'disabled' : 'enabled' },
    ...config.thinking === 'disabled' || config.reasoningEffort === 'off' || config.reasoningEffort === undefined ? {} : { output_config: { effort: config.reasoningEffort } },
    ...config.temperature === undefined ? {} : { temperature: config.temperature },
    ...system === undefined ? {} : { system },
    messages: wire,
    ...tools.length === 0 ? {} : { tools: toWireTools(tools) },
  }
}

function headers(apiKey: string, body: { messages: WireMessage[] }): Record<string, string> {
  const hasToolChanges = body.messages.some(message => message.content.some(block => block.type === 'tool_addition' || block.type === 'tool_removal'))
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    ...hasToolChanges ? { 'anthropic-beta': TOOL_CHANGES_BETA } : {},
  }
}

function mergeUsage(current: CompletionUsage | undefined, raw: Record<string, unknown>): CompletionUsage {
  const next = mapUsage(raw)
  return {
    inputTokens: raw.input_tokens === undefined ? current?.inputTokens ?? next.inputTokens : next.inputTokens,
    outputTokens: raw.output_tokens === undefined ? current?.outputTokens ?? next.outputTokens : next.outputTokens,
    ...raw.total_tokens === undefined ? current?.totalTokens === undefined ? {} : { totalTokens: current.totalTokens } : { totalTokens: next.totalTokens },
    ...raw.cache_read_input_tokens === undefined ? current?.cacheReadTokens === undefined ? {} : { cacheReadTokens: current.cacheReadTokens } : { cacheReadTokens: next.cacheReadTokens },
    ...raw.cache_creation_input_tokens === undefined ? current?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: current.cacheWriteTokens } : { cacheWriteTokens: next.cacheWriteTokens },
  }
}

export function mapUsage(raw: Record<string, unknown>): CompletionUsage {
  const input = Number(raw.input_tokens ?? raw.prompt_tokens ?? 0)
  const output = Number(raw.output_tokens ?? raw.completion_tokens ?? 0)
  const total = raw.total_tokens === undefined ? undefined : Number(raw.total_tokens)
  return {
    inputTokens: Number.isFinite(input) ? input : 0,
    outputTokens: Number.isFinite(output) ? output : 0,
    ...total === undefined ? {} : { totalTokens: total },
    ...raw.cache_read_input_tokens === undefined ? {} : { cacheReadTokens: Number(raw.cache_read_input_tokens) },
    ...raw.cache_creation_input_tokens === undefined ? {} : { cacheWriteTokens: Number(raw.cache_creation_input_tokens) },
    ...raw.reasoning_tokens === undefined ? {} : { reasoningTokens: Number(raw.reasoning_tokens) },
  }
}

export function mapFinishReason(reason: string | null | undefined) {
  switch (reason) {
    case null: case undefined: case 'end_turn': case 'stop_sequence': case 'stop': return { kind: 'stop' } as const
    case 'tool_use': case 'tool_calls': return { kind: 'tool-calls' } as const
    case 'max_tokens': case 'length': return { kind: 'max-tokens' } as const
    case 'refusal': return { kind: 'error', failure: { message: 'response refused', code: 'REFUSAL' } } as const
    default: return { kind: 'error', failure: { message: `unknown stop_reason "${reason}"`, code: 'UNKNOWN_FINISH_REASON' } } as const
  }
}

export class DeepSeekModel {
  readonly provider = 'deepseek'
  readonly model: string
  #config: DeepSeekConfig
  constructor(config: DeepSeekConfig = {}) {
    this.#config = config
    this.model = config.model ?? 'deepseek-flash'
  }
  get baseUrl(): string { return this.#config.baseUrl ?? DEFAULT_BASE }
  capabilities() { return { contextWindow: 1_048_576, ...this.#config.maxTokens === undefined ? {} : { defaultMaxTokens: this.#config.maxTokens } } }
  async prepare(_options: { signal?: AbortSignal } = {}) {
    return {
      config: { provider: this.provider, model: this.model, ...this.#config.maxTokens === undefined ? {} : { maxTokens: this.#config.maxTokens } },
      capabilities: this.capabilities(),
      retryPolicy: { maxRetries: 2, retryableCodes: ['NETWORK', 'HTTP_429', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'SERVER', 'RATE_LIMITED'] },
      stream: (request: any) => this.stream(request),
    }
  }
  async *stream(request: any): AsyncIterable<any> {
    const apiKey = this.#config.apiKey ?? ''
    if (!apiKey) throw new DeepSeekError('DeepSeek API key is missing', 'MISSING_CREDENTIAL')
    const body = bodyFor({ ...this.#config, model: request.model ?? this.model }, request.messages, request.tools ?? [])
    const base = this.#config.baseUrl ?? DEFAULT_BASE
    const timeout = this.#config.timeoutMs === undefined ? undefined : AbortSignal.timeout(this.#config.timeoutMs)
    const signal = timeout === undefined ? request.signal : AbortSignal.any([request.signal, timeout])
    let response: Response
    try {
      response = await fetch(`${messagesRoot(base)}/messages`, {
        method: 'POST', headers: headers(apiKey, body), body: JSON.stringify(body), signal,
      })
    } catch (error) {
      if (request.signal?.aborted === true) throw request.signal.reason
      throw new DeepSeekError(`DeepSeek request failed: ${error instanceof Error ? error.message : String(error)}`, 'NETWORK', undefined, { cause: error })
    }
    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      const failure = mapHttpError(response.status, raw)
      throw new DeepSeekError(failure.message, `HTTP_${response.status}`, response.status)
    }
    if (response.body === null) throw new DeepSeekError('DeepSeek returned an empty body', 'EMPTY_BODY', response.status)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const sse = new SseDecoder()
    const blocks = new Map<number, { type: string; text: string; id: string; name: string; json: string; signature: string; closed: boolean }>()
    let finish: any
    let usage: CompletionUsage | undefined
    let sawStop = false

    try {
      outer: for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (request.signal?.aborted === true) throw request.signal.reason
        for (const data of sse.push(decoder.decode(value, { stream: true }))) {
          if (data === '[DONE]') { sawStop = true; break outer }
          let event: any
          try { event = JSON.parse(data) } catch { throw new DeepSeekError(`invalid Messages SSE JSON: ${data.slice(0, 160)}`, 'PROTOCOL', response.status) }
          if (event.type === 'error') throw new DeepSeekError(event.error?.message ?? 'Messages stream error', event.error?.type ?? 'STREAM_ERROR', response.status)
          if (event.type === 'message_start' && event.message?.usage) usage = mergeUsage(usage, event.message.usage)
          if (event.type === 'content_block_start') {
            const index = Number(event.index)
            const native = event.content_block ?? {}
            const state = { type: native.type, text: native.type === 'text' ? String(native.text ?? '') : native.type === 'thinking' ? String(native.thinking ?? '') : '', id: String(native.id ?? ''), name: String(native.name ?? ''), json: native.type === 'tool_use' && native.input !== undefined && Object.keys(native.input).length > 0 ? JSON.stringify(native.input) : '', signature: String(native.signature ?? ''), closed: false }
            blocks.set(index, state)
            if (state.type === 'text') yield { type: 'block-start', index, blockType: 'text' }
            else if (state.type === 'thinking') yield { type: 'block-start', index, blockType: 'reasoning' }
            else if (state.type === 'tool_use') yield { type: 'block-start', index, blockType: 'tool-call' }
            else throw new DeepSeekError(`unsupported Messages block ${state.type}`, 'UNSUPPORTED_CONTENT')
          } else if (event.type === 'content_block_delta') {
            const index = Number(event.index)
            const state = blocks.get(index)
            if (!state) throw new DeepSeekError('Messages delta without block-start', 'PROTOCOL')
            const delta = event.delta ?? {}
            if (delta.type === 'text_delta') { state.text += String(delta.text ?? ''); yield { type: 'text-delta', index, text: String(delta.text ?? '') } }
            else if (delta.type === 'thinking_delta') { state.text += String(delta.thinking ?? ''); yield { type: 'reasoning-delta', index, text: String(delta.thinking ?? '') } }
            else if (delta.type === 'signature_delta') state.signature += String(delta.signature ?? '')
            else if (delta.type === 'input_json_delta') { state.json += String(delta.partial_json ?? ''); yield { type: 'tool-call-delta', index, id: state.id, name: state.name, argumentsDelta: String(delta.partial_json ?? '') } }
          } else if (event.type === 'content_block_stop') {
            const index = Number(event.index)
            const state = blocks.get(index)
            if (!state) throw new DeepSeekError('Messages stop without block-start', 'PROTOCOL')
            state.closed = true
            if (state.type === 'text') yield { type: 'block-end', index, block: { type: 'text', text: state.text } }
            else if (state.type === 'thinking') yield { type: 'block-end', index, block: { type: 'reasoning', text: state.text, ...state.signature ? { signature: state.signature } : {} } }
            else yield { type: 'block-end', index, block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.json || '{}' } }
          } else if (event.type === 'message_delta') {
            if (event.usage) usage = mergeUsage(usage, event.usage)
            if (event.delta?.stop_reason) finish = mapFinishReason(event.delta.stop_reason)
          } else if (event.type === 'message_stop') { sawStop = true; break outer }
        }
      }
    } finally {
      try { await reader.cancel() } catch {}
    }
    if (!sawStop) throw new DeepSeekError('Messages stream ended before message_stop', 'STREAM_CLOSED')
    if (usage) yield { type: 'usage', usage }
    const hasTools = [...blocks.values()].some(block => block.type === 'tool_use')
    yield { type: 'finish', reason: finish ?? (hasTools ? { kind: 'tool-calls' } : { kind: 'stop' }) }
  }

  async complete(request: { messages: ChatMessage[]; tools?: readonly { name: string; description: string; parameters?: unknown }[] }, options: { signal?: AbortSignal; onText?: (text: string) => void } = {}) {
    const chunks: any[] = []
    try {
      for await (const chunk of this.stream({ messages: request.messages, tools: request.tools ?? [], signal: options.signal ?? new AbortController().signal })) {
        if (chunk.type === 'text-delta') options.onText?.(chunk.text)
        chunks.push(chunk)
      }
    } catch (error) {
      const status = error instanceof DeepSeekError ? error.status : undefined
      const failure = status === undefined
        ? { kind: 'network' as const, message: error instanceof Error ? error.message : String(error), retryable: true }
        : mapHttpError(status, error instanceof Error ? error.message : String(error))
      return { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'error' as const, failure }
    }
    let text = ''
    const calls: Array<{ id: string; name: string; arguments: unknown }> = []
    let usage: CompletionUsage = { inputTokens: 0, outputTokens: 0 }
    let finishReason: 'stop' | 'tool-calls' | 'length' | 'error' = 'stop'
    for (const chunk of chunks) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') calls.push({ id: chunk.block.id, name: chunk.block.name, arguments: safeJson(chunk.block.arguments) })
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finishReason = chunk.reason.kind === 'tool-calls' ? 'tool-calls' : chunk.reason.kind === 'max-tokens' ? 'length' : chunk.reason.kind === 'stop' ? 'stop' : 'error'
    }
    return { text, toolCalls: calls, usage, finishReason }
  }
}

export class DeepSeekProvider {
  readonly id = 'deepseek'
  #config: DeepSeekConfig
  constructor(config: DeepSeekConfig = {}) { this.#config = config }
  resolveModel(_model: string) { return { contextWindow: 1_048_576, ...this.#config.maxTokens === undefined ? {} : { defaultMaxTokens: this.#config.maxTokens } } }
  async prepareCall(options: { provider: string; model: string; signal?: AbortSignal }) {
    return new DeepSeekModel({ ...this.#config, model: options.model }).prepare({ signal: options.signal })
  }
}

export class DeepSeekClient {
  readonly provider = 'deepseek'
  readonly model: string
  readonly baseUrl: string
  #config: DeepSeekConfig
  constructor(config: DeepSeekConfig) { this.#config = config; this.model = config.model ?? 'deepseek-flash'; this.baseUrl = config.baseUrl ?? DEFAULT_BASE }
  async complete(messages: readonly ChatMessage[], options: { signal?: AbortSignal } = {}): Promise<CompletionResult> {
    const model = new DeepSeekModel(this.#config)
    const result = await model.complete({ messages: [...messages], tools: [] }, options)
    return { text: result.text, usage: result.usage }
  }
}

export function createDeepSeekModel(config: DeepSeekConfig = {}): DeepSeekModel { return new DeepSeekModel(config) }
export function createDeepSeekProvider(config: DeepSeekConfig = {}): DeepSeekProvider { return new DeepSeekProvider(config) }

export function mapHttpError(status: number, body: string): { kind: 'auth' | 'rate-limit' | 'timeout' | 'network' | 'server' | 'unknown'; message: string; status?: number; retryable?: boolean } {
  const detail = body.trim().slice(0, 300)
  const message = `HTTP ${status}: ${detail || 'request failed'}`
  if (status === 401 || status === 403) return { kind: 'auth', message, status, retryable: false }
  if (status === 429) return { kind: 'rate-limit', message, status, retryable: true }
  if (status === 408 || status === 504) return { kind: 'timeout', message, status, retryable: true }
  if (status >= 500) return { kind: 'server', message, status, retryable: true }
  return { kind: 'unknown', message, status, retryable: false }
}
