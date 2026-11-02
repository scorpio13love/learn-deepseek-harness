/** capstone 编排：工作区 → agent → 事件日志/surface/eval → 产物。 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { runAgent } from './agent.ts'
import { AllowPathsApproval, EventedApproval } from './approval.ts'
import type { ApprovalService } from './approval.ts'
import { evaluate } from './eval.ts'
import type { EvalReport } from './eval.ts'
import { EventLog, summarizeSurface } from './events.ts'
import type { SurfaceSummary } from './events.ts'
import { capstoneTools } from './tools.ts'
import type { AgentResult, ChatMessage, JsonObject, Model, SessionEvent } from './types.ts'
import { Workspace } from './workspace.ts'

export const DEFAULT_PROMPT = [
  'Audit this repository for TODO and FIXME markers.',
  'Use list_files to see the tree, read_file for at least three files, and search_text with the regex TODO|FIXME.',
  'Then write a markdown report to audit.md.',
  'Every finding must cite file:line. Include a Summary, Findings, and Files reviewed section.',
  'After the write succeeds, summarize what you found.',
].join(' ')

export const SYSTEM_PROMPT = [
  'You are a careful coding agent working inside one workspace.',
  'You can only use the provided tools. Keep paths workspace-relative.',
  'Read before you write. The only approved write target is audit.md.',
  'Never invent file contents or line numbers; cite only what search_text returned.',
  'When the task is complete, answer in a few sentences.',
].join(' ')

export interface RunCapstoneOptions {
  model: Model
  workspace: string
  outDir: string
  prompt?: string
  maxSteps?: number
  approval?: ApprovalService
  runId?: string
  now?: () => number
  onEvent?: (event: SessionEvent) => void
  signal?: AbortSignal
}

export interface CapstoneArtifacts {
  outDir: string
  eventsPath: string
  surfacePath: string
  evalPath: string
  auditPath?: string
}

export interface CapstoneResult {
  runId: string
  result: AgentResult
  surface: SurfaceSummary
  evalReport: EvalReport
  audit: string | null
  artifacts: CapstoneArtifacts
}

export async function runCapstone(options: RunCapstoneOptions): Promise<CapstoneResult> {
  const runId = options.runId ?? `run-${Date.now()}`
  const outDir = resolve(options.outDir)
  const workspace = await Workspace.open(options.workspace)
  await mkdir(outDir, { recursive: true })

  const eventsPath = join(outDir, 'events.jsonl')
  const surfacePath = join(outDir, 'surface.json')
  const evalPath = join(outDir, 'eval-report.json')
  const auditPath = join(outDir, 'audit.md')

  const log = new EventLog(eventsPath, options.now)
  const record = async (type: string, data: JsonObject): Promise<SessionEvent> => {
    const event = await log.append(type, data)
    options.onEvent?.(event)
    return event
  }

  const approval = new EventedApproval(
    options.approval ?? new AllowPathsApproval(['audit.md']),
    record,
  )

  const prompt = options.prompt ?? DEFAULT_PROMPT
  await record('run/start', {
    runId,
    prompt,
    model: options.model.model,
    provider: options.model.provider,
  })

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]
  const maxSteps = options.maxSteps ?? 8
  const result = await runAgent({
    model: options.model,
    messages,
    tools: capstoneTools(),
    workspace,
    approval,
    record,
    maxSteps,
    ...options.signal === undefined ? {} : { signal: options.signal },
  })

  const surface = summarizeSurface(log.events, runId)
  const evalReport = await evaluate({ workspace, surface, outcome: result.outcome, maxSteps })

  let audit: string | null = null
  try {
    audit = await workspace.readText('audit.md')
    await writeFile(auditPath, audit, 'utf8')
  } catch {
    audit = null
  }

  await writeFile(surfacePath, `${JSON.stringify(surface, null, 2)}\n`, 'utf8')
  await writeFile(evalPath, `${JSON.stringify(evalReport, null, 2)}\n`, 'utf8')

  return {
    runId,
    result,
    surface,
    evalReport,
    audit,
    artifacts: {
      outDir,
      eventsPath,
      surfacePath,
      evalPath,
      ...audit === null ? {} : { auditPath },
    },
  }
}
