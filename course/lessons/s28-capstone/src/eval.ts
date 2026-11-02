/** capstone 验收：规则检查 + 指标。报告缺失也照样给出逐项失败原因。 */

import type { SurfaceSummary } from './events.ts'
import type { Outcome } from './types.ts'
import { Workspace } from './workspace.ts'

export interface EvalCheck {
  id: string
  label: string
  passed: boolean
  detail: string
}

export interface EvalMetrics {
  steps: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  filesRead: number
  reportChars: number
  findings: number
  durationMs: number
}

export interface EvalReport {
  passed: boolean
  checks: EvalCheck[]
  metrics: EvalMetrics
}

export interface EvaluateInput {
  workspace: Workspace
  surface: SurfaceSummary
  outcome: Outcome
  maxSteps: number
}

export async function evaluate(input: EvaluateInput): Promise<EvalReport> {
  let report = ''
  try {
    report = await input.workspace.readText('audit.md')
  } catch {
    report = ''
  }

  const findings = report.match(/\b(TODO|FIXME)\b/g)?.length ?? 0
  const toolsUsed = Object.keys(input.surface.tools).length
  const filesRead = input.surface.filesRead.length
  const checks: EvalCheck[] = [
    {
      id: 'run-completed',
      label: 'agent finished without a model failure',
      passed: input.outcome.kind === 'ok',
      detail: input.outcome.kind === 'ok' ? 'ok' : `${input.outcome.failure.kind}: ${input.outcome.failure.message}`,
    },
    {
      id: 'report-written',
      label: 'audit.md exists and is non-empty',
      passed: report.trim() !== '',
      detail: report.trim() === '' ? 'missing or empty audit.md' : `${report.length} chars`,
    },
    {
      id: 'report-has-findings',
      label: 'audit.md contains at least 3 TODO/FIXME markers',
      passed: findings >= 3,
      detail: `${findings} marker(s)`,
    },
    {
      id: 'report-cites-paths',
      label: 'audit.md cites src/app.ts and README.md',
      passed: report.includes('src/app.ts') && report.includes('README.md'),
      detail: `app=${report.includes('src/app.ts')} readme=${report.includes('README.md')}`,
    },
    {
      id: 'files-reviewed',
      label: 'at least 3 distinct files were read successfully',
      passed: filesRead >= 3,
      detail: `${filesRead} file(s): ${input.surface.filesRead.join(', ')}`,
    },
    {
      id: 'tools-used',
      label: 'at least 4 distinct tools were used',
      passed: toolsUsed >= 4,
      detail: `${toolsUsed}: ${Object.keys(input.surface.tools).sort().join(', ')}`,
    },
    {
      id: 'approval-granted',
      label: 'at least one write was approved',
      passed: input.surface.approvals.approved >= 1,
      detail: `requested=${input.surface.approvals.requested} approved=${input.surface.approvals.approved} denied=${input.surface.approvals.denied}`,
    },
    {
      id: 'no-errors',
      label: 'no model or tool errors were recorded',
      passed: input.surface.errors === 0 && input.surface.toolErrors === 0,
      detail: `errors=${input.surface.errors} toolErrors=${input.surface.toolErrors}`,
    },
    {
      id: 'bounded-steps',
      label: `steps <= ${input.maxSteps}`,
      passed: input.surface.steps <= input.maxSteps,
      detail: `${input.surface.steps} step(s)`,
    },
  ]

  const toolCalls = Object.values(input.surface.tools).reduce((sum, count) => sum + count, 0)
  return {
    passed: checks.every(check => check.passed),
    checks,
    metrics: {
      steps: input.surface.steps,
      toolCalls,
      inputTokens: input.surface.usage.inputTokens,
      outputTokens: input.surface.usage.outputTokens,
      filesRead,
      reportChars: report.length,
      findings,
      durationMs: input.surface.durationMs,
    },
  }
}

export function renderEvalReport(report: EvalReport): string {
  const passed = report.checks.filter(check => check.passed).length
  const lines = [
    `eval: ${report.passed ? 'PASS' : 'FAIL'} (${passed}/${report.checks.length} checks)`,
    '',
    ...report.checks.map(check => `[${check.passed ? 'PASS' : 'FAIL'}] ${check.id} — ${check.label} (${check.detail})`),
    '',
    'metrics:',
    `  steps=${report.metrics.steps} toolCalls=${report.metrics.toolCalls}`,
    `  tokens=${report.metrics.inputTokens}/${report.metrics.outputTokens}`,
    `  filesRead=${report.metrics.filesRead} findings=${report.metrics.findings} reportChars=${report.metrics.reportChars}`,
    `  durationMs=${report.metrics.durationMs}`,
  ]
  return lines.join('\n')
}
