/**
 * s18 · observability / eval：沿用前序课程的实现（本课改动见 README）。
 */

import type { Message, SessionEvent, ToolCallBlock } from './types.ts'
import { createMessage } from './session.ts'
import type { Session } from './session.ts'

export interface MissingToolCall {
  callId: string
  name: string
  arguments: string
}

/** 扫描一个 turn/step 内缺失结果的工具调用。 */
export function missingToolResults(
  session: Session,
  turn: number,
  step: number,
): MissingToolCall[] {
  const calls = new Map<string, MissingToolCall>()
  for (const event of session.events) {
    if (event.type === 'tool/call' && event.data.turn === turn && event.data.step === step) {
      calls.set(event.data.callId, {
        callId: event.data.callId,
        name: event.data.name,
        arguments: event.data.arguments,
      })
    }
    if (event.type === 'tool/result' && event.data.turn === turn && event.data.step === step) {
      calls.delete(event.data.message.toolCallId ?? '')
    }
  }
  return [...calls.values()]
}

/**
 * 为缺失结果的调用追加保守错误结果。
 * 已提交结果保持不变；文本明确要求模型先检查外部状态。
 */
export function recoverMissingToolResults(
  session: Session,
  turn: number,
  step: number,
): number {
  const missing = missingToolResults(session, turn, step)
  for (const call of missing) {
    const message: Message = createMessage({
      role: 'tool',
      toolCallId: call.callId,
      isError: true,
      content: [{
        type: 'text',
        text: `Error: tool "${call.name}" was started but its outcome is unknown; check external state before retrying.`,
      }],
    })
    session.append('tool/result', { turn, step, message }, { surfaceOp: 'append' })
  }
  return missing.length
}

/** 从事件流直接提取所有工具调用（测试/演示辅助）。 */
export function toolCallsOf(events: readonly SessionEvent[]): ToolCallBlock[] {
  return events
    .filter((event): event is Extract<SessionEvent, { type: 'tool/call' }> => event.type === 'tool/call')
    .map(event => ({
      type: 'tool-call',
      id: event.data.callId,
      name: event.data.name,
      arguments: event.data.arguments,
    }))
}
