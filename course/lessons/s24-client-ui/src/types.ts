/**
 * s24 的数据模型：session 事件 → 可渲染卡片。
 *
 * 所有输出都必须是 JSON 值，方便通过 HTTP/SSE 传输、落盘和快照比较。
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

// ---------------------------------------------------------------------------
// 输入：append-only 的 session 事件
// ---------------------------------------------------------------------------

export interface EventBase {
  /** session 内单调递增；快照与增量的切点。 */
  seq: number
  /** 事件发生时的逻辑时间（毫秒）。UI 不依赖它做排序。 */
  at: number
}

export type SessionEvent =
  | (EventBase & { type: 'turn/start'; turn: number })
  | (EventBase & { type: 'turn/end'; turn: number })
  | (EventBase & { type: 'session/status'; status: 'idle' | 'running' })
  | (EventBase & {
    type: 'assistant/text'
    messageId: string
    text: string
    /** 最后一个增量应带 done: true；缺省按流式处理。 */
    done?: boolean
  })
  | (EventBase & {
    type: 'tool/call'
    turn: number
    callId: string
    name: string
    args: JsonValue
  })
  | (EventBase & {
    type: 'tool/result'
    turn: number
    callId: string
    name?: string
    ok: boolean
    output: JsonValue
  })
  | (EventBase & {
    type: 'approval/request'
    turn: number
    approvalId: string
    callId?: string
    toolName: string
    summary: string
    args: JsonValue
  })
  | (EventBase & {
    type: 'approval/resolve'
    approvalId: string
    decision: 'allowed-once' | 'denied'
  })
  | (EventBase & {
    type: 'error'
    code: string
    message: string
    retryable?: boolean
    detail?: JsonValue
  })

export type SessionEventType = SessionEvent['type']

// ---------------------------------------------------------------------------
// 输出：卡片
// ---------------------------------------------------------------------------

export type CardKind = 'text' | 'tool-call' | 'tool-result' | 'approval' | 'error'

/**
 * 状态是卡片的唯一渲染依据：
 * - streaming/pending/running 是“进行中”
 * - succeeded/failed/denied/cancelled 是终态
 */
export type CardStatus =
  | 'streaming'
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled'

export interface ActionCard {
  /** 稳定 id；重放同一事件必须得到同一个 id。 */
  id: string
  kind: CardKind
  /** 卡片最后一次被更新时对应的事件 seq。 */
  seq: number
  status: CardStatus
  title: string
  summary: string
  payload: JsonObject
}

export interface CardProjectionState {
  seq: number
  turn: number
  status: 'idle' | 'running'
  cards: ActionCard[]
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

export function isTerminal(status: CardStatus): boolean {
  return status === 'succeeded'
    || status === 'failed'
    || status === 'denied'
    || status === 'cancelled'
}

/** 把任意 JSON 值压成单行摘要，保留类型信息。 */
export function summarize(value: JsonValue, limit = 120): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= limit) return oneLine
  return `${oneLine.slice(0, Math.max(0, limit - 1))}…`
}

/** 取文本块的第一行做标题，避免把整段回答塞进 title。 */
export function titleFromText(text: string, fallback = 'Assistant'): string {
  const first = text.split('\n').find(line => line.trim() !== '')
  return first === undefined ? fallback : summarize(first.trim(), 60)
}
