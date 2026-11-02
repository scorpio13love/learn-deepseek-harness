/** s24 demo：构造一段“读文件 → 审批拒绝 → 429”的会话并打印卡片 JSON。 */

import { project } from './projection.ts'
import type { SessionEvent } from './types.ts'

let seq = 0
const at = () => 1_700_000_000_000 + seq * 10

function event<T extends SessionEvent['type']>(
  type: T,
  payload: Omit<Extract<SessionEvent, { type: T }>, 'seq' | 'at' | 'type'>,
): Extract<SessionEvent, { type: T }> {
  seq += 1
  return { type, seq, at: at(), ...payload } as Extract<SessionEvent, { type: T }>
}

export function demoEvents(): SessionEvent[] {
  seq = 0
  return [
    event('turn/start', { turn: 1 }),
    event('assistant/text', {
      messageId: 'msg-1',
      text: '我先看看项目结构，再决定改哪里。',
      done: true,
    }),
    event('tool/call', {
      turn: 1,
      callId: 'call-read-1',
      name: 'read_file',
      args: { path: 'src/app.ts' },
    }),
    event('tool/result', {
      turn: 1,
      callId: 'call-read-1',
      name: 'read_file',
      ok: true,
      output: 'export function main() { /* TODO: ... */ }',
    }),
    event('approval/request', {
      turn: 1,
      approvalId: 'approval-1',
      callId: 'call-write-1',
      toolName: 'write_file',
      summary: '写入 src/app.ts（覆盖 1 个文件）',
      args: { path: 'src/app.ts', bytes: 128 },
    }),
    event('approval/resolve', { approvalId: 'approval-1', decision: 'denied' }),
    event('assistant/text', {
      messageId: 'msg-2',
      text: '好，那我先只给方案，不改文件。',
      done: true,
    }),
    event('error', {
      code: 'RATE_LIMITED',
      message: '请求过于频繁，请稍后重试。',
      retryable: true,
      detail: { status: 429, retryAfterMs: 2_000 },
    }),
    event('turn/end', { turn: 1 }),
  ]
}

/** 断线恢复场景：窗口从中间开始，只看到 result，没有 call。 */
export function orphanResultEvents(): SessionEvent[] {
  seq = 100
  return [
    event('tool/result', {
      turn: 2,
      callId: 'call-read-orphan',
      name: 'read_file',
      ok: true,
      output: 'restored from snapshot',
    }),
    event('tool/result', {
      turn: 2,
      callId: 'call-bash-orphan',
      name: 'bash',
      ok: false,
      output: { exitCode: 1, stderr: 'permission denied' },
    }),
  ]
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const snapshot = project([...demoEvents(), ...orphanResultEvents()])
  console.log(JSON.stringify(snapshot, null, 2))
}
