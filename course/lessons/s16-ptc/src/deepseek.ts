/**
 * s16 的最小 DeepSeek 客户端（非流式）。
 *
 * PTC demo 只需要一次回答：模型写一段程序，我们提取代码块再交给 runtime。
 * 流式、重试、provider 协商不是本课主题，留给 s01 / s08。
 */

import type { DeepSeekConfig } from './env.ts'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompletionUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface CompletionResult {
  text: string
  usage: CompletionUsage
}

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

interface WireResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  error?: { message?: string; code?: string }
}

export class DeepSeekClient {
  readonly provider = 'deepseek'
  readonly model: string
  readonly baseUrl: string
  #config: DeepSeekConfig

  constructor(config: DeepSeekConfig) {
    this.#config = config
    this.model = config.model
    this.baseUrl = config.baseUrl
  }

  async complete(messages: readonly ChatMessage[], options: { signal?: AbortSignal } = {}): Promise<CompletionResult> {
    const endpoint = `${this.#config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const timeout = this.#config.timeoutMs === undefined
      ? undefined
      : AbortSignal.timeout(this.#config.timeoutMs)
    const signal = options.signal === undefined
      ? timeout
      : timeout === undefined
        ? options.signal
        : AbortSignal.any([options.signal, timeout])

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          ...this.#config.maxTokens === undefined ? {} : { max_tokens: this.#config.maxTokens },
        }),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw options.signal.reason
      throw new DeepSeekError(
        `DeepSeek request failed: ${error instanceof Error ? error.message : String(error)}`,
        'NETWORK',
        undefined,
        { cause: error },
      )
    }

    const raw = await response.text()
    if (!response.ok) {
      let detail = raw.slice(0, 500) || `HTTP ${response.status}`
      let code = `HTTP_${response.status}`
      try {
        const parsed = JSON.parse(raw) as WireResponse
        if (parsed.error?.message !== undefined) detail = parsed.error.message
        if (typeof parsed.error?.code === 'string') code = parsed.error.code
      } catch {
        // 保留原始文本。
      }
      throw new DeepSeekError(`DeepSeek HTTP ${response.status}: ${detail}`, code, response.status)
    }

    let parsed: WireResponse
    try {
      parsed = JSON.parse(raw) as WireResponse
    } catch (error) {
      throw new DeepSeekError('DeepSeek returned invalid JSON', 'PROTOCOL', response.status, { cause: error })
    }
    if (parsed.error !== undefined) {
      throw new DeepSeekError(
        parsed.error.message ?? 'DeepSeek returned an error',
        parsed.error.code ?? 'PROVIDER_ERROR',
        response.status,
      )
    }

    const text = parsed.choices?.[0]?.message?.content
    if (typeof text !== 'string') {
      throw new DeepSeekError('DeepSeek response had no text content', 'EMPTY_RESPONSE', response.status)
    }

    return {
      text,
      usage: {
        ...parsed.usage?.prompt_tokens === undefined ? {} : { inputTokens: parsed.usage.prompt_tokens },
        ...parsed.usage?.completion_tokens === undefined ? {} : { outputTokens: parsed.usage.completion_tokens },
        ...parsed.usage?.total_tokens === undefined ? {} : { totalTokens: parsed.usage.total_tokens },
      },
    }
  }
}
