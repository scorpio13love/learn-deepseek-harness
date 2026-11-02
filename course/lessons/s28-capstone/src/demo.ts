/** 离线 smoke：复制 fixtures/project，跑完整 capstone，不需要 key。 */

import { cp } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderEvalReport } from './eval.ts'
import { OfflineModel } from './offline.ts'
import { runCapstone } from './run.ts'
import { createClock } from './types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, '..', 'fixtures', 'project')

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const runId = `demo-${Date.now()}`
const outDir = resolve(argValue('--out') ?? join(here, '..', '.runs', runId))
const workspaceDir = join(outDir, 'workspace')

await cp(fixtures, workspaceDir, { recursive: true, force: true })

const result = await runCapstone({
  model: new OfflineModel(),
  workspace: workspaceDir,
  outDir,
  runId,
  now: createClock(1_700_000_000_000, 25),
  onEvent: event => {
    if (event.type === 'tool/call') console.log(`  #${event.seq} tool ${String(event.data.name)}`)
    if (event.type === 'approval/decision') console.log(`  #${event.seq} approval ${String(event.data.decision)}`)
    if (event.type === 'error') console.log(`  #${event.seq} error ${String(event.data.message)}`)
  },
})

console.log('\n--- surface ---')
console.log(JSON.stringify(result.surface, null, 2))
console.log('\n--- eval ---')
console.log(renderEvalReport(result.evalReport))
console.log('\n--- artifacts ---')
console.log(JSON.stringify(result.artifacts, null, 2))
console.log(`\naudit.md preview:\n${(result.audit ?? '(missing)').slice(0, 500)}`)

if (!result.evalReport.passed) process.exitCode = 1
