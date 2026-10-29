/**
 * s04 demo：typed schema、输出契约、scoped/条件工具。
 *
 * 运行：
 *   cd course/lessons/s04-tools
 *   cp env.example .env   # 填入 DEEPSEEK_API_KEY
 *   node src/demo.ts
 */

import {
  Agent,
  createDeepSeekModel,
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

async function main(): Promise<void> {
  const model = createDeepSeekModel()
  const session = new Session()
  const registry = new ToolRegistry()

  registry.register(defineTool({
    name: 'calc',
    description: 'Evaluate an arithmetic expression with + - * / and parentheses.',
    parameters: {
      expression: {
        type: 'string',
        required: true,
        description: 'The arithmetic expression to evaluate.',
        minLength: 1,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
      presentationMeta: (args, value) => ({ expression: args.expression, result: value }),
    },
    execute(args) {
      return String(evaluate(args.expression))
    },
  }))

  registry.register(defineTool({
    name: 'admin_stats',
    description: 'Return a fixed admin-only statistic.',
    parameters: {},
    output: {
      schema: { type: 'object', properties: { count: { type: 'integer' } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: `count=${value.count}` }],
    },
    execute: () => ({ count: 42 }),
  }), { scope: 'admin' })

  registry.register(defineTool({
    name: 'maintenance_only',
    description: 'Only available during maintenance.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => 'maintenance',
  }), { when: () => false })

  const signal = new AbortController().signal
  const resolved = await registry.resolve({ signal, scope: 'admin' })
  console.log('resolved tools:', resolved.names)
  console.log('schemas:', resolved.schemas().map(schema => schema.name))
  resolved.dispose()

  const agent = new Agent(session, model, registry, { maxSteps: 6, toolScope: 'admin' })
  console.log(`model: ${model.provider}/${model.model} (${model.baseUrl})`)
  const result = await agent.run('请使用 calc 工具计算 (12 + 30) * 2，然后只用一句话告诉我结果。')

  console.log('\n=== 事件日志 ===')
  for (const event of session.events) {
    const detail = event.type === 'tool/call'
      ? `${event.data.name}(${event.data.arguments})`
      : event.type === 'tool/result'
        ? `${textOf(event.data.message)} meta=${JSON.stringify((event as Extract<SessionEvent, { type: 'tool/result' }>).data.meta)}`
        : ''
    console.log(`#${String(event.seq).padStart(2, '0')} ${event.type.padEnd(18)} ${detail}`)
  }

  console.log('\n=== 派生消息 ===')
  for (const message of session.deriveMessages()) console.log(`- ${roleSummary(message)}`)

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
