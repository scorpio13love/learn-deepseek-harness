/**
 * s01 离线单元测试：最小 agent loop。
 *
 * 覆盖：
 *   - 一次纯文本 turn 的 turn/end 事件序列；
 *   - StreamAssembler 的流式组装、交错块、取消前缀；
 *   - surface append：只有消息事件进入派生历史；
 *   - 事件日志重放（restore 后继续下一轮）；
 *   - 失败也以 turn/end 收口。
 *
 * 全部用本地 ScriptedModel，不访问网络，不需要 API key。
 *
 * 运行：
 *   cd course/lessons-v3/s01-agent-loop
 *   node --test tests/s01.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Agent,
  createMessage,
  createTextMessage,
  Session,
  StreamAssembler,
  textOf,
  ToolRegistry,
} from '../src/index.ts'
import type {
  ChatRequest,
  Model,
  SessionEvent,
  StreamChunk,
} from '../src/index.ts'

// ---------------------------------------------------------------------------
// 测试用模型：按脚本逐块产出流，不访问网络
// ---------------------------------------------------------------------------

class ScriptedModel implements Model {
  readonly provider = 'test'
  readonly model = 'test-model'
  readonly requests: ChatRequest[] = []
  #chunks: readonly StreamChunk[]
  #onChunk: ((chunk: StreamChunk, index: number) => void) | undefined

  constructor(
    chunks: readonly StreamChunk[],
    onChunk?: (chunk: StreamChunk, index: number) => void,
  ) {
    this.#chunks = chunks
    this.#onChunk = onChunk
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    let index = 0
    for (const chunk of this.#chunks) {
      yield chunk
      this.#onChunk?.(chunk, index)
      index += 1
    }
  }
}

const textChunks: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Hello, ' },
  { type: 'text-delta', index: 0, text: 'world' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello, world' } },
  { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

function eventsOf<T extends SessionEvent['type']>(
  session: Session,
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return session.events.filter(
    (event): event is Extract<SessionEvent, { type: T }> => event.type === type,
  )
}

function eventTypes(session: Session): string[] {
  return session.events.map(event => event.type)
}

// ---------------------------------------------------------------------------
// 文本 turn / end
// ---------------------------------------------------------------------------

test('loop: one text turn opens and closes with turn/start → turn/end', async () => {
  const session = new Session('text-turn')
  const model = new ScriptedModel(textChunks)
  const agent = new Agent(session, model, new ToolRegistry())

  const result = await agent.run('say hello')

  assert.equal(result.reason.kind, 'completed')
  assert.equal(result.steps, 1)
  assert.equal(textOf(result.finalMessage!), 'Hello, world')
  assert.equal(session.lastAssistantText(), 'Hello, world')

  assert.deepEqual(eventTypes(session), [
    'turn/start',
    'step/start',
    'user/message',
    'request/header',
    'assistant/message',
    'step/end',
    'turn/end',
  ])

  assert.equal(eventsOf(session, 'turn/start')[0]?.data.turn, 1)
  assert.equal(eventsOf(session, 'turn/end')[0]?.data.reason.kind, 'completed')
  assert.equal(eventsOf(session, 'assistant/message')[0]?.data.message.interrupted, undefined)
  assert.deepEqual(eventsOf(session, 'assistant/message')[0]?.data.usage, {
    inputTokens: 12,
    outputTokens: 3,
  })

  // 请求历史从日志派生，且本课没有工具声明。
  assert.deepEqual(session.deriveMessages().map(message => message.role), ['user', 'assistant'])
  assert.deepEqual(session.deriveMessages().map(textOf), ['say hello', 'Hello, world'])
  assert.equal(model.requests.length, 1)
  assert.deepEqual(model.requests[0]?.messages.map(message => message.role), ['user'])
  assert.deepEqual(model.requests[0]?.tools, [])
})

test('loop: a model-side finish error becomes turn/end error, not a thrown exception', async () => {
  const session = new Session('error-turn')
  const failure = { message: 'upstream exploded', code: 'UPSTREAM' }
  const model = new ScriptedModel([{ type: 'finish', reason: { kind: 'error', failure } }])
  const agent = new Agent(session, model, new ToolRegistry())

  const result = await agent.run('fail please')

  assert.deepEqual(result.reason, { kind: 'error', failure })
  assert.equal(eventsOf(session, 'assistant/attempt')[0]?.data.failure.code, 'UPSTREAM')
  assert.equal(eventsOf(session, 'turn/end')[0]?.data.reason.kind, 'error')
  assert.equal(session.deriveMessages().length, 1) // 只有 user，没有 assistant
})

// ---------------------------------------------------------------------------
// 流式 assembler
// ---------------------------------------------------------------------------

test('assembler: interleaved reasoning/text blocks are ordered by index', () => {
  const assembler = new StreamAssembler()
  assembler.push({ type: 'block-start', index: 0, blockType: 'reasoning' })
  assembler.push({ type: 'reasoning-delta', index: 0, text: 'think ' })
  assembler.push({ type: 'block-start', index: 1, blockType: 'text' })
  assembler.push({ type: 'text-delta', index: 1, text: 'answer' })
  assembler.push({ type: 'reasoning-delta', index: 0, text: 'more' })
  assembler.push({ type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } })
  assembler.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think more' } })
  assembler.push({ type: 'finish', reason: { kind: 'stop' } })

  assert.deepEqual(assembler.blocks(), [
    { type: 'reasoning', text: 'think more' },
    { type: 'text', text: 'answer' },
  ])
  assert.equal(assembler.finished?.reason.kind, 'stop')
})

test('assembler: deltas are enough when block-end never arrives', () => {
  const assembler = new StreamAssembler()
  assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
  assembler.push({ type: 'text-delta', index: 0, text: 'he' })
  assembler.push({ type: 'text-delta', index: 0, text: 'llo' })
  assembler.push({ type: 'block-start', index: 1, blockType: 'tool-call' })
  assembler.push({
    type: 'tool-call-delta',
    index: 1,
    id: 'c1',
    name: 'calc',
    argumentsDelta: '{"expression":"1+1"}',
  })

  assert.deepEqual(assembler.blocks(), [
    { type: 'text', text: 'hello' },
    { type: 'tool-call', id: 'c1', name: 'calc', arguments: '{"expression":"1+1"}' },
  ])
  // 取消时只保留用户已经看到的可见前缀，未完成的工具调用不进入历史。
  assert.deepEqual(assembler.partialBlocks(), [{ type: 'text', text: 'hello' }])
})

// ---------------------------------------------------------------------------
// 取消：保留已交付前缀
// ---------------------------------------------------------------------------

test('cancel: an aborted stream keeps the delivered prefix and closes the turn', async () => {
  const session = new Session('cancel-turn')
  const controller = new AbortController()
  const model = new ScriptedModel(
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'partial ' },
      { type: 'text-delta', index: 0, text: 'must not appear' },
    ],
    (_chunk, index) => {
      // 在第一个 text-delta 交付之后取消，模拟用户中途按 Esc。
      if (index === 1) controller.abort()
    },
  )
  const agent = new Agent(session, model, new ToolRegistry())

  const result = await agent.run('long answer', { signal: controller.signal })

  assert.deepEqual(result.reason, { kind: 'aborted', reason: 'user' })
  assert.equal(textOf(result.finalMessage!), 'partial ')

  const assistant = eventsOf(session, 'assistant/message')
  assert.equal(assistant.length, 1)
  assert.equal(assistant[0]?.data.interrupted, true)
  assert.equal(textOf(assistant[0]!.data.message), 'partial ')
  assert.equal(session.lastAssistantText(), 'partial ')

  // 取消也要保证 step/end 与 turn/end 存在，顺序不乱。
  assert.deepEqual(eventTypes(session).slice(-2), ['step/end', 'turn/end'])
  assert.equal(eventsOf(session, 'turn/end')[0]?.data.reason.kind, 'aborted')
  // 已交付前缀仍进入派生历史，下一轮请求能看到它。
  assert.deepEqual(session.deriveMessages().map(textOf), ['long answer', 'partial '])
})

// ---------------------------------------------------------------------------
// surface append：只有消息事件进入模型可见历史
// ---------------------------------------------------------------------------

test('surface: appending message events grows the derived surface in order', () => {
  const session = new Session('surface-append')

  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', { message: createTextMessage('user', 'first') })
  assert.deepEqual(session.deriveMessages().map(textOf), ['first'])

  // 日志事实（turn/step/header/tool）会增长事件数组，但不进入 surface。
  session.append('request/header', { provider: 'test', model: 'test-model', tools: [] })
  session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'calc', arguments: '{}' })
  assert.deepEqual(session.deriveMessages().map(textOf), ['first'])
  assert.equal(session.events.length, 5)

  session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'second' }] }),
  })
  session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [] }),
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'text', text: 'third' }],
    }),
  })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  // 空 assistant 留在日志里，但不追加到 surface。
  assert.equal(eventsOf(session, 'assistant/message').length, 2)
  assert.deepEqual(session.deriveMessages().map(textOf), ['first', 'second', 'third'])
  assert.deepEqual(
    session.deriveMessages().map(message => message.role),
    ['user', 'assistant', 'tool'],
  )
  assert.deepEqual(
    session.events.map(event => event.seq),
    Array.from({ length: session.events.length }, (_value, index) => index),
  )
})

// ---------------------------------------------------------------------------
// 重放
// ---------------------------------------------------------------------------

test('replay: restore rebuilds the surface and a new agent continues at turn 2', async () => {
  const session = new Session('replay')
  const first = new ScriptedModel(textChunks)
  await new Agent(session, first, new ToolRegistry()).run('q1')

  const persisted = JSON.parse(JSON.stringify(session.events)) as SessionEvent[]
  const restored = Session.restore(session.id, persisted)

  assert.deepEqual(restored.deriveMessages(), session.deriveMessages())
  assert.equal(restored.lastTurn, 1)
  assert.equal(restored.lastSeq, session.lastSeq)
  assert.equal(restored.events.length, session.events.length)

  const second = new ScriptedModel(textChunks)
  const result = await new Agent(restored, second, new ToolRegistry()).run('q2')

  assert.equal(result.reason.kind, 'completed')
  assert.deepEqual(eventsOf(restored, 'turn/start').map(event => event.data.turn), [1, 2])
  assert.deepEqual(
    restored.deriveMessages().map(textOf),
    ['q1', 'Hello, world', 'q2', 'Hello, world'],
  )
  // 第二轮请求看到上一轮派生出的 assistant 历史。
  assert.deepEqual(second.requests[0]?.messages.map(message => message.role), ['user', 'assistant', 'user'])
})
