/** s16 离线测试：projection 与 SSE 快照/增量。 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMessage, createTextMessage, Session, SessionProjection, SessionWebServer } from '../src/index.ts'

test('projection: folds messages, status, turn and usage', () => {
  const session = new Session('p')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', { message: createTextMessage('user', 'hi') }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }),
    stream: [],
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  const projection = new SessionProjection(session)
  assert.equal(projection.snapshot.status, 'running')
  assert.equal(projection.snapshot.turn, 1)
  assert.deepEqual(projection.snapshot.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 })
  assert.equal(projection.snapshot.messages.length, 2)

  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(projection.snapshot.status, 'idle')
  projection.dispose()
})

test('web: snapshot endpoint and SSE replay/live', async () => {
  const session = new Session('web')
  const projection = new SessionProjection(session)
  const server = new SessionWebServer(session, projection)
  const { url } = await server.start(0)
  try {
    session.append('turn/start', { turn: 1 })
    const snapshot = await fetch(`${url}/api/session`).then(response => response.json()) as { seq: number; status: string }
    assert.equal(snapshot.seq, 0)
    assert.equal(snapshot.status, 'running')

    const controller = new AbortController()
    const response = await fetch(`${url}/api/events?since=-1`, { signal: controller.signal })
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const readUntil = async (needle: string): Promise<string> => {
      while (!buffer.includes(needle)) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
      }
      return buffer
    }

    assert.match(await readUntil('turn/start'), /turn\/start/)
    session.append('user/message', { message: createTextMessage('user', 'live') }, { surfaceOp: 'append' })
    assert.match(await readUntil('user/message'), /user\/message/)
    controller.abort()
  } finally {
    await server.close()
    projection.dispose()
  }
})
