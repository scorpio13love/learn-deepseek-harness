/**
 * s01 真实模型端到端测试。
 *
 * 没有 DEEPSEEK_API_KEY 时自动跳过；设置后运行：
 *   cd course/lessons/s01-agent-loop
 *   cp env.example .env   # 填入 key
 *   node --test tests/live.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Agent,
  createDeepSeekModel,
  defineTool,
  loadEnv,
  Session,
  textOf,
  ToolRegistry,
} from '../src/index.ts'
import type { SessionEvent, ToolResult } from '../src/index.ts'

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

test('live: plain chat completes one step', { skip: !hasKey, timeout: 120_000 }, async () => {
  const session = new Session()
  const agent = new Agent(session, createDeepSeekModel(), new ToolRegistry())

  const result = await agent.run('Reply with exactly the word "pong" and nothing else.')

  assert.equal(result.reason.kind, 'completed')
  assert.equal(result.steps, 1)
  assert.match((session.lastAssistantText() ?? '').toLowerCase(), /pong/)
  assert.equal(eventsOf(session, 'tool/call').length, 0)
  assert.equal(eventsOf(session, 'turn/end').length, 1)
})

test('live: the model calls calc, sees the result and answers', { skip: !hasKey, timeout: 120_000 }, async () => {
  const session = new Session()
  const tools = new ToolRegistry()

  tools.register(defineTool({
    name: 'calc',
    description: 'Evaluate an arithmetic expression with + - * / and parentheses.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'The expression to evaluate.' },
      },
      required: ['expression'],
    },
    run(args): ToolResult {
      const { expression } = args as { expression: string }
      // 测试只接受这个表达式；真实工具可以换成更完整的求值器。
      if (expression.replace(/\s+/g, '') !== '6*7') {
        return { content: [{ type: 'text', text: 'Error: unsupported expression' }], isError: true }
      }
      return { content: [{ type: 'text', text: '42' }], isError: false }
    },
  }))

  const agent = new Agent(session, createDeepSeekModel(), tools, { maxSteps: 6 })
  const result = await agent.run(
    'Use the calc tool exactly once to compute 6 * 7. Then reply with only the numeric result.',
  )

  assert.equal(result.reason.kind, 'completed')
  const calls = eventsOf(session, 'tool/call')
  assert.equal(calls.length >= 1, true)
  assert.equal(calls[0]?.data.name, 'calc')

  const results = eventsOf(session, 'tool/result')
  assert.equal(results.length >= 1, true)
  assert.equal(textOf(results[0]!.data.message), '42')
  assert.match(session.lastAssistantText() ?? '', /42/)

  // 第二次请求必须看到 assistant 的工具调用 + tool 结果。
  const roles = session.deriveMessages().map(message => message.role)
  assert.deepEqual(roles.slice(0, 3), ['user', 'assistant', 'tool'])
})
