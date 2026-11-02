/**
 * s16 demo：让模型写一段程序，通过 PTC runtime 调用 calc。
 *
 *   cd course/lessons-v3/s16-ptc
 *   cp env.example .env    # 可选；没有 key 也能离线跑
 *   node src/demo.ts
 *
 * 有 key：真实 DeepSeek 生成 JS 代码，demo 提取 ```js 代码块并执行。
 * 无 key：执行同一段离线程序，演示 runtime 的调用记录与结构化结果。
 *
 * 重点观察：
 *   1. 模型只看到一次请求/一次结果，中间两次 calc 的值不进入上下文；
 *   2. runtime 记录了每次 tools.calc(...) 的参数、结果和耗时；
 *   3. program 里的异常/超时会变成 `result.error`，而不是把进程打挂。
 */

import type { DeepSeekClient } from './deepseek.ts'
import { tryCreateDeepSeekClient } from './index.ts'
import { PtcRuntime } from './ptc.ts'
import { createCalcTool, ToolRegistry } from './tools.ts'

const OFFLINE_PROGRAM = `const sum = await tools.calc({ expression: '12 + 30' })
console.log('first call returned', sum)
return await tools.calc({ expression: \`\${sum} * 2\` })`

const SYSTEM_PROMPT = [
  'You write short JavaScript programs for a PTC (programmatic tool calling) runtime.',
  'The program is the body of an async function: it may use top-level await and must return a value.',
  'Call tools with tools.<name>(args). The only available tool is calc({ expression: string }).',
  'Use calc twice: first compute 12 + 30, then multiply that result by 2.',
  'Reply with exactly one fenced ```js code block and nothing else. Do not use console.',
].join('\n')

/** 从模型回复中提取一个 fenced code block；没有 fence 时退回整段文本。 */
export function extractProgram(text: string): string {
  const fenced = /```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)```/i.exec(text)
  const code = (fenced?.[1] ?? text).trim()
  if (code.length === 0) throw new Error('model returned an empty program')
  return code
}

async function generateProgram(client: DeepSeekClient): Promise<string> {
  const completion = await client.complete([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Write the program now.' },
  ])
  console.log(`model: ${client.provider}/${client.model}`)
  console.log('usage:', completion.usage)
  return extractProgram(completion.text)
}

async function main(): Promise<void> {
  const tools = new ToolRegistry()
  tools.register(createCalcTool())
  const runtime = new PtcRuntime({ tools, timeoutMs: 10_000 })

  const client = tryCreateDeepSeekClient()
  let program: string
  if (client === undefined) {
    console.log('no DEEPSEEK_API_KEY — running the offline program instead.\n')
    program = OFFLINE_PROGRAM
  } else {
    program = await generateProgram(client)
  }

  console.log('=== model-written program ===')
  console.log(program)

  const result = await runtime.run(program, { timeoutMs: 10_000 })

  console.log('\n=== tool calls ===')
  for (const call of result.calls) {
    const status = call.ok ? 'ok' : `error(${call.error?.kind})`
    console.log(`- ${call.tool}(${JSON.stringify(call.args)}) -> ${JSON.stringify(call.value)} ${status} ${call.durationMs}ms`)
  }

  if (result.logs.length > 0) {
    console.log('\n=== console output ===')
    for (const line of result.logs) console.log(line)
  }

  console.log('\n=== result ===')
  console.log('ok      :', result.ok)
  console.log('value   :', result.value)
  console.log('duration:', `${result.durationMs}ms`)
  if (result.error !== undefined) {
    console.error('error   :', result.error)
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
