/** 稳定快照与路径级 diff。快照不包含时间戳/run id。 */

import type { ChatMessage, JsonValue, RunResult, Usage } from './types.ts'

export interface SnapshotMessage {
  role: ChatMessage['role']
  content: string
  toolCalls?: Array<{ id: string; name: string; arguments: JsonValue }>
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

export interface RunSnapshot {
  outcome: RunResult['outcome']
  messages: SnapshotMessage[]
  toolCalls: RunResult['toolCalls']
  events: Array<{ type: string; data: JsonValue }>
  usage: Usage
  steps: number
}

export interface SnapshotDiff {
  path: string
  left: unknown
  right: unknown
}

function snapshotMessage(message: ChatMessage): SnapshotMessage {
  const snapshot: SnapshotMessage = {
    role: message.role,
    content: message.content,
  }
  if (message.toolCalls !== undefined) snapshot.toolCalls = structuredClone(message.toolCalls)
  if (message.toolCallId !== undefined) snapshot.toolCallId = message.toolCallId
  if (message.toolName !== undefined) snapshot.toolName = message.toolName
  if (message.isError !== undefined) snapshot.isError = message.isError
  return snapshot
}

export function snapshotRun(result: RunResult): RunSnapshot {
  return {
    outcome: structuredClone(result.outcome),
    messages: result.messages.map(snapshotMessage),
    toolCalls: structuredClone(result.toolCalls),
    events: result.events.map(event => ({
      type: event.type,
      data: structuredClone(event.data),
    })),
    usage: { ...result.usage },
    steps: result.steps,
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
  return `{${entries.join(',')}}`
}

function same(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right)
}

function diffValue(left: unknown, right: unknown, path: string, out: SnapshotDiff[]): void {
  if (same(left, right)) return
  if (out.length >= 100) return

  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length)
    for (let index = 0; index < length; index += 1) {
      diffValue(left[index], right[index], `${path}[${index}]`, out)
    }
    return
  }

  if (isRecord(left) && isRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    for (const key of [...keys].sort()) {
      diffValue(left[key], right[key], `${path}.${key}`, out)
    }
    return
  }

  out.push({ path, left, right })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function diffSnapshots(left: RunSnapshot, right: RunSnapshot): SnapshotDiff[] {
  const diffs: SnapshotDiff[] = []
  diffValue(left, right, '$', diffs)
  return diffs
}

export function formatDiff(diffs: readonly SnapshotDiff[]): string {
  if (diffs.length === 0) return '(no differences)'
  return diffs.map(diff => [
    `  at ${diff.path}`,
    `    left:  ${JSON.stringify(diff.left)}`,
    `    right: ${JSON.stringify(diff.right)}`,
  ].join('\n')).join('\n')
}

export function assertSnapshot(expected: RunSnapshot, actual: RunSnapshot): void {
  const diffs = diffSnapshots(expected, actual)
  if (diffs.length > 0) {
    throw new Error(`snapshot mismatch (${diffs.length} differences)\n${formatDiff(diffs)}`)
  }
}
