/**
 * s10 离线测试：token 估算、阈值、工具结果裁剪、摘要替换、overflow 重试。
 *
 * 不需要 API key。真实模型端到端在 live.test.ts。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Agent,
  Compaction,
  createMessage,
  createTextMessage,
  isContextOverflow,
  Session,
  textOf,
  ToolRegistry,
} from '../src/index.ts'
import type { ChatRequest, Model, PreparedCall, StreamChunk } from '../src/index.ts'

function dummyModel(): Model {
  return {
    provider: 'dummy',
    model: 'dummy',
    async *stream(_request: ChatRequest): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

function add(session: Session, role: 'user' | 'assistant', text: string): void {
  if (role === 'user') {
    session.append('user/message', { message: createTextMessage('user', text) }, { surfaceOp: 'append' })
    return
  }
  session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text }] }),
    stream: [],
  }, { surfaceOp: 'append' })
}

function addToolResult(session: Session, text: string): void {
  session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'tool',
      toolCallId: 'c1',
      isError: false,
      content: [{ type: 'text', text }],
    }),
  }, { surfaceOp: 'append' })
}

test('estimate and threshold', () => {
  const session = new Session('estimate')
  add(session, 'user', 'x'.repeat(400))
  const compaction = new Compaction({ contextWindow: 300, thresholdRatio: 0.5, retainRatio: 0.1 })
  assert.equal(compaction.estimate(session) >= 100, true)
  assert.equal(compaction.threshold, 150)
  assert.equal(compaction.retainTokens, 30)
})

test('below threshold does not compact', async () => {
  const session = new Session('below')
  add(session, 'user', 'short')
  const compaction = new Compaction({ contextWindow: 10_000, thresholdRatio: 0.8, retainRatio: 0.1 })
  const result = await compaction.beforeStep(session, dummyModel(), new AbortController().signal)
  assert.equal(result.compacted, false)
  assert.equal(result.reason, 'below-threshold')
})

test('compact: prunes a large tool result and replaces old messages with a summary', async () => {
  const session = new Session('compact')
  add(session, 'user', 'analyse this log ' + 'x'.repeat(400))
  add(session, 'assistant', 'I will read it ' + 'y'.repeat(400))
  addToolResult(session, 'tool output\n'.repeat(100))
  add(session, 'assistant', 'tail conclusion ' + 'z'.repeat(200))

  const beforeRaw = session.events.length
  const compaction = new Compaction({
    contextWindow: 400,
    thresholdRatio: 0.5,
    retainRatio: 0.1,
    minMessages: 2,
    maxToolResultChars: 80,
    summarizer: async () => 'summary of the old span',
  })
  const result = await compaction.compact(session, dummyModel(), new AbortController().signal)

  assert.equal(result.compacted, true)
  assert.equal(result.prunedToolResults, 1)
  assert.equal(result.summarizedMessages > 0, true)
  assert.equal(session.events.length > beforeRaw, true)
  assert.equal(session.deriveMessages()[0]?.role, 'user')
  assert.match(textOf(session.deriveMessages()[0]!), /summary of the old span/)
  assert.equal(session.deriveMessages().at(-1)?.role, 'assistant')
  assert.equal(session.events.some(event => event.type === 'assistant/message'), true)
})

test('compact: too few messages is a no-op', async () => {
  const session = new Session('few')
  add(session, 'user', 'only one')
  const compaction = new Compaction({
    contextWindow: 10,
    minMessages: 4,
    summarizer: async () => 'never',
  })
  const result = await compaction.compact(session, dummyModel(), new AbortController().signal)
  assert.equal(result.compacted, false)
  assert.equal(result.reason, 'too-few-messages')
})

test('compact: summarizer failure propagates', async () => {
  const session = new Session('summary-fail')
  add(session, 'user', 'a'.repeat(100))
  add(session, 'assistant', 'b'.repeat(100))
  add(session, 'user', 'c'.repeat(100))
  const compaction = new Compaction({
    contextWindow: 20,
    thresholdRatio: 0.1,
    retainRatio: 0.01,
    minMessages: 1,
    summarizer: async () => { throw new Error('summary exploded') },
  })
  await assert.rejects(
    async () => compaction.compact(session, dummyModel(), new AbortController().signal),
    /summary exploded/,
  )
})

test('isContextOverflow recognizes common codes/messages', () => {
  assert.equal(isContextOverflow({ code: 'CONTEXT_OVERFLOW', message: 'x' }), true)
  assert.equal(isContextOverflow({ code: 'X', message: 'prompt is too long' }), true)
  assert.equal(isContextOverflow({ code: 'AUTH', message: 'unauthorized' }), false)
})

class OverflowModel implements Model {
  readonly provider = 'overflow'
  readonly model = 'm'
  readonly calls: ChatRequest[] = []

  async prepare(): Promise<PreparedCall> {
    return {
      config: { provider: this.provider, model: this.model },
      capabilities: { contextWindow: 100 },
      retryPolicy: { maxRetries: 0, retryableCodes: [] },
      stream: request => this.stream(request),
    }
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    this.calls.push(request)
    if (this.calls.length === 1) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'context window exceeded', code: 'CONTEXT_OVERFLOW' } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'after compaction' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'after compaction' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('agent: context overflow triggers a compaction and retries the step', async () => {
  const session = new Session('overflow')
  add(session, 'user', 'old question ' + 'q'.repeat(200))
  add(session, 'assistant', 'old answer ' + 'a'.repeat(200))
  const model = new OverflowModel()
  const compaction = new Compaction({
    contextWindow: 100,
    thresholdRatio: 10,
    retainRatio: 0.01,
    minMessages: 1,
    maxToolResultChars: 1_000,
    summarizer: async () => 'overflow summary',
  })
  const agent = new Agent(session, model, new ToolRegistry(), { compaction })
  const result = await agent.run('new question')

  assert.equal(result.reason.kind, 'completed')
  assert.equal(model.calls.length, 2)
  assert.equal(session.deriveMessages().some(message => textOf(message).includes('overflow summary')), true)
  assert.equal(session.lastAssistantText(), 'after compaction')
})
