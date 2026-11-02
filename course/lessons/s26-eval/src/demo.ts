/** s26 demo：故障矩阵 + 一个“期望成功却失败”的报告。 */

import { ScenarioRunner, formatEvalReport, formatReport } from './runner.ts'
import type { Scenario } from './runner.ts'
import { RateLimitModel, faultMatrix } from './faults.ts'
import type { Tool } from './types.ts'

const failTool: Tool = {
  name: 'fail_tool',
  description: 'Always throws. Used to inject a tool failure.',
  parameters: { type: 'object', properties: { reason: { type: 'string' } } },
  run: () => {
    throw new Error('tool exploded while reading the workspace')
  },
}

const scenarios: Scenario[] = faultMatrix().map(item => ({
  id: `fault/${item.id}`,
  description: `inject ${item.id}`,
  prompt: 'do the task',
  createModel: item.createModel,
  ...item.kind === 'tool-error' ? { tools: [failTool] } : {},
  expect: item.kind === 'tool-error'
    ? { kind: 'tool-error' }
    : { kind: 'failure', failure: item.kind },
}))

const runner = new ScenarioRunner({ repeats: 2 })
const report = await runner.runAll(scenarios)
console.log(formatEvalReport(report))

const mismatch = await new ScenarioRunner({ repeats: 1 }).run({
  id: 'expect-ok-but-429',
  description: 'a regression that expects success but hits the rate limit',
  prompt: 'summarize the repo',
  createModel: () => new RateLimitModel(),
  expect: { kind: 'ok' },
})
console.log('\n--- failure report ---')
console.log(formatReport(mismatch))
