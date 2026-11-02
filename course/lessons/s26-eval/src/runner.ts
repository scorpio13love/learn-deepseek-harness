/** 可重复的 scenario runner：重复执行、快照一致性、声明式预期与报告。 */

import { runAgent } from './agent.ts'
import { diffSnapshots, formatDiff, snapshotRun } from './snapshot.ts'
import type { SnapshotDiff, RunSnapshot } from './snapshot.ts'
import type { Failure, FailureKind, Model, Tool } from './types.ts'
import { createClock } from './types.ts'

export type Expectation =
  | { kind: 'ok' }
  | { kind: 'failure'; failure: FailureKind }
  | { kind: 'tool-error' }

export interface Scenario {
  id: string
  description: string
  prompt: string
  createModel(): Model
  tools?: Tool[]
  maxSteps?: number
  /** 缺省是 { kind: 'ok' }。 */
  expect?: Expectation
}

export interface ScenarioRun {
  run: Awaited<ReturnType<typeof runAgent>>
  snapshot: RunSnapshot
}

export interface ScenarioMetrics {
  steps: number
  toolCalls: number
  toolErrors: number
  inputTokens: number
  outputTokens: number
}

export interface ScenarioReport {
  id: string
  description: string
  status: 'passed' | 'failed'
  expected: Expectation
  reason: string
  runs: ScenarioRun[]
  snapshot: RunSnapshot
  metrics: ScenarioMetrics
  failures: Failure[]
  diffs: SnapshotDiff[]
}

export interface EvalReport {
  total: number
  passed: number
  failed: number
  passRate: number
  scenarios: ScenarioReport[]
  failures: Array<{ id: string; reason: string }>
}

function matches(expectation: Expectation, run: ScenarioRun['run']): boolean {
  if (expectation.kind === 'ok') {
    return run.outcome.kind === 'ok' && run.failures.length === 0
  }
  if (expectation.kind === 'tool-error') {
    return run.failures.some(failure => failure.kind === 'tool-error')
  }
  return run.outcome.kind === 'error' && run.outcome.failure.kind === expectation.failure
}

function actualOf(run: ScenarioRun['run']): string {
  if (run.outcome.kind === 'error') return `failure ${run.outcome.failure.kind}`
  if (run.failures.length > 0) return `ok with failures [${run.failures.map(failure => failure.kind).join(', ')}]`
  return 'ok'
}

function expectedOf(expectation: Expectation): string {
  if (expectation.kind === 'failure') return `failure ${expectation.failure}`
  return expectation.kind
}

export class ScenarioRunner {
  #repeats: number
  #maxSteps: number

  constructor(options: { repeats?: number; maxSteps?: number } = {}) {
    this.#repeats = Math.max(1, options.repeats ?? 1)
    this.#maxSteps = options.maxSteps ?? 6
  }

  async run(scenario: Scenario): Promise<ScenarioReport> {
    const expectation = scenario.expect ?? { kind: 'ok' }
    const runs: ScenarioRun[] = []

    for (let repeat = 0; repeat < this.#repeats; repeat += 1) {
      const run = await runAgent({
        model: scenario.createModel(),
        prompt: scenario.prompt,
        ...scenario.tools === undefined ? {} : { tools: scenario.tools },
        maxSteps: scenario.maxSteps ?? this.#maxSteps,
        now: createClock(0, 10),
      })
      runs.push({ run, snapshot: snapshotRun(run) })
    }

    const first = runs[0]
    if (first === undefined) throw new Error(`scenario ${scenario.id} produced no runs`)
    const snapshot = first.snapshot

    const diffs: SnapshotDiff[] = []
    for (const candidate of runs.slice(1)) {
      diffs.push(...diffSnapshots(snapshot, candidate.snapshot))
    }

    const passedExpectation = matches(expectation, first.run)
    const consistent = diffs.length === 0
    const passed = passedExpectation && consistent

    const reason = !consistent
      ? `repeats diverged (${diffs.length} differences)`
      : passedExpectation
        ? 'ok'
        : `expected ${expectedOf(expectation)}, got ${actualOf(first.run)}`

    return {
      id: scenario.id,
      description: scenario.description,
      status: passed ? 'passed' : 'failed',
      expected: expectation,
      reason,
      runs,
      snapshot,
      metrics: metricsOf(first.run),
      failures: first.run.failures,
      diffs,
    }
  }

  async runAll(scenarios: readonly Scenario[]): Promise<EvalReport> {
    const reports: ScenarioReport[] = []
    for (const scenario of scenarios) reports.push(await this.run(scenario))
    const failed = reports.filter(report => report.status === 'failed')
    return {
      total: reports.length,
      passed: reports.length - failed.length,
      failed: failed.length,
      passRate: reports.length === 0 ? 1 : (reports.length - failed.length) / reports.length,
      scenarios: reports,
      failures: failed.map(report => ({ id: report.id, reason: report.reason })),
    }
  }

  get repeats(): number {
    return this.#repeats
  }

  get maxSteps(): number {
    return this.#maxSteps
  }
}

function metricsOf(run: ScenarioRun['run']): ScenarioMetrics {
  return {
    steps: run.steps,
    toolCalls: run.toolCalls.length,
    toolErrors: run.failures.filter(failure => failure.kind === 'tool-error').length,
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
  }
}

export function formatReport(report: ScenarioReport): string {
  const first = report.runs[0]
  const lines = [
    `[${report.status === 'passed' ? 'PASS' : 'FAIL'}] ${report.id} — ${report.description}`,
    `  expected: ${expectedOf(report.expected)}`,
    `  actual:   ${first === undefined ? 'no runs' : actualOf(first.run)}`,
    `  reason:   ${report.reason}`,
  ]
  if (report.failures.length > 0) {
    lines.push(`  failures: ${report.failures.map(failure => `${failure.kind}: ${failure.message}`).join(' | ')}`)
  }
  if (report.diffs.length > 0) {
    lines.push('  diff:')
    lines.push(formatDiff(report.diffs))
  }
  return lines.join('\n')
}

export function formatEvalReport(report: EvalReport): string {
  const header = `eval: ${report.passed}/${report.total} passed (${Math.round(report.passRate * 100)}%)`
  const rows = report.scenarios.map(scenario => formatReport(scenario))
  const failureRows = report.failures.length === 0
    ? []
    : ['', 'failures:', ...report.failures.map(failure => `  - ${failure.id}: ${failure.reason}`)]
  return [header, '', ...rows, ...failureRows].join('\n')
}

export { runAgent, snapshotRun }
