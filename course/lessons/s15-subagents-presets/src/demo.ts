/**
 * s14 · subagents / presets：沿用前序课程的实现（本课改动见 README）。
 */

import {
  createDeepSeekProvider,
  defineTool,
  LlmRuntime,
  LocalSubagentBackend,
  SubagentManager,
  ToolRegistry,
} from './index.ts'

async function main(): Promise<void> {
  const runtime = new LlmRuntime()
  runtime.register(createDeepSeekProvider())
  const model = runtime.createModel('deepseek', 'deepseek-flash')

  const tools = new ToolRegistry()
  tools.register(defineTool({
    name: 'calc',
    description: 'Evaluate a simple arithmetic expression.',
    parameters: { expression: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (args) => String(Function(`return (${args.expression})`)()),
    isConcurrencySafe: () => true,
  }))

  const manager = new SubagentManager({
    backend: new LocalSubagentBackend({ model, tools }),
    maxDepth: 2,
    maxActive: 2,
  })

  const result = await manager.spawn({
    task: '请使用 calc 工具计算 6*7，然后只回答数字。',
    parentSessionId: 'demo-parent',
    depth: 0,
    preset: { name: 'calculator', prompt: 'You are a calculator specialist.', toolNames: ['calc'] },
  })
  console.log('child:', result.childId)
  console.log('depth:', result.depth)
  console.log('answer:', result.answer)

  try {
    await manager.spawn({ task: 'x', parentSessionId: 'p', depth: 2 })
  } catch (error) {
    console.log('expected:', error instanceof Error ? error.message : String(error))
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
