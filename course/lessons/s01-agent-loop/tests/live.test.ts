/**
 * s01 真实模型端到端测试（唯一会访问网络的测试）。
 *
 * 没有 DEEPSEEK_API_KEY 时自动跳过；设置后运行：
 *   cd course/lessons-v3/s01-agent-loop
 *   cp env.example .env   # 填入 key
 *   node --test tests/live.test.ts
 *
 * 本课只验证最小文本 loop：一次 turn、一个 step、没有工具调用。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Agent,
  createDeepSeekModel,
  loadEnv,
  Session,
  ToolRegistry,
} from '../src/index.ts'
import type { SessionEvent } from '../src/index.ts'

loadEnv()
const hasKey = (process.env.DEEPSEEK_API_KEY ?? '').trim().length > 0

function eventsOf<T extends SessionEvent['type']>(
  session: Session,
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return session.events.filter(
    (event): event is Extract<SessionEvent, { type: T }> => event.type === type,
  )
}

test('live: a plain text prompt completes exactly one step', { skip: !hasKey, timeout: 120_000 }, async () => {
  const session = new Session()
  const agent = new Agent(session, createDeepSeekModel(), new ToolRegistry())

  const result = await agent.run('Reply with exactly the word "pong" and nothing else.')

  assert.equal(result.reason.kind, 'completed')
  assert.equal(result.steps, 1)
  assert.match((session.lastAssistantText() ?? '').toLowerCase(), /pong/)

  assert.equal(eventsOf(session, 'tool/call').length, 0)
  assert.equal(eventsOf(session, 'turn/start').length, 1)
  assert.equal(eventsOf(session, 'turn/end').length, 1)
  assert.equal(session.events.at(-1)?.type, 'turn/end')
  assert.deepEqual(session.deriveMessages().map(message => message.role), ['user', 'assistant'])
})
