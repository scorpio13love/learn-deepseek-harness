/**
 * s07 demo：inject 不唤醒、start 后台运行、steer 在下一个步骤边界被消费。
 *
 * 运行：
 *   cd course/lessons/s04-tools
 *   cp env.example .env   # 填入 DEEPSEEK_API_KEY
 *   node src/demo.ts
 */

import {
  Agent,
  createDeepSeekModel,
  createTextMessage,
  defineTool,
  renderContexts,
  renderPrompt,
  Session,
  SystemPrompt,
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
    isConcurrencySafe: () => true,
  }))

  registry.register(defineTool({
    name: 'wait',
    description: 'Wait for a short time, then return waited.',
    parameters: { milliseconds: { type: 'integer', required: true, minimum: 1, maximum: 2000 } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (args) => {
      await new Promise(resolve => setTimeout(resolve, args.milliseconds))
      return 'waited'
    },
    isConcurrencySafe: () => true,
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

  registry.pipeline.usePre(async (exec, next) => {
    console.log('pre-execute:', exec.name, exec.args)
    return next()
  })
  registry.pipeline.usePost(async (exec, result, next) => {
    console.log('post-execute:', exec.name, result.isError ? 'error' : 'ok')
    return next()
  })
  registry.pipeline.onResult((exec, result) => {
    console.log('result:', exec.name, result.isError ? 'error' : 'ok')
  })

  const prompt = new SystemPrompt({ toolOrder: ['calc', '<unlisted-tools>'] })
  prompt.section({
    name: 'identity',
    order: -1000,
    text: 'You are an AI agent powered by DeepSeek Harness.',
  })
  prompt.section({
    name: 'persona',
    order: 0,
    text: 'You are terse. Answer in {{language}}.',
  })
  prompt.section({
    name: 'tool-guidance',
    order: 100,
    text: 'Prefer the calc tool for arithmetic. Never use eval.',
  })
  prompt.variable('language', 'Chinese')
  prompt.variable('cwd', process.cwd())
  prompt.context({
    name: 'workspace',
    order: 0,
    text: 'Current working directory: {{cwd}}',
    required: true,
  })

  const signal = new AbortController().signal
  const resolved = await registry.resolve({ signal, scope: 'admin' })
  const assembly = await prompt.assemble({
    modelSelection: { provider: model.provider, model: model.model },
    toolSet: resolved,
    signal,
  })
  console.log('resolved tools:', resolved.names)
  console.log('--- rendered prompt ---')
  console.log(renderPrompt(assembly))
  console.log('--- runtime contexts ---')
  console.log(renderContexts(assembly))
  resolved.dispose()

  const agent = new Agent(session, model, registry, {
    maxSteps: 6,
    toolScope: 'admin',
    prompt,
  })
  console.log(`model: ${model.provider}/${model.model} (${model.baseUrl})`)

  agent.inject(createTextMessage('user', '运行时上下文：这是 s07 的 steering demo。'))
  console.log('after inject:', agent.status, 'events=', session.events.length)

  agent.start('请先调用 wait 工具等待 600 毫秒，然后用一句话回答。')
  setTimeout(() => {
    agent.steer(createTextMessage('user', '补充：回答时请提到 steering 已经生效。'))
  }, 150)
  await agent.whenIdle()
  const result = agent.lastResult ?? { reason: { kind: 'completed' as const }, steps: 0 }

  console.log('\n=== 事件日志 ===')
  for (const event of session.events) {
    const detail = event.type === 'system/message'
      ? textOf(event.data.message)
      : event.type === 'tool/call'
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
  console.log('turns :', agent.turns)
  console.log('status:', agent.status)
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
