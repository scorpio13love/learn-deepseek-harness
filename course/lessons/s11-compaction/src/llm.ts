/**
 * s10 沿用 s09 的 provider seam：Provider 注册表、prepareCall、能力元数据与重试策略。
 *
 * 真实实现见 `packages/llm/llm/src/{call-config,index}.ts` 与
 * `packages/llm/llm-deepseek/src/adapter.ts`。
 */

import type {
  ChatRequest,
  LlmFailure,
  Model,
  ModelCapabilities,
  PreparedCall,
  RetryPolicy,
  StreamChunk,
} from './types.ts'

export interface PrepareOptions {
  provider: string
  model: string
  signal?: AbortSignal
}

export interface Provider {
  readonly id: string
  /** 精确路由能力；未知模型也要返回保守的 text-only 默认值。 */
  resolveModel(model: string): ModelCapabilities
  prepareCall(options: PrepareOptions): Promise<PreparedCall>
}

export class ProviderError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
  }
}

export class LlmRuntime {
  #providers = new Map<string, Provider>()

  register(provider: Provider): () => void {
    if (this.#providers.has(provider.id)) throw new Error(`provider "${provider.id}" is already registered`)
    this.#providers.set(provider.id, provider)
    return () => {
      if (this.#providers.get(provider.id) === provider) this.#providers.delete(provider.id)
    }
  }

  provider(id: string): Provider | undefined {
    return this.#providers.get(id)
  }

  listProviders(): string[] {
    return [...this.#providers.keys()]
  }

  async prepareCall(options: PrepareOptions): Promise<PreparedCall> {
    const provider = this.#providers.get(options.provider)
    if (provider === undefined) throw new ProviderError(`unknown provider "${options.provider}"`, 'NO_PROVIDER')
    return provider.prepareCall(options)
  }

  /** 创建一个绑定到 provider 路由的 Model，可直接交给 Agent。 */
  createModel(provider: string, model: string): Model {
    return new RuntimeModel(this, provider, model)
  }
}

class RuntimeModel implements Model {
  readonly provider: string
  readonly model: string
  #runtime: LlmRuntime

  constructor(runtime: LlmRuntime, provider: string, model: string) {
    this.#runtime = runtime
    this.provider = provider
    this.model = model
  }

  async prepare(options: { signal?: AbortSignal } = {}): Promise<PreparedCall> {
    return this.#runtime.prepareCall({
      provider: this.provider,
      model: this.model,
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const prepared = await this.prepare({ signal: request.signal })
    yield* prepared.stream(request)
  }
}

export function isRetryable(failure: LlmFailure, policy: RetryPolicy): boolean {
  return policy.maxRetries > 0 && policy.retryableCodes.includes(failure.code)
}

/** 简单指数退避；真实实现还会尊重 providerRetryAfterMs。 */
export function retryDelayMs(attempt: number): number {
  return Math.min(1_000, 100 * 2 ** Math.max(0, attempt))
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
