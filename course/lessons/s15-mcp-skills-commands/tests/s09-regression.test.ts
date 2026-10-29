/**
 * s09 离线测试：JSONL 写入/重开、flush 屏障、截断修复、未闭合 turn、fork。
 *
 * 不需要 API key。真实模型端到端在 live.test.ts。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createMessage,
  createTextMessage,
  Session,
  SessionStore,
} from '../src/index.ts'

async function tempStore(): Promise<{ dir: string; store: SessionStore; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-s09-test-'))
  return {
    dir,
    store: new SessionStore(dir),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', { message: createTextMessage('user', text) }, { surfaceOp: 'append' })
}

function appendAssistant(session: Session, text: string): void {
  session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text }] }),
    stream: [],
  }, { surfaceOp: 'append' })
}

test('store: create/attach/flush/reopen roundtrip', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const handle = await store.create('s1', { cwd: '/tmp/work' })
    handle.attach()
    appendUser(handle.session, 'hello')
    appendAssistant(handle.session, 'world')
    await handle.flush()
    await handle.close()

    const reopened = await store.open('s1')
    assert.deepEqual(reopened.header, {
      version: 1,
      id: 's1',
      createdAt: reopened.header.createdAt,
      cwd: '/tmp/work',
    })
    assert.deepEqual(reopened.session.deriveMessages().map(message => message.role), ['user', 'assistant'])
    assert.equal(reopened.session.lastAssistantText(), 'world')
    await reopened.close()
  } finally {
    await cleanup()
  }
})

test('store: unflushed buffer is not durable', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const handle = await store.create('s2')
    handle.attach()
    appendUser(handle.session, 'lost?')
    // 不 flush：模拟崩溃前缓冲区未落盘。
    const opened = await store.open('s2')
    assert.equal(opened.session.events.length, 0)
    await opened.close()
    await handle.close()
  } finally {
    await cleanup()
  }
})

test('store: a torn tail is dropped and the file is rewritten', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const handle = await store.create('s3')
    handle.attach()
    appendUser(handle.session, 'ok')
    await handle.flush()
    await handle.close()

    await appendFile(handle.path, '{"type":"turn/start"')
    const repaired = await store.open('s3')
    assert.equal(repaired.session.events.length, 1)
    assert.equal(repaired.session.events[0]?.type, 'user/message')
    await repaired.close()

    const again = await store.open('s3')
    assert.equal(again.session.events.length, 1)
    await again.close()
  } finally {
    await cleanup()
  }
})

test('store: an unclosed turn is closed as interrupted and persists', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const handle = await store.create('s4')
    handle.attach()
    handle.session.append('turn/start', { turn: 1 })
    handle.session.append('step/start', { turn: 1, step: 1 })
    appendUser(handle.session, 'open')
    await handle.flush()
    await handle.close()

    const repaired = await store.open('s4')
    const last = repaired.session.events.at(-1)
    assert.equal(last?.type, 'turn/end')
    assert.equal(last?.type === 'turn/end' ? last.data.reason.kind : undefined, 'interrupted')
    await repaired.close()

    const again = await store.open('s4')
    assert.equal(again.session.events.at(-1)?.type, 'turn/end')
    assert.equal(again.session.events.filter(event => event.type === 'turn/end').length, 1)
    await again.close()
  } finally {
    await cleanup()
  }
})

test('store: a seq gap truncates the readable prefix', async () => {
  const { store, dir, cleanup } = await tempStore()
  try {
    await store.create('s5').then(handle => handle.close())
    const path = join(dir, 's5', 'session.jsonl')
    const header = (await readFile(path, 'utf8')).trim()
    const event = {
      type: 'user/message',
      seq: 5,
      time: Date.now(),
      data: { message: createTextMessage('user', 'gap') },
      surfaceOp: 'append',
    }
    await writeFile(path, `${header}\n${JSON.stringify(event)}\n`)
    const opened = await store.open('s5')
    assert.equal(opened.session.events.length, 0)
    await opened.close()
  } finally {
    await cleanup()
  }
})

test('store: fork copies the prefix, closes an open turn, and marks the seed', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const source = await store.create('source')
    source.attach()
    source.session.append('turn/start', { turn: 1 })
    source.session.append('step/start', { turn: 1, step: 1 })
    appendUser(source.session, 'branch me')
    await source.flush()
    await source.close()

    const child = await store.fork('source', 'child')
    assert.equal(child.header.parentSession, 'source')
    assert.equal(child.header.isSeeded, true)
    const events = child.session.events
    assert.equal(events.at(-1)?.type, 'session/end-seed')
    const closer = events.at(-2)
    assert.equal(closer?.type, 'turn/end')
    if (closer?.type === 'turn/end') assert.equal(closer.data.reason.kind, 'forked')
    assert.equal(child.session.deriveMessages().length, 1)
    await child.close()
  } finally {
    await cleanup()
  }
})

test('store: fork respects an explicit boundary and rejects invalid ones', async () => {
  const { store, cleanup } = await tempStore()
  try {
    const source = await store.create('source2')
    source.attach()
    source.session.append('turn/start', { turn: 1 })
    appendUser(source.session, 'one')
    source.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    source.session.append('turn/start', { turn: 2 })
    appendUser(source.session, 'two')
    await source.flush()
    await source.close()

    const child = await store.fork('source2', 'child2', 2)
    assert.equal(child.session.events.some(event => event.type === 'turn/end' && event.data.turn === 2), false)
    assert.equal(child.session.events.at(-1)?.type, 'session/end-seed')
    await child.close()

    await assert.rejects(async () => store.fork('source2', 'bad', 99), /outside the source log/)
  } finally {
    await cleanup()
  }
})

test('store: list returns readable session headers', async () => {
  const { store, cleanup } = await tempStore()
  try {
    await (await store.create('a')).close()
    await (await store.create('b')).close()
    const headers = await store.list()
    assert.deepEqual(headers.map(header => header.id), ['a', 'b'])
  } finally {
    await cleanup()
  }
})

test('store: a malformed header is rejected', async () => {
  const { store, dir, cleanup } = await tempStore()
  try {
    await store.create('broken').then(handle => handle.close())
    const path = join(dir, 'broken', 'session.jsonl')
    await writeFile(path, '{"type":"session/header","version":9,"id":"broken"}\n')
    await assert.rejects(async () => store.open('broken'), /invalid header/)
  } finally {
    await cleanup()
  }
})

test('session: onAppend listener can be detached', async () => {
  const session = new Session('listener')
  let count = 0
  const detach = session.onAppend(() => { count += 1 })
  appendUser(session, 'a')
  appendUser(session, 'b')
  detach()
  appendUser(session, 'c')
  assert.equal(count, 2)
})
