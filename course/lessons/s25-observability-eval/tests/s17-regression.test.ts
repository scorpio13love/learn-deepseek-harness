/** s17 离线测试：JSON-RPC framing + SdkServer。 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'

import { JsonRpcPeer, SdkServer } from '../src/index.ts'
import type { ChatRequest, Model, StreamChunk } from '../src/index.ts'

class TestModel implements Model {
  readonly provider = 'test'
  readonly model = 'm'
  async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const text = request.messages.at(-1)?.content.find(block => block.type === 'text')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: `echo:${text?.type === 'text' ? text.text : ''}` }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function pair() {
  const c2s = new PassThrough()
  const s2c = new PassThrough()
  const client = new JsonRpcPeer(s2c, c2s)
  const server = new JsonRpcPeer(c2s, s2c)
  return { client, server }
}

test('jsonrpc: request/response and unknown method', async () => {
  const { client, server } = pair()
  server.onRequest('add', (params) => {
    const input = params as { a: number; b: number }
    return input.a + input.b
  })
  assert.equal(await client.request('add', { a: 2, b: 3 }), 5)
  await assert.rejects(async () => client.request('nope'), /unknown method/)
  client.close()
})

test('jsonrpc: notifications are delivered', async () => {
  const { client, server } = pair()
  const seen: unknown[] = []
  server.onNotification('ping', params => seen.push(params))
  client.notify('ping', { n: 1 })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(seen, [{ n: 1 }])
  client.close()
})

test('sdk: create session, prompt, stream events', async () => {
  const { client, server } = pair()
  new SdkServer(server, () => new TestModel())
  const events: Array<{ sessionId: string; event: { type: string } }> = []
  client.onNotification('session/event', params => events.push(params as typeof events[number]))

  const created = await client.request('session/create', { id: 's1' }) as { sessionId: string }
  assert.equal(created.sessionId, 's1')
  const result = await client.request('prompt', { sessionId: 's1', text: 'hello' }) as { answer: string; reason: string }
  assert.equal(result.reason, 'completed')
  assert.equal(result.answer, 'answer')
  assert.equal(events.some(item => item.event.type === 'user/message'), true)
  assert.equal(events.some(item => item.event.type === 'assistant/message'), true)
  client.close()
})
