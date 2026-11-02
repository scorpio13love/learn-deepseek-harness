/**
 * s01 的 demo：一个会调用计算器工具的 agent，使用真实 DeepSeek 模型。
 *
 * 第一次运行：
 *   cd course/lessons/s01-agent-loop
 *   cp env.example .env
 *   # 编辑 .env，填入 DEEPSEEK_API_KEY
 *   node src/demo.ts
 *
 * 观察三件事：
 * 1. 日志里的事件顺序（turn → step → assistant → tool/call → tool/result → step → turn）；
 * 2. 第二次模型请求看到的历史包含 assistant 的工具调用和 tool 结果；
 * 3. 最终回答来自日志的派生，而不是某个隐藏的变量。
 */

import {
  Agent,
  createDeepSeekModel,
  defineTool,
  Session,
  textOf,
  ToolRegistry,
} from './index.ts'
import type { Message } from './types.ts'

/** 一个只支持 + - * / 和括号的递归下降求值器，避免 eval。 */
function evaluate(expression: string): number {
  let index = 0
  const input = expression

  function skip(): void {
    while (input[index] === ' ') index += 1
  }

  function parseNumber(): number {
    skip()
    const start = index
    while (index < input.length && /[0-9.]/.test(input[index] ?? '')) index += 1
    if (start === index) throw new Error(`expected number at ${index}`)
    const value = Number(input.slice(start, index))
    if (!Number.isFinite(value)) throw new Error(`invalid number "${input.slice(start, index)}"`)
    return value
  }

  function parseFactor(): number {
    skip()
    if (input[index] === '(') {
      index += 1
      const value = parseExpr()
      skip()
      if (input[index] !== ')') throw new Error(`expected ")" at ${index}`)
      index += 1
      return value
    }
    if (input[index] === '-') {
      index += 1
      return -parseFactor()
    }
    return parseNumber()
  }

  function parseTerm(): number {
    let value = parseFactor()
    while (true) {
      skip()
      const op = input[index]
      if (op !== '*' && op !== '/') return value
      index += 1
      const right = parseFactor()
      value = op === '*' ? value * right : value / right
    }
  }

  function parseExpr(): number {
    let value = parseTerm()
    while (true) {
      skip()
      const op = input[index]
      if (op !== '+' && op !== '-') return value
      index += 1
      const right = parseTerm()
      value = op === '+' ? value + right : value - right
    }
  }

  const value = parseExpr()
  skip()
  if (index !== input.length) throw new Error(`unexpected character "${input[index]}"`)
  return value
}

function roleSummary(message: Message): string {
  if (message.role === 'tool') return `tool(${message.toolCallId ?? '?'}): ${textOf(message)}`
  if (message.role === 'assistant') {
    const calls = message.content.filter(block => block.type === 'tool-call')
    const suffix = calls.length > 0
      ? ` [calls: ${calls.map(call => call.name).join(', ')}]`
      : ''
    return `assistant: ${textOf(message)}${suffix}`
  }
  return `${message.role}: ${textOf(message)}`
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
      properties: {
        expression: { type: 'string', description: 'The expression to evaluate.' },
      },
      required: ['expression'],
    },
    run(args) {
      const { expression } = args as { expression: string }
      try {
        return {
          content: [{ type: 'text', text: String(evaluate(expression)) }],
          isError: false,
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        }
      }
    },
  }))

  const agent = new Agent(session, model, tools, { maxSteps: 6 })
  console.log(`model: ${model.provider}/${model.model} (${model.baseUrl})`)

  const result = await agent.run('请使用 calc 工具计算 (12 + 30) * 2，然后只用一句话告诉我结果。')

  console.log('\n=== 事件日志 ===')
  for (const event of session.events) {
    const detail = event.type === 'assistant/message'
      ? `content=${event.data.message.content.length} 块`
      : event.type === 'tool/call'
        ? `${event.data.name}(${event.data.arguments})`
        : event.type === 'tool/result'
          ? textOf(event.data.message)
          : ''
    console.log(`#${String(event.seq).padStart(2, '0')} ${event.type.padEnd(18)} ${detail}`)
  }

  console.log('\n=== 从日志派生的消息 ===')
  for (const message of session.deriveMessages()) {
    console.log(`- ${roleSummary(message)}`)
  }

  console.log('\n=== 结果 ===')
  console.log('reason:', result.reason)
  console.log('steps :', result.steps)
  console.log('answer:', session.lastAssistantText())

  const usage = session.events
    .filter(event => event.type === 'assistant/message' && event.data.usage !== undefined)
    .map(event => event.type === 'assistant/message' ? event.data.usage : undefined)
  if (usage.length > 0) console.log('usage :', usage)

  if (result.reason.kind === 'error') {
    console.error('\n模型调用失败：', result.reason.failure)
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
