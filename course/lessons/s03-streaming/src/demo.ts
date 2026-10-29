/**
 * s03 demo：真实 DeepSeek 跑一轮，观察持久 stream、live 帧与重放。
 *
 * 运行：
 *   cd course/lessons/s03-streaming
 *   cp env.example .env   # 填入 DEEPSEEK_API_KEY
 *   node src/demo.ts
 */

import {
  Agent,
  createDeepSeekModel,
  defineTool,
  expandStream,
  Session,
  textOf,
  ToolRegistry,
} from './index.ts'
import type { AssistantStreamFrame, Message, SessionEvent } from './index.ts'

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
    const stream = event.type === 'assistant/message' || event.type === 'assistant/attempt'
      ? ` stream=${event.data.stream.length}`
      : ''
    console.log(`${marker} #${String(event.seq).padStart(2, '0')} ${event.type.padEnd(18)}${stream}`)
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

  const frames: AssistantStreamFrame[] = []
  const agent = new Agent(session, model, tools, {
    maxSteps: 6,
    onAssistantStream: frame => frames.push(frame),
  })
  console.log(`model: ${model.provider}/${model.model} (${model.baseUrl})`)
  const result = await agent.run('请使用 calc 工具计算 (12 + 30) * 2，然后只用一句话告诉我结果。')

  console.log('\n=== 事件日志（S = surface） ===')
  printEvents(session)

  console.log('\n=== 派生消息 ===')
  for (const message of session.deriveMessages()) console.log(`- ${roleSummary(message)}`)

  console.log('\n=== 持久 stream 与 live 帧 ===')
  const assistants = session.events.filter(
    (event): event is Extract<SessionEvent, { type: 'assistant/message' }> => event.type === 'assistant/message',
  )
  for (const event of assistants) {
    const expanded = expandStream(event.data.stream)
    const same = JSON.stringify(expanded.blocks) === JSON.stringify(event.data.message.content)
    console.log(`assistant #${event.seq}: blocks=${event.data.message.content.length} stream=${event.data.stream.length} expanded===message=${same}`)
    console.log('  usage:', event.data.usage)
    console.log('  first chunks:', event.data.stream.slice(0, 4).map(record => record.chunk.type).join(' → '))
  }
  console.log('live frames:', {
    start: frames.filter(frame => frame.type === 'start').length,
    chunk: frames.filter(frame => frame.type === 'chunk').length,
    end: frames.filter(frame => frame.type === 'end').length,
    last: frames.at(-1),
  })

  console.log('\n=== 重放 ===')
  const raw = JSON.parse(JSON.stringify(session.toJSON())) as { id: string; events: SessionEvent[] }
  const restored = Session.restore(raw.id, raw.events)
  const restoredAssistants = restored.events.filter(
    (event): event is Extract<SessionEvent, { type: 'assistant/message' }> => event.type === 'assistant/message',
  )
  console.log('derived equal:', JSON.stringify(restored.deriveMessages()) === JSON.stringify(session.deriveMessages()))
  console.log('stream equal:', JSON.stringify(restoredAssistants.map(event => event.data.stream))
    === JSON.stringify(assistants.map(event => event.data.stream)))

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
