/** s18 离线测试：telemetry、record/replay、snapshot、fault。 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Agent,
  assertSnapshot,
  FaultModel,
  RecordingModel,
  ReplayModel,
  Session,
  snapshotSession,
  Telemetry,
  ToolRegistry,
  transcript,
} from '../src/index.ts'
import type { ChatRequest, Model, StreamChunk } from '../src/index.ts'

class Deterministic implements Model {
  readonly provider = 'test'
  readonly model = 'm'
  async *stream(_request: ChatRequest): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'hello' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('telemetry: spans nest and record events', () => {
  const t = new Telemetry()
  const root = t.start('turn', { turn: 1 })
  const child = t.start('llm', { model: 'm' })
  t.event(child, 'first-token')
  t.end(child)
  t.end(root)
  assert.equal(t.spans.length, 2)
  assert.equal(child.parentId, root.id)
  assert.equal(child.events[0]?.name, 'first-token')
  assert.equal(typeof child.end, 'number')
})

test('record/replay: same prompt produces the same snapshot', async () => {
  const records = new RecordingModel(new Deterministic())
  const first = new Session('record')
  await new Agent(first, records, new ToolRegistry()).run('hi')

  const replay = new ReplayModel(records.records, { provider: 'test', model: 'm' })
  const second = new Session('replay')
  await new Agent(second, replay, new ToolRegistry()).run('hi')

  assertSnapshot(snapshotSession(first), snapshotSession(second))
  assert.deepEqual(transcript(first.deriveMessages()), ['user:hi', 'assistant:hello'])
  assert.equal(records.records.length, 1)
})

test('fault: a terminal failure becomes an attempt and turn error', async () => {
  const session = new Session('fault')
  const result = await new Agent(session, new FaultModel({ message: 'rate limited', code: 'RATE_LIMITED' }), new ToolRegistry()).run('hi')
  assert.equal(result.reason.kind, 'error')
  assert.equal(session.events.some(event => event.type === 'assistant/attempt'), true)
  assert.equal(session.deriveMessages().length, 1)
})

test('snapshot: mismatch is loud and includes both sides', () => {
  const session = new Session('snap')
  session.append('user/message', { message: { id: 'm', role: 'user', content: [{ type: 'text', text: 'x' }] } }, { surfaceOp: 'append' })
  const snapshot = snapshotSession(session)
  assert.doesNotThrow(() => assertSnapshot(snapshot, snapshot))
  assert.throws(() => assertSnapshot(snapshot, { ...snapshot, events: [] }), /snapshot mismatch/)
})
