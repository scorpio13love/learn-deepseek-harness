/** append-only JSONL 事件日志，以及从事件派生的 surface 摘要。 */

import { appendFile, readFile } from 'node:fs/promises'

import type { JsonObject, JsonValue, SessionEvent } from './types.ts'

export class EventLog {
  readonly path: string
  #events: SessionEvent[] = []
  #seq = 0
  #now: () => number

  constructor(path: string, now: () => number = () => Date.now()) {
    this.path = path
    this.#now = now
  }

  get events(): readonly SessionEvent[] {
    return this.#events
  }

  async append(type: string, data: JsonObject): Promise<SessionEvent> {
    this.#seq += 1
    const event: SessionEvent = {
      seq: this.#seq,
      at: this.#now(),
      type,
      data,
    }
    this.#events.push(event)
    await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8')
    return event
  }
}

export async function readEventLog(path: string): Promise<SessionEvent[]> {
  const text = await readFile(path, 'utf8')
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line) as SessionEvent
      } catch (error) {
        throw new Error(`invalid event at line ${index + 1}: ${String(error)}`)
      }
    })
}

export interface SurfaceSummary {
  runId: string
  status: 'ok' | 'error'
  turns: number
  steps: number
  eventCount: number
  tools: Record<string, number>
  filesRead: string[]
  filesWritten: string[]
  approvals: { requested: number; approved: number; denied: number }
  errors: number
  toolErrors: number
  usage: { inputTokens: number; outputTokens: number }
  textChars: number
  durationMs: number
}

interface CallInfo {
  name: string
  args: JsonObject
}

function asObject(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined
}

export function summarizeSurface(events: readonly SessionEvent[], fallbackRunId = 'unknown'): SurfaceSummary {
  const tools: Record<string, number> = {}
  const filesRead = new Set<string>()
  const filesWritten = new Set<string>()
  const calls = new Map<string, CallInfo>()
  const approvals = { requested: 0, approved: 0, denied: 0 }
  const usage = { inputTokens: 0, outputTokens: 0 }
  let runId = fallbackRunId
  let status: 'ok' | 'error' = 'error'
  let turns = 0
  let steps = 0
  let errors = 0
  let toolErrors = 0
  let textChars = 0

  for (const event of events) {
    const data = event.data
    if (event.type === 'run/start') {
      runId = asString(data.runId) ?? runId
    } else if (event.type === 'turn/start') {
      turns += 1
    } else if (event.type === 'step/start') {
      steps += 1
    } else if (event.type === 'tool/call') {
      const name = asString(data.name) ?? 'unknown'
      const callId = asString(data.callId) ?? ''
      const args = asObject(data.args)
      tools[name] = (tools[name] ?? 0) + 1
      calls.set(callId, { name, args })
    } else if (event.type === 'tool/result') {
      const callId = asString(data.callId) ?? ''
      const call = calls.get(callId)
      const ok = data.ok === true
      if (!ok) toolErrors += 1
      if (ok && call !== undefined) {
        const path = asString(call.args.path)
        if (path !== undefined && call.name === 'read_file') filesRead.add(path)
        if (path !== undefined && call.name === 'write_file') filesWritten.add(path)
      }
    } else if (event.type === 'approval/request') {
      approvals.requested += 1
    } else if (event.type === 'approval/decision') {
      if (data.decision === 'allowed-once') approvals.approved += 1
      else approvals.denied += 1
    } else if (event.type === 'error') {
      errors += 1
    } else if (event.type === 'assistant/text') {
      textChars += (asString(data.text) ?? '').length
    } else if (event.type === 'usage') {
      usage.inputTokens = asNumber(data.inputTokens) ?? usage.inputTokens
      usage.outputTokens = asNumber(data.outputTokens) ?? usage.outputTokens
    } else if (event.type === 'run/end') {
      status = data.status === 'ok' ? 'ok' : 'error'
    }
  }

  const first = events[0]
  const last = events.at(-1)
  return {
    runId,
    status,
    turns,
    steps,
    eventCount: events.length,
    tools,
    filesRead: [...filesRead].sort(),
    filesWritten: [...filesWritten].sort(),
    approvals,
    errors,
    toolErrors,
    usage,
    textChars,
    durationMs: first === undefined || last === undefined ? 0 : Math.max(0, last.at - first.at),
  }
}
