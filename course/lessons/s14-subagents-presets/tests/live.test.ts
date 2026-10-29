/**
 * s10 真实模型端到端测试：用真实 DeepSeek 摘要一段长历史。
 *
 * 没有 DEEPSEEK_API_KEY 时自动跳过：
 *   cp env.example .env   # 填入 key
 *   node --test tests/live.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Compaction,
  createDeepSeekProvider,
  createMessage,
  createTextMessage,
  LlmRuntime,
  loadEnv,
  Session,
  textOf,
} from '../src/index.ts'

loadEnv()
const hasKey = (process.env.DEEPSEEK_API_KEY ?? '').trim().length > 0

test('live: a real summary replaces an old span without deleting raw events', { skip: !hasKey, timeout: 180_000 }, async () => {
  const session = new Session('live-compaction')
  session.append('user/message', {
    message: createTextMessage('user', '请分析这份长日志并给出结论。'.repeat(20)),
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '我先读取日志，然后分析重试和恢复时间。'.repeat(20) }],
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read-log', arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'tool',
      toolCallId: 'c1',
      isError: false,
      content: [{ type: 'text', text: 'warning: retry storm\n'.repeat(100) }],
    }),
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: '日志显示重试风暴后恢复。' }] }),
    stream: [],
  }, { surfaceOp: 'append' })

  const rawBefore = session.events.length
  const runtime = new LlmRuntime()
  runtime.register(createDeepSeekProvider())
  const model = runtime.createModel('deepseek', 'deepseek-flash')
  const compaction = new Compaction({
    contextWindow: 500,
    thresholdRatio: 0.5,
    retainRatio: 0.1,
    minMessages: 2,
    maxToolResultChars: 100,
  })

  const result = await compaction.compact(session, model, new AbortController().signal)
  assert.equal(result.compacted, true)
  assert.equal(session.events.length > rawBefore, true)
  assert.equal(session.deriveMessages()[0]?.role, 'user')
  assert.match(textOf(session.deriveMessages()[0]!), /压缩摘要/)
  assert.equal(session.events.some(event => event.type === 'assistant/message'), true)
})
