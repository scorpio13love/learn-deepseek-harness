/**
 * s09 真实模型端到端测试：write → flush → close → open → fork。
 *
 * 没有 DEEPSEEK_API_KEY 时自动跳过：
 *   cp env.example .env   # 填入 key
 *   node --test tests/live.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Agent,
  createDeepSeekProvider,
  LlmRuntime,
  loadEnv,
  SessionStore,
  ToolRegistry,
} from '../src/index.ts'

loadEnv()
const hasKey = (process.env.DEEPSEEK_API_KEY ?? '').trim().length > 0

test('live: a real turn survives flush, reopen and fork', { skip: !hasKey, timeout: 180_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-s09-live-'))
  try {
    const store = new SessionStore(dir)
    const runtime = new LlmRuntime()
    runtime.register(createDeepSeekProvider())

    const handle = await store.create('live')
    handle.attach()
    const result = await new Agent(handle.session, runtime.createModel('deepseek', 'deepseek-flash'), new ToolRegistry())
      .run('用一句话说明持久化的作用。')
    assert.equal(result.reason.kind, 'completed')
    await handle.flush()
    const before = JSON.stringify(handle.session.deriveMessages())
    await handle.close()

    const reopened = await store.open('live')
    assert.equal(JSON.stringify(reopened.session.deriveMessages()), before)
    assert.equal(reopened.session.events.length, handle.session.events.length)
    await reopened.close()

    const child = await store.fork('live', 'live-child')
    assert.equal(child.header.parentSession, 'live')
    assert.equal(child.header.isSeeded, true)
    assert.equal(child.session.events.at(-1)?.type, 'session/end-seed')
    await child.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
