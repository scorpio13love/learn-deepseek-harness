/** s24 离线测试：投影、错误卡、审批卡、增量/快照一致性。 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { demoEvents, orphanResultEvents } from '../src/demo.ts'
import { cardsToHtml, escapeHtml } from '../src/html.ts'
import { applyEvent, CardProjection, EMPTY_PROJECTION, project, toView } from '../src/projection.ts'
import type { ActionCard, SessionEvent } from '../src/types.ts'

function find(cards: readonly ActionCard[], id: string): ActionCard {
  const card = cards.find(item => item.id === id)
  assert.ok(card, `card ${id} missing`)
  return card
}

test('projection: successful tool call and result merge into one card', () => {
  const state = project(demoEvents())
  const card = find(state.cards, 'tool:call-read-1')

  assert.equal(card.kind, 'tool-call')
  assert.equal(card.status, 'succeeded')
  assert.equal(card.title, '工具 · read_file')
  assert.equal(card.payload.name, 'read_file')
  assert.deepEqual(card.payload.args, { path: 'src/app.ts' })
  assert.deepEqual(card.payload.result, {
    ok: true,
    output: 'export function main() { /* TODO: ... */ }',
  })
  assert.equal(state.cards.filter(item => item.kind === 'tool-result').length, 0)
})

test('error card: code, retryable and detail survive serialization', () => {
  const state = project(demoEvents())
  const error = find(state.cards, 'error:8')

  assert.equal(error.kind, 'error')
  assert.equal(error.status, 'failed')
  assert.equal(error.title, '错误 · RATE_LIMITED')
  assert.match(error.summary, /频繁/)
  assert.equal(error.payload.retryable, true)
  assert.deepEqual(error.payload.detail, { status: 429, retryAfterMs: 2_000 })

  const roundTrip = JSON.parse(JSON.stringify(state)) as typeof state
  assert.deepEqual(roundTrip, state)
})

test('approval card: pending -> denied, with the decision recorded', () => {
  const events = demoEvents()
  const pending = project(events.slice(0, 5)) // 到 approval/request 为止
  const card = find(pending.cards, 'approval:approval-1')

  assert.equal(card.kind, 'approval')
  assert.equal(card.status, 'pending')
  assert.equal(card.payload.decision, null)
  assert.equal(card.payload.callId, 'call-write-1')

  const resolved = project(events)
  const denied = find(resolved.cards, 'approval:approval-1')
  assert.equal(denied.status, 'denied')
  assert.equal(denied.payload.decision, 'denied')
  assert.equal(denied.summary, '用户拒绝')
})

test('approval card: allowed-once is terminal success', () => {
  const events: SessionEvent[] = [
    {
      type: 'approval/request', seq: 1, at: 1, turn: 1,
      approvalId: 'a1', toolName: 'write_file', summary: 'write audit.md', args: { path: 'audit.md' },
    },
    { type: 'approval/resolve', seq: 2, at: 2, approvalId: 'a1', decision: 'allowed-once' },
  ]
  const card = find(project(events).cards, 'approval:a1')
  assert.equal(card.status, 'succeeded')
  assert.equal(card.summary, '已允许一次')
})

test('incremental projection equals one-shot snapshot', () => {
  const events = [...demoEvents(), ...orphanResultEvents()]
  const oneShot = project(events)
  const incremental = new CardProjection()
  incremental.pushAll(events)

  assert.deepEqual(incremental.state, oneShot)
  assert.deepEqual(toView(incremental.state), toView(oneShot))
})

test('text deltas append to the same card and finish on done', () => {
  const events: SessionEvent[] = [
    { type: 'assistant/text', seq: 1, at: 1, messageId: 'm', text: 'Hello' },
    { type: 'assistant/text', seq: 2, at: 2, messageId: 'm', text: ', ' },
    { type: 'assistant/text', seq: 3, at: 3, messageId: 'm', text: 'world', done: true },
  ]
  const card = find(project(events).cards, 'text:m')
  assert.equal(card.payload.text, 'Hello, world')
  assert.equal(card.status, 'succeeded')
  assert.equal(card.seq, 3)
})

test('orphan tool result becomes a tool-result card instead of disappearing', () => {
  const state = project(orphanResultEvents())
  assert.equal(state.cards.length, 2)

  const ok = find(state.cards, 'result:call-read-orphan')
  assert.equal(ok.kind, 'tool-result')
  assert.equal(ok.status, 'succeeded')
  assert.equal(ok.payload.orphan, true)

  const failed = find(state.cards, 'result:call-bash-orphan')
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.payload.output, { exitCode: 1, stderr: 'permission denied' })
})

test('turn/end cancels running tools but completes streaming text', () => {
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 1, at: 1, turn: 1 },
    { type: 'assistant/text', seq: 2, at: 2, messageId: 'm', text: 'working' },
    { type: 'tool/call', seq: 3, at: 3, turn: 1, callId: 'c', name: 'bash', args: { command: 'sleep 10' } },
    { type: 'turn/end', seq: 4, at: 4, turn: 1 },
  ]
  const state = project(events)
  assert.equal(find(state.cards, 'text:m').status, 'succeeded')
  assert.equal(find(state.cards, 'tool:c').status, 'cancelled')
  assert.equal(state.status, 'idle')
})

test('unknown events return the same state reference', () => {
  const state = project(demoEvents())
  const unknown = { type: 'future/thing', seq: 999, at: 999 } as unknown as SessionEvent
  assert.equal(applyEvent(state, unknown), state)
})

test('empty projection is stable', () => {
  assert.deepEqual(project([]), EMPTY_PROJECTION)
  assert.deepEqual(new CardProjection().state, EMPTY_PROJECTION)
})

test('html: escapes user text and marks card kind/status', () => {
  const state = project([
    {
      type: 'assistant/text', seq: 1, at: 1, messageId: 'x',
      text: '<script>alert("x")</script>', done: true,
    },
  ])
  const html = cardsToHtml(state.cards)
  assert.match(html, /data-kind="text"/)
  assert.match(html, /data-status="succeeded"/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;')
})
