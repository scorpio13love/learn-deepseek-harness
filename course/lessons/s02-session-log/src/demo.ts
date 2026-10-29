/**
 * s02 demo：真实 DeepSeek 跑一轮，然后演示日志、surface replace 与重放。
 *
 * 运行：
 *   cd course/lessons/s02-session-log
 *   cp env.example .env   # 填入 DEEPSEEK_API_KEY
 *   node src/demo.ts
 */

import {
  Agent,
  createDeepSeekModel,
  createTextMessage,
  defineTool,
  Session,
  textOf,
  ToolRegistry,
} from './index.ts'
import type { Message, SessionEvent } from './index.ts'

function evaluate(expression: string): number {
  let index = 0
  const input = expression
  const skip = (): void => { while (input[index] === ' ') index += 1 }
  const number = (): number => {
    skip()
    const start = index
    while (index < input.length && /[0-9.]/.test(input[index] ?? '')) index += 1
    if (start === index) throw new Error(`expected number at ${index}`)
    return Number(input.slice(start, index))
  }
  const factor = (): number => {
    skip()
    if (input[index] === '(') { index += 1; const value = expr(); skip(); if (input[index] !== ')') throw new Error('expected ")"'); index += 1; return value }
    if (input[index] === '-') { index += 1; return -factor() }
    return number()
  }
  const term = (): number => {
    let value = factor()
    while (true) {
      skip()
      const op = input[index]
      if (op !== '*' && op !== '/') return value
      index += 1
      const right = factor()
      value = op === '*' ? value * right : value / right
    }
  }
  const expr = (): number => {
    let value = term()
    while (true) {
      skip()
      const op = input[index]
      if (op !== '+' && op !== '-') return value
      index += 1
      const right = term()
      value = op === '+' ? value + right : value - right
    }
  }
  const value = expr()
  skip()
  if (index !== input.length) throw new Error(`unexpected character "${input[index]}"`)
  return value
}

function roleSummary(message: Message): string {
  if (message.role === 'tool') return `tool(${message.toolCallId ?? '?'}): ${textOf(message)}`
  if (message.role === 'assistant') {
    const calls = message.content.filter(block => block.type === 'tool-call')
    const suffix = calls.length > 0 ? ` [calls: ${calls.map(call => call.name).join(', ')}]` : ''
    return `assistant: ${textOf(message)}${suffix}`
  }
  return `${message.role}: ${textOf(message)}`
}

function printEvents(session: Session): void {
  const surface = new Set(session.surfaceSeqs)
  for (const event of session.events) {
    const marker = surface.has(event.seq) ? 'S' : ' '
    console.log(`${marker} #${String(event.seq).padStart(2, '0')} ${event.type.padEnd(18)} ${event.surfaceOp === undefined ? '' : JSON.stringify(event.surfaceOp)}`)
  }
}

async function main(): Promise<void> {
  const model = createDeepSeekModel()
  const session = new Session()
  const tools = new ToolRegistry()

  tools.register(defineTool({
    name: 'calc',
    description: 'Evaluate an arithmetic expression with + - * / and parentheses.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
    run(args) {
      try {
        return { content: [{ type: 'text', text: String(evaluate((args as { expression: string }).expression)) }], isError: false }
      } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true }
      }
    },
  }))

  const agent = new Agent(session, model, tools, { maxSteps: 6 })
  console.log(`model: ${model.provider}/${model.model} (${model.baseUrl})`)
  const result = await agent.run('请使用 calc 工具计算 (12 + 30) * 2，然后只用一句话告诉我结果。')

  console.log('\n=== 事件日志（S = 进入 surface） ===')
  printEvents(session)

  console.log('\n=== 从日志派生的消息 ===')
  for (const message of session.deriveMessages()) console.log(`- ${roleSummary(message)}`)

  console.log('\n=== request/header（只记录变化） ===')
  console.log(JSON.stringify(session.requestHeader(), null, 2))
  console.log('request/context:', session.requestContext())

  const raw = JSON.parse(JSON.stringify(session.toJSON())) as { id: string; events: SessionEvent[] }
  const restored = Session.restore(raw.id, raw.events)
  console.log('\n=== 导出 / 重放 ===')
  console.log(`raw events: ${session.events.length}, surface: ${session.surfaceSeqs.length}, derived: ${session.deriveMessages().length}`)
  console.log('restored===live:', JSON.stringify(restored.deriveMessages()) === JSON.stringify(session.deriveMessages()))

  const start = restored.surfaceSeqs[0]
  const end = restored.surfaceSeqs.at(-1)
  if (start === undefined || end === undefined) throw new Error('no surface nodes to replace')
  const summary = createTextMessage('user', `（压缩摘要）用户请求做一次计算，最终结果见原日志。`)
  restored.append('user/message', { message: summary }, {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: [...restored.surfaceSeqs],
  })

  console.log('\n=== surface replace（压缩） ===')
  console.log(`after: raw events ${restored.events.length}, surface ${restored.surfaceSeqs.length}, derived ${restored.deriveMessages().length}`)
  console.log('derived now:', restored.deriveMessages().map(roleSummary))
  console.log('原始 assistant 仍在 events 里:', restored.events.some(event => event.type === 'assistant/message'))
  console.log('contentGeneration:', restored.contentGeneration)

  console.log('\n=== 结果 ===')
  console.log('reason:', result.reason)
  console.log('steps :', result.steps)
  console.log('answer:', session.lastAssistantText())

  if (result.reason.kind === 'error') {
    console.error('模型调用失败：', result.reason.failure)
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
