/**
 * s08 离线测试：provider 注册、prepareCall、能力协商、in-history、重试。
 *
 * 不需要 API key。真实模型端到端在 live.test.ts。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Agent,
  createTextMessage,
  isRetryable,
  LlmRuntime,
  ProviderError,
  retryDelayMs,
  Session,
  SystemPrompt,
  textOf,
  ToolRegistry,
} from '../src/index.ts'
import type {
  ChatRequest,
  LlmFailure,
  ModelCapabilities,
  PreparedCall,
  Provider,
  StreamChunk,
} from '../src/index.ts'

class TestProvider implements Provider {
  readonly id = 'test'
  readonly capabilities: ModelCapabilities
  readonly calls: ChatRequest[] = []
  failFirst = false

  constructor(capabilities: ModelCapabilities = { contextWindow: 1_000 }) {
    this.capabilities = capabilities
  }

  resolveModel(_model: string): ModelCapabilities {
    return this.capabilities
  }

  async prepareCall(options: { provider: string; model: string }): Promise<PreparedCall> {
    const capabilities = this.capabilities
    const calls = this.calls
    let localCalls = 0
    const failFirst = this.failFirst
    return {
      config: { provider: this.id, model: options.model, maxTokens: 64 },
      capabilities,
      retryPolicy: { maxRetries: 2, retryableCodes: ['FLAKY'] },
      async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
        calls.push(request)
        localCalls += 1
        yield { type: 'block-start', index: 0, blockType: 'text' }
        if (failFirst && localCalls === 1) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'flaky', code: 'FLAKY' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  }
}

test('runtime: register, prepare and unknown provider', async () => {
  const runtime = new LlmRuntime()
  const provider = new TestProvider()
  const remove = runtime.register(provider)
  assert.deepEqual(runtime.listProviders(), ['test'])

  const prepared = await runtime.prepareCall({ provider: 'test', model: 'm1' })
  assert.deepEqual(prepared.config, { provider: 'test', model: 'm1', maxTokens: 64 })
  assert.deepEqual(prepared.capabilities, { contextWindow: 1_000 })
  assert.equal(prepared.retryPolicy.maxRetries, 2)

  await assert.rejects(
    async () => runtime.prepareCall({ provider: 'nope', model: 'm' }),
    (error: unknown) => error instanceof ProviderError && error.code === 'NO_PROVIDER',
  )

  remove()
  assert.deepEqual(runtime.listProviders(), [])
})

test('runtime: createModel prepares per stream', async () => {
  const runtime = new LlmRuntime()
  const provider = new TestProvider()
  runtime.register(provider)
  const model = runtime.createModel('test', 'm1')

  const prepared = await model.prepare?.()
  assert.equal(prepared?.config.model, 'm1')

  const chunks: StreamChunk[] = []
  for await (const chunk of model.stream({
    sessionId: 's',
    provider: 'test',
    model: 'm1',
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  })) chunks.push(chunk)

  assert.equal(chunks.some(chunk => chunk.type === 'text-delta'), true)
  assert.equal(provider.calls.length, 1)
})

test('retry helpers: retryable codes and bounded delay', () => {
  const policy = { maxRetries: 2, retryableCodes: ['FLAKY'] }
  assert.equal(isRetryable({ message: 'x', code: 'FLAKY' }, policy), true)
  assert.equal(isRetryable({ message: 'x', code: 'OTHER' }, policy), false)
  assert.equal(isRetryable({ message: 'x', code: 'FLAKY' }, { maxRetries: 0, retryableCodes: ['FLAKY'] }), false)
  assert.equal(retryDelayMs(0) <= retryDelayMs(5), true)
})

test('agent: a flaky attempt is retried and the turn completes', async () => {
  const runtime = new LlmRuntime()
  const provider = new TestProvider()
  provider.failFirst = true
  runtime.register(provider)
  const model = runtime.createModel('test', 'm1')

  const session = new Session('retry')
  const agent = new Agent(session, model, new ToolRegistry())
  const result = await agent.run('hi')

  assert.equal(result.reason.kind, 'completed')
  assert.equal(provider.calls.length, 2)
  assert.deepEqual(
    session.events.filter(event => event.type === 'assistant/attempt').map(event => event.type === 'assistant/attempt' ? event.data.failure.code : ''),
    ['FLAKY'],
  )
  assert.equal(session.events.filter(event => event.type === 'assistant/message').length, 1)
  assert.equal(session.lastAssistantText(), 'ok')
})

test('agent: prepared capabilities reach request/context and header maxTokens', async () => {
  const runtime = new LlmRuntime()
  runtime.register(new TestProvider({ contextWindow: 4_096, systemPromptUpdate: 'in-history' }))
  const session = new Session('capabilities')
  await new Agent(session, runtime.createModel('test', 'm1'), new ToolRegistry()).run('hi')

  assert.deepEqual(session.requestContext(), {
    provider: 'test',
    model: 'm1',
    contextWindow: 4_096,
    systemPromptUpdate: 'in-history',
  })
  assert.equal(session.requestHeader()?.config.maxTokens, 64)
})

test('agent: in-history prompt changes append instead of replacing the head', async () => {
  const runtime = new LlmRuntime()
  runtime.register(new TestProvider({ contextWindow: 1_000, systemPromptUpdate: 'in-history' }))
  const session = new Session('in-history')
  const prompt = new SystemPrompt()
  const variable = prompt.variable('v', 'one')
  prompt.section({ name: 's', order: 0, text: 'prompt {{v}}' })

  const agent = new Agent(session, runtime.createModel('test', 'm1'), new ToolRegistry(), { prompt })
  await agent.run('first')
  variable()
  prompt.variable('v', 'two')
  await agent.run('second')

  const systems = session.events.filter(event => event.type === 'system/message')
  assert.equal(systems.length, 2)
  assert.equal(session.surfaceSeqs.filter(seq => seq === systems[0]!.seq || seq === systems[1]!.seq).length, 2)
  assert.deepEqual(
    session.deriveMessages().filter(message => message.role === 'system').map(textOf),
    ['prompt one', 'prompt two'],
  )
})

test('agent: a model without prepare keeps the legacy path', async () => {
  const legacy = {
    provider: 'legacy',
    model: 'direct',
    async *stream(_request: ChatRequest): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'legacy' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'legacy' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const session = new Session('legacy')
  const result = await new Agent(session, legacy, new ToolRegistry()).run('hi')
  assert.equal(result.reason.kind, 'completed')
  assert.equal(session.requestHeader()?.config.provider, 'legacy')
  assert.equal(session.requestContext()?.contextWindow, undefined)
})

test('deepseek provider: prepareCall exposes capabilities and retry policy', async () => {
  const { DeepSeekProvider } = await import('../src/deepseek.ts')
  const provider = new DeepSeekProvider({
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid',
    model: 'deepseek-flash',
  })
  const prepared = await provider.prepareCall({ provider: 'deepseek', model: 'deepseek-flash' })
  assert.equal(prepared.config.provider, 'deepseek')
  assert.equal(prepared.capabilities.contextWindow, 1_048_576)
  assert.equal(prepared.retryPolicy.retryableCodes.includes('HTTP_429'), true)
  assert.equal(prepared.capabilities.systemPromptUpdate, undefined)
})
