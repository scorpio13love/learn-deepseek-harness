/**
 * s02 离线测试：事件信封、surface append/replace、派生规则、重放校验。
 *
 * 不需要 API key。真实模型端到端在 live.test.ts。
 *
 * 运行：
 *   cd course/lessons/s02-session-log
 *   node --test tests/s02.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createMessage,
  createTextMessage,
  Session,
  textOf,
} from '../src/index.ts'
import type { EpochHeader, SessionEvent } from '../src/index.ts'

const HEADER: EpochHeader = {
  config: { provider: 'deepseek', model: 'deepseek-flash' },
  tools: [{
    name: 'calc',
    description: 'Calculate.',
    parameters: { type: 'object', properties: { expression: { type: 'string' } } },
  }],
}

function roles(session: Session): string[] {
  return session.deriveMessages().map(message => message.role)
}

function eventsOf<T extends SessionEvent['type']>(
  session: Session,
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return session.events.filter(
    (event): event is Extract<SessionEvent, { type: T }> => event.type === type,
  )
}

test('append: surface nodes drive derived history; log-only events do not', () => {
  const session = new Session('append')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', {
    message: createTextMessage('user', 'hi'),
  }, { surfaceOp: 'append' })
  session.append('request/header', { header: HEADER, reason: 'initial' })
  session.append('request/context', { provider: 'deepseek', model: 'deepseek-flash' })
  session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  assert.deepEqual(roles(session), ['user', 'assistant'])
  assert.deepEqual(session.surfaceSeqs, [2, 5])
  assert.deepEqual(session.requestHeader(), HEADER)
  assert.deepEqual(session.requestContext(), { provider: 'deepseek', model: 'deepseek-flash' })
  assert.equal(session.lastTurn, 1)
  assert.equal(session.lastSeq, 7)
})

test('append: surface intent is required and forbidden on log-only events', () => {
  const session = new Session('intent')
  const message = createTextMessage('user', 'x')

  assert.throws(
    () => session.append('user/message', { message }),
    /requires surfaceOp/,
  )
  assert.throws(
    () => session.append('turn/start', { turn: 1 }, { surfaceOp: 'append' }),
    /must not carry surfaceOp/,
  )
  assert.throws(
    () => session.append('tool/call', {
      turn: 1, step: 1, callId: 'c', name: 'calc', arguments: '{}',
    }, { sourceEventSeqs: [0] }),
    /must not carry sourceEventSeqs/,
  )
  assert.equal(session.events.length, 0)
})

test('surface replace: hides old nodes from history but keeps raw events', () => {
  const session = new Session('replace')
  const user = session.append('user/message', {
    message: createTextMessage('user', 'old question'),
  }, { surfaceOp: 'append' })
  const assistant = session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'old answer' }] }),
  }, { surfaceOp: 'append' })

  const before = session.deriveMessages()
  assert.deepEqual(before.map(textOf), ['old question', 'old answer'])

  const summary = session.append('user/message', {
    message: createTextMessage('user', 'summary of the old turn'),
  }, {
    surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: assistant.seq },
    sourceEventSeqs: [user.seq, assistant.seq],
  })

  assert.deepEqual(session.surfaceSeqs, [summary.seq])
  assert.deepEqual(session.deriveMessages().map(textOf), ['summary of the old turn'])
  assert.equal(session.events.length, 3)
  assert.equal(session.contentGeneration, 1)
  assert.equal(eventsOf(session, 'assistant/message').length, 1)
})

test('surface replace: range and source citations are validated', () => {
  const session = new Session('replace-invalid')
  const user = session.append('user/message', {
    message: createTextMessage('user', 'q'),
  }, { surfaceOp: 'append' })
  const assistant = session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'a' }] }),
  }, { surfaceOp: 'append' })
  const summary = createTextMessage('user', 'summary')

  assert.throws(
    () => session.append('user/message', { message: summary }, {
      surfaceOp: { op: 'replace', startSeq: 999, endSeq: 999 },
      sourceEventSeqs: [999],
    }),
    /invalid source seq/,
  )
  assert.throws(
    () => session.append('user/message', { message: summary }, {
      surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: assistant.seq },
      sourceEventSeqs: [user.seq],
    }),
    /must cite shadowed surface node/,
  )
  assert.throws(
    () => session.append('user/message', { message: summary }, {
      surfaceOp: { op: 'replace', startSeq: assistant.seq, endSeq: user.seq },
      sourceEventSeqs: [user.seq, assistant.seq],
    }),
    /invalid replace range/,
  )
  assert.throws(
    () => session.append('user/message', { message: summary }, {
      surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: assistant.seq },
      sourceEventSeqs: [user.seq, assistant.seq, user.seq],
    }),
    /duplicate source seq/,
  )
  assert.equal(session.events.length, 2)
  assert.deepEqual(roles(session), ['user', 'assistant'])
})

test('derive: empty system/developer/assistant nodes stay on surface but emit no message', () => {
  const session = new Session('derive-rules')
  session.append('system/message', {
    message: createMessage({ role: 'system', content: [] }),
  }, { surfaceOp: 'append' })
  session.append('developer/message', {
    message: createMessage({
      role: 'developer',
      content: [{ type: 'text', text: 'tool set changed' }],
    }),
  }, { surfaceOp: 'append' })
  session.append('user/message', {
    message: createTextMessage('user', 'q'),
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [] }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', {
    turn: 1, step: 1, callId: 'c', name: 'calc', arguments: '{}',
  })
  session.append('assistant/attempt', {
    turn: 1, step: 1, failure: { message: 'boom', code: 'X' },
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'tool',
      toolCallId: 'c',
      content: [{ type: 'text', text: '3' }],
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  assert.deepEqual(roles(session), ['developer', 'user', 'tool'])
  assert.equal(session.surfaceSeqs.length, 5)
})

test('request/header and request/context keep only the latest snapshot', () => {
  const session = new Session('headers')
  const second: EpochHeader = {
    config: { provider: 'deepseek', model: 'deepseek-v4-pro', maxTokens: 1024 },
    tools: [],
  }
  session.append('request/header', { header: HEADER, reason: 'initial' })
  session.append('request/context', { provider: 'deepseek', model: 'deepseek-flash', contextWindow: 1_000_000 })
  session.append('request/header', { header: second, reason: 'change' })
  session.append('request/context', { provider: 'deepseek', model: 'deepseek-v4-pro' })

  assert.deepEqual(session.requestHeader(), second)
  assert.deepEqual(session.requestContext(), { provider: 'deepseek', model: 'deepseek-v4-pro' })
  assert.deepEqual(roles(session), [])
})

test('append: non-JSON values are rejected before the log changes', () => {
  const session = new Session('json')
  const withUndefined = { provider: 'x', model: 'y', extra: undefined } as never
  const withDate = { provider: 'x', model: 'y', at: new Date() } as never
  const cyclic: Record<string, unknown> = { provider: 'x', model: 'y' }
  cyclic.self = cyclic

  assert.throws(() => session.append('request/context', withUndefined), /not JSON/)
  assert.throws(() => session.append('request/context', withDate), /plain object/)
  assert.throws(() => session.append('request/context', cyclic as never), /cycle/)
  assert.throws(() => session.append('request/context', {
    provider: 'x', model: 'y', contextWindow: Number.NaN,
  }), /finite number/)
  assert.equal(session.events.length, 0)
})

test('append: events and data are deeply frozen', () => {
  const session = new Session('freeze')
  const event = session.append('user/message', {
    message: createTextMessage('user', 'hi'),
  }, { surfaceOp: 'append' })
  assert.equal(Object.isFrozen(event), true)
  assert.equal(Object.isFrozen(event.data), true)
  assert.equal(Object.isFrozen(event.data.message), true)
  assert.equal(Object.isFrozen(event.data.message.content[0]), true)
})

test('ignorable survives append and replay', () => {
  const session = new Session('ignorable')
  const event = session.append('session/end-seed', { inherited: true }, { ignorable: true })
  assert.equal(event.ignorable, true)

  const restored = Session.restore(session.id, JSON.parse(JSON.stringify(session.events)) as SessionEvent[])
  assert.equal(restored.events[0]?.ignorable, true)
})

test('replay: restored session rebuilds the same surface, history, header and generation', () => {
  const session = new Session('replay')
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', {
    message: createTextMessage('user', 'q1'),
  }, { surfaceOp: 'append' })
  const assistant = session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'a1' }] }),
  }, { surfaceOp: 'append' })
  session.append('request/header', { header: HEADER, reason: 'initial' })
  session.append('request/context', { provider: 'deepseek', model: 'deepseek-flash' })
  session.append('user/message', {
    message: createTextMessage('user', 'summary'),
  }, {
    surfaceOp: { op: 'replace', startSeq: user.seq, endSeq: assistant.seq },
    sourceEventSeqs: [user.seq, assistant.seq],
  })
  session.append('user/message', {
    message: createTextMessage('user', 'q2'),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const raw = JSON.parse(JSON.stringify(session.toJSON())) as { id: string; events: SessionEvent[] }
  const restored = Session.restore(raw.id, raw.events)

  assert.deepEqual(restored.deriveMessages(), session.deriveMessages())
  assert.deepEqual(restored.surfaceSeqs, session.surfaceSeqs)
  assert.deepEqual(restored.requestHeader(), session.requestHeader())
  assert.deepEqual(restored.requestContext(), session.requestContext())
  assert.equal(restored.contentGeneration, session.contentGeneration)
  assert.equal(restored.lastTurn, 1)
})

test('replay: rejects seq gaps, unknown types and malformed surface metadata', () => {
  const session = new Session('bad')
  session.append('turn/start', { turn: 1 })
  session.append('user/message', {
    message: createTextMessage('user', 'q'),
  }, { surfaceOp: 'append' })
  const events = session.events

  assert.throws(
    () => Session.restore('gap', [events[0]!, events[1]!].map((event, index) => ({ ...event, seq: index === 1 ? 5 : event.seq }))),
    /expected 1/,
  )

  const unknown = JSON.parse(JSON.stringify(events[0])) as Record<string, unknown>
  unknown.type = 'unknown/event'
  assert.throws(() => Session.restore('unknown', [unknown as unknown as SessionEvent]), /unknown type/)

  const missingOp = JSON.parse(JSON.stringify(events[1])) as Record<string, unknown>
  delete missingOp.surfaceOp
  assert.throws(() => Session.restore('missing-op', [events[0]!, missingOp as unknown as SessionEvent]), /missing surfaceOp/)

  const badRole = JSON.parse(JSON.stringify(events[1])) as Record<string, unknown>
  ;(badRole.data as { message: { role: string } }).message.role = 'system'
  assert.throws(
    () => Session.restore('bad-role', [events[0]!, badRole as unknown as SessionEvent]),
    /requires role/,
  )

  const badRange = JSON.parse(JSON.stringify(events[1])) as Record<string, unknown>
  badRange.surfaceOp = { op: 'replace', startSeq: 999, endSeq: 999 }
  badRange.sourceEventSeqs = [999]
  assert.throws(
    () => Session.restore('bad-range', [events[0]!, badRange as unknown as SessionEvent]),
    /invalid source seq/,
  )
})

test('toJSON is losslessly serializable', () => {
  const session = new Session('json-out')
  session.append('request/header', { header: HEADER, reason: 'initial' })
  const json = JSON.parse(JSON.stringify(session.toJSON())) as { id: string; events: SessionEvent[] }
  assert.equal(json.id, 'json-out')
  assert.deepEqual(json.events, session.events)
})
