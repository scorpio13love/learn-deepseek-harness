/**
 * s09 demo：JSONL 持久化 → 重开 → 截断尾部修复 → fork。
 *
 * 运行：
 *   cd course/lessons/s09-persistence
 *   cp env.example .env   # 填入 DEEPSEEK_API_KEY
 *   node src/demo.ts
 */

import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Agent,
  createDeepSeekProvider,
  LlmRuntime,
  SessionStore,
  textOf,
  ToolRegistry,
} from './index.ts'

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-s09-'))
  const store = new SessionStore(dir)
  const id = `demo-${Date.now()}`

  const runtime = new LlmRuntime()
  runtime.register(createDeepSeekProvider())
  const model = runtime.createModel('deepseek', 'deepseek-flash')

  const handle = await store.create(id, { cwd: process.cwd() })
  handle.attach()
  console.log('store:', dir)
  console.log('session:', handle.header)

  const session = handle.session
  const agent = new Agent(session, model, new ToolRegistry())
  const result = await agent.run('用一句话解释 JSONL 持久化。')
  await handle.flush()

  console.log('\n=== 写入 ===')
  console.log('reason:', result.reason)
  console.log('events:', session.events.length)
  console.log('derived:', session.deriveMessages().map(message => `${message.role}:${textOf(message)}`))
  console.log('answer:', session.lastAssistantText())
  await handle.close()

  const reopened = await store.open(id)
  console.log('\n=== 重开 ===')
  console.log('header:', reopened.header)
  console.log('events:', reopened.session.events.length)
  console.log('derived equal:', JSON.stringify(reopened.session.deriveMessages()) === JSON.stringify(session.deriveMessages()))
  await reopened.close()

  // 模拟崩溃留下的半行：最后一行不是合法 JSON。
  await appendFile(handle.path, '{"type":"turn/start"')
  const repaired = await store.open(id)
  console.log('\n=== 截断尾部修复 ===')
  console.log('events after repair:', repaired.session.events.length)
  console.log('last event:', repaired.session.events.at(-1)?.type)
  await repaired.close()

  const child = await store.fork(id, `${id}-fork`)
  console.log('\n=== fork ===')
  console.log('child header:', child.header)
  console.log('child events:', child.session.events.map(event => event.type))
  console.log('child derived:', child.session.deriveMessages().map(message => message.role))
  await child.close()

  await rm(dir, { recursive: true, force: true })
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
