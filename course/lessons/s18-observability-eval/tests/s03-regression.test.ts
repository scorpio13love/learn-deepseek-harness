/**
 * s03 离线测试：assembler、持久 stream、attempt 结算、取消前缀、重放。
 *
 * 不需要 API key。真实模型端到端在 live.test.ts。
 *
 * 测试里的 Model 只用于注入传输失败/取消，不是课程使用的模型实现；
 * demo 和 live 测试始终走真实 DeepSeek。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Agent,
  AssistantStreamAttempt,
  createMessage,
  createTextMessage,
  expandStream,
  Session,
  StreamAssembler,
  textOf,
  ToolRegistry,
} from '../src/index.ts'
import type {
  ChatRequest,
  ContentBlock,
  Model,
  SessionEvent,
  StreamChunk,
  TimedStreamChunk,
} from '../src/index.ts'

function eventsOf<T extends SessionEvent['type']>(
  session: Session,
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return session.events.filter(
    (event): event is Extract<SessionEvent, { type: T }> => event.type === type,
  )
}

const TEXT_CHUNKS: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hello' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

function timed(chunks: readonly StreamChunk[]): TimedStreamChunk[] {
  return chunks.map((chunk, index) => ({ time: 1_000 + index, chunk }))
}

test('assembler: reasoning, text and tool calls keep block order', () => {
  const assembler = new StreamAssembler()
  assembler.push({ type: 'block-start', index: 0, blockType: 'reasoning' })
  assembler.push({ type: 'reasoning-delta', index: 0, text: 'think' })
  assembler.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } })
  assembler.push({ type: 'block-start', index: 1, blockType: 'text' })
  assembler.push({ type: 'text-delta', index: 1, text: 'hello ' })
  assembler.push({ type: 'text-delta', index: 1, text: 'world' })
  assembler.push({ type: 'block-end', index: 1, block: { type: 'text', text: 'hello world' } })
  assembler.push({ type: 'block-start', index: 2, blockType: 'tool-call' })
  assembler.push({ type: 'tool-call-delta', index: 2, id: 'c1', name: 'calc', argumentsDelta: '{"expr' })
  assembler.push({ type: 'tool-call-delta', index: 2, id: 'c1', name: 'calc', argumentsDelta: 'ession":"1+1"}' })
  assembler.push({
    type: 'block-end',
    index: 2,
    block: { type: 'tool-call', id: 'c1', name: 'calc', arguments: '{"expression":"1+1"}' },
  })
  assembler.push({ type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } })
  assembler.push({ type: 'finish', reason: { kind: 'tool-calls' } })

  assert.deepEqual(assembler.blocks(), [
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'hello world' },
    { type: 'tool-call', id: 'c1', name: 'calc', arguments: '{"expression":"1+1"}' },
  ])
  assert.deepEqual(assembler.usage, { inputTokens: 10, outputTokens: 2 })
  assert.equal(assembler.finished?.reason.kind, 'tool-calls')
})

test('assembler: synthesizes blocks from deltas; partial blocks drop tool calls', () => {
  const assembler = new StreamAssembler()
  assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
  assembler.push({ type: 'text-delta', index: 0, text: 'he' })
  assembler.push({ type: 'text-delta', index: 0, text: 'llo' })
  assembler.push({ type: 'block-start', index: 1, blockType: 'tool-call' })
  assembler.push({ type: 'tool-call-delta', index: 1, id: 'c1', name: 'calc', argumentsDelta: '{}' })

  assert.deepEqual(assembler.blocks(), [
    { type: 'text', text: 'hello' },
    { type: 'tool-call', id: 'c1', name: 'calc', arguments: '{}' },
  ])
  assert.deepEqual(assembler.partialBlocks(), [{ type: 'text', text: 'hello' }])
})

test('expandStream: durable records rebuild the same blocks, usage and finish', () => {
  const records = timed([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hello' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])

  const expanded = expandStream(records)
  assert.deepEqual(expanded.blocks, [{ type: 'text', text: 'hello' }])
  assert.deepEqual(expanded.usage, { inputTokens: 3, outputTokens: 1 })
  assert.equal(expanded.finish?.reason.kind, 'stop')
})

test('attempt: start/chunk/end frames and durable stream', () => {
  const frames: string[] = []
  const attempt = new AssistantStreamAttempt({
    attemptId: 'a1',
    turn: 2,
    step: 3,
    onFrame: frame => frames.push(frame.type),
  })

  attempt.start()
  for (const chunk of TEXT_CHUNKS) attempt.push(chunk)
  attempt.settle('committed', 'assistant/message')

  assert.deepEqual(frames, ['start', 'chunk', 'chunk', 'chunk', 'chunk', 'end'])
  assert.equal(attempt.ended, true)
  assert.equal(attempt.stream.length, 4)
  assert.deepEqual(attempt.blocks, [{ type: 'text', text: 'hello' }])
  assert.equal(Object.isFrozen(attempt.stream[0]), true)
  assert.deepEqual(expandStream(attempt.stream).blocks, [{ type: 'text', text: 'hello' }])
})

test('attempt: interrupted prefix keeps text but not an unfinished tool call', () => {
  const attempt = new AssistantStreamAttempt({ attemptId: 'a2', turn: 1, step: 1 })
  attempt.start()
  attempt.push({ type: 'block-start', index: 0, blockType: 'text' })
  attempt.push({ type: 'text-delta', index: 0, text: 'partial' })
  attempt.push({ type: 'block-start', index: 1, blockType: 'tool-call' })
  attempt.push({ type: 'tool-call-delta', index: 1, id: 'c1', name: 'calc', argumentsDelta: '{"a"' })

  assert.deepEqual(attempt.partialBlocks, [{ type: 'text', text: 'partial' }])
  assert.equal(attempt.stream.length, 4)
})

test('session: assistant/message requires a stream and survives replay', () => {
  const session = new Session('stream-replay')
  const message = createMessage({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] })
  session.append('assistant/message', {
    message,
    stream: timed(TEXT_CHUNKS),
    usage: { inputTokens: 5, outputTokens: 1 },
  }, { surfaceOp: 'append' })

  const raw = JSON.parse(JSON.stringify(session.toJSON())) as { id: string; events: SessionEvent[] }
  const restored = Session.restore(raw.id, raw.events)
  const event = eventsOf(restored, 'assistant/message')[0]!

  assert.deepEqual(restored.deriveMessages().map(textOf), ['hello'])
  assert.deepEqual(expandStream(event.data.stream).blocks, message.content)
  assert.deepEqual(event.data.usage, { inputTokens: 5, outputTokens: 1 })
})

test('session: assistant/attempt keeps its stream but never enters history', () => {
  const session = new Session('attempt')
  session.append('assistant/attempt', {
    turn: 1,
    step: 1,
    failure: { message: 'boom', code: 'X' },
    stream: timed([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'half' },
    ]),
  })

  assert.deepEqual(session.deriveMessages(), [])
  const event = eventsOf(session, 'assistant/attempt')[0]!
  assert.equal(event.data.stream.length, 2)
  assert.deepEqual(expandStream(event.data.stream).blocks, [{ type: 'text', text: 'half' }])
})

test('session: replay rejects an assistant event without stream', () => {
  const session = new Session('missing-stream')
  session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }),
    stream: timed(TEXT_CHUNKS),
  }, { surfaceOp: 'append' })

  const raw = JSON.parse(JSON.stringify(session.events)) as Record<string, unknown>[]
  delete (raw[0]!.data as { stream?: unknown }).stream
  assert.throws(
    () => Session.restore('bad', raw as unknown as SessionEvent[]),
    /has no stream array/,
  )
})

class FailingTransport implements Model {
  readonly provider = 'test'
  readonly model = 'failing'

  async *stream(_request: ChatRequest): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'half' }
    throw new Error('transport exploded')
  }
}

test('agent: a transport failure settles an attempt with its stream', async () => {
  const session = new Session('agent-error')
  const result = await new Agent(session, new FailingTransport(), new ToolRegistry()).run('hi')

  assert.equal(result.reason.kind, 'error')
  const attempt = eventsOf(session, 'assistant/attempt')[0]!
  assert.equal(attempt.data.failure.message, 'transport exploded')
  assert.equal(attempt.data.stream.length, 2)
  assert.deepEqual(session.deriveMessages().map(textOf), ['hi'])
  assert.equal(eventsOf(session, 'turn/end')[0]?.data.reason.kind, 'error')
})

class AbortingTransport implements Model {
  readonly provider = 'test'
  readonly model = 'aborting'
  readonly controller = new AbortController()

  async *stream(_request: ChatRequest): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'partial' }
    this.controller.abort()
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } }
  }
}

test('agent: cancellation settles an interrupted assistant message', async () => {
  const session = new Session('agent-abort')
  const model = new AbortingTransport()
  const result = await new Agent(session, model, new ToolRegistry()).run('hi', {
    signal: model.controller.signal,
  })

  assert.equal(result.reason.kind, 'aborted')
  const assistant = eventsOf(session, 'assistant/message')[0]!
  assert.equal(assistant.data.interrupted, true)
  assert.deepEqual(expandStream(assistant.data.stream).blocks, [{ type: 'text', text: 'partial' }])
  assert.deepEqual(session.deriveMessages().map(textOf), ['hi', 'partial'])
})

test('agent: live frames start before chunks and end after the durable event', async () => {
  const frames: string[] = []
  const session = new Session('frames')
  const lastEventAtEnd: string[] = []
  const agent = new Agent(session, new FailingTransport(), new ToolRegistry(), {
    onAssistantStream: (frame) => {
      frames.push(frame.type)
      if (frame.type === 'end') lastEventAtEnd.push(session.events.at(-1)?.type ?? 'none')
    },
  })

  await agent.run('hi')

  assert.deepEqual(frames, ['start', 'chunk', 'chunk', 'end'])
  // end 帧在 attempt 持久化之后、step/end 之前发布。
  assert.equal(lastEventAtEnd[0], 'assistant/attempt')
})

test('attempt records are JSON-serializable and frozen', () => {
  const attempt = new AssistantStreamAttempt({ attemptId: 'a3', turn: 1, step: 1 })
  attempt.start()
  for (const chunk of TEXT_CHUNKS) attempt.push(chunk)
  const json = JSON.parse(JSON.stringify(attempt.stream)) as TimedStreamChunk[]
  assert.deepEqual(json, attempt.stream)
  assert.equal(Object.isFrozen(attempt.stream[0]!.chunk), true)
})

// 防止未使用告警：ContentBlock 用于类型断言时的可读性。
const _contentTypeCheck: ContentBlock[] = []
void _contentTypeCheck
