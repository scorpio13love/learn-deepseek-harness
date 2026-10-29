/**
 * s04 真实模型端到端测试：typed tool、header 声明、stream、重放、surface replace。
 *
 * 没有 DEEPSEEK_API_KEY 时自动跳过：
 *   cp env.example .env   # 填入 key
 *   node --test tests/live.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Agent,
  createDeepSeekModel,
  createTextMessage,
  defineTool,
  expandStream,
  loadEnv,
  Session,
  textOf,
  ToolRegistry,
} from '../src/index.ts'
import type { AssistantStreamFrame, SessionEvent } from '../src/index.ts'

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

test('live: a tool turn records header/context, replays, and can be compacted', { skip: !hasKey, timeout: 180_000 }, async () => {
  const session = new Session()
  const tools = new ToolRegistry()

  tools.register(defineTool({
    name: 'calc',
    description: 'Evaluate an arithmetic expression with + - * / and parentheses.',
    parameters: {
      expression: { type: 'string', required: true, description: 'The expression to evaluate.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args) {
      if (args.expression.replace(/\s+/g, '') !== '6*7') throw new Error('unsupported expression')
      return '42'
    },
  }))

  const frames: AssistantStreamFrame[] = []
  const agent = new Agent(session, createDeepSeekModel(), tools, {
    maxSteps: 6,
    onAssistantStream: frame => frames.push(frame),
  })
  const result = await agent.run(
    'Use the calc tool exactly once to compute 6 * 7. Then reply with only the numeric result.',
  )

  assert.equal(result.reason.kind, 'completed')
  assert.equal(result.steps >= 2, true)

  const calls = eventsOf(session, 'tool/call')
  assert.equal(calls.length >= 1, true)
  const results = eventsOf(session, 'tool/result')
  assert.equal(textOf(results[0]!.data.message), '42')

  const assistants = eventsOf(session, 'assistant/message')
  assert.equal(assistants.length >= 1, true)
  for (const assistant of assistants) {
    assert.equal(assistant.data.stream.length > 0, true)
    assert.deepEqual(expandStream(assistant.data.stream).blocks, assistant.data.message.content)
    assert.deepEqual(expandStream(assistant.data.stream).usage, assistant.data.usage)
  }

  assert.equal(frames[0]?.type, 'start')
  assert.equal(frames.some(frame => frame.type === 'chunk'), true)
  const lastFrame = frames.at(-1)
  assert.equal(lastFrame?.type, 'end')
  if (lastFrame?.type === 'end') assert.equal(lastFrame.outcome, 'committed')

  const header = session.requestHeader()
  assert.equal(header?.config.provider, 'deepseek')
  assert.equal(typeof header?.config.model, 'string')
  assert.equal(header?.tools.some(tool => tool.name === 'calc'), true)
  assert.equal(eventsOf(session, 'request/header').length, 1)

  const context = session.requestContext()
  assert.equal(context?.provider, 'deepseek')
  assert.equal(typeof context?.model, 'string')
  assert.equal(eventsOf(session, 'request/context').length, 1)

  const raw = JSON.parse(JSON.stringify(session.toJSON())) as { id: string; events: SessionEvent[] }
  const restored = Session.restore(raw.id, raw.events)
  assert.deepEqual(restored.deriveMessages(), session.deriveMessages())
  assert.deepEqual(restored.surfaceSeqs, session.surfaceSeqs)
  assert.deepEqual(restored.requestHeader(), session.requestHeader())

  const start = restored.surfaceSeqs[0]
  const end = restored.surfaceSeqs.at(-1)
  assert.notEqual(start, undefined)
  assert.notEqual(end, undefined)
  const beforeEvents = restored.events.length
  const summary = createTextMessage('user', '（压缩摘要）这一轮调用 calc 得到了 42。')
  restored.append('user/message', { message: summary }, {
    surfaceOp: { op: 'replace', startSeq: start!, endSeq: end! },
    sourceEventSeqs: [...restored.surfaceSeqs],
  })

  assert.equal(restored.surfaceSeqs.length, 1)
  assert.equal(restored.deriveMessages().length, 1)
  assert.equal(textOf(restored.deriveMessages()[0]!), '（压缩摘要）这一轮调用 calc 得到了 42。')
  assert.equal(restored.events.length, beforeEvents + 1)
  assert.equal(restored.events.some(event => event.type === 'assistant/message'), true)
})
