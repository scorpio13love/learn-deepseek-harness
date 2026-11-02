/** 真实 DeepSeek CLI：`node src/main.ts [--workspace DIR] [--out DIR]`。 */

import { cp } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DeepSeekModel } from './deepseek.ts'
import { loadEnvFile, readConfig } from './env.ts'
import { renderEvalReport } from './eval.ts'
import { runCapstone } from './run.ts'
import { createClock } from './types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, '..', 'fixtures', 'project')

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

await loadEnvFile(resolve(process.cwd(), '.env'))
const config = readConfig()

if (config.apiKey === undefined || config.apiKey.trim() === '') {
  console.error('DEEPSEEK_API_KEY is missing. Copy env.example to .env and fill it, or run `node src/demo.ts` for offline smoke.')
  process.exit(1)
}

const runId = `live-${Date.now()}`
const outDir = resolve(argValue('--out') ?? join(here, '..', '.runs', runId))
const workspaceDir = argValue('--workspace') === undefined
  ? join(outDir, 'workspace')
  : resolve(argValue('--workspace') as string)

if (argValue('--workspace') === undefined) {
  await cp(fixtures, workspaceDir, { recursive: true, force: true })
}

const model = new DeepSeekModel({
  apiKey: config.apiKey,
  baseUrl: config.baseUrl,
  model: argValue('--model') ?? config.model,
  maxTokens: config.maxTokens,
  timeoutMs: config.timeoutMs,
})

console.log(`model=${model.model} workspace=${workspaceDir} out=${outDir}`)

const result = await runCapstone({
  model,
  workspace: workspaceDir,
  outDir,
  runId,
  maxSteps: Number(argValue('--max-steps') ?? '8'),
  now: createClock(Date.now(), 100),
  onEvent: event => {
    if (event.type === 'tool/call') console.log(`#${event.seq} tool ${String(event.data.name)}`)
    if (event.type === 'approval/decision') console.log(`#${event.seq} approval ${String(event.data.decision)}`)
    if (event.type === 'error') console.log(`#${event.seq} error ${String(event.data.message)}`)
    if (event.type === 'assistant/text') console.log(`#${event.seq} text ${String(event.data.text).slice(0, 160)}`)
  },
})

console.log(`\n${renderEvalReport(result.evalReport)}`)
console.log('\nartifacts:')
console.log(JSON.stringify(result.artifacts, null, 2))
process.exitCode = result.evalReport.passed ? 0 : 1
