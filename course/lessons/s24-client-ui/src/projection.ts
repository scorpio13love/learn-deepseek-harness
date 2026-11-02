/**
 * 纯同步 fold：SessionEvent[] → ActionCard[]。
 *
 * 约束：
 * - 不读时间、不发请求、不抛异常；
 * - 未知事件返回同一个 state 引用；
 * - 不修改输入 state。
 */

import type {
  ActionCard,
  CardProjectionState,
  CardStatus,
  JsonObject,
  JsonValue,
  SessionEvent,
} from './types.ts'
import { summarize, titleFromText } from './types.ts'

export const EMPTY_PROJECTION: CardProjectionState = {
  seq: -1,
  turn: 0,
  status: 'idle',
  cards: [],
}

function baseState(state: CardProjectionState, event: SessionEvent): CardProjectionState {
  return {
    ...state,
    seq: event.seq,
  }
}

function cardIndex(cards: readonly ActionCard[], id: string): number {
  return cards.findIndex(card => card.id === id)
}

function replaceCard(
  state: CardProjectionState,
  card: ActionCard,
): CardProjectionState {
  const cards = [...state.cards]
  const index = cardIndex(cards, card.id)
  if (index < 0) cards.push(card)
  else cards[index] = card
  return { ...state, seq: card.seq, cards }
}

function removeCard(state: CardProjectionState, id: string): CardProjectionState {
  const cards = state.cards.filter(card => card.id !== id)
  return cards.length === state.cards.length ? state : { ...state, cards }
}

function toolCallId(callId: string): string {
  return `tool:${callId}`
}

function approvalCardId(approvalId: string): string {
  return `approval:${approvalId}`
}

/** 把 tool/result 合并进已有 tool/call 卡；找不到时返回 undefined。 */
function mergeToolResult(
  state: CardProjectionState,
  event: Extract<SessionEvent, { type: 'tool/result' }>,
): CardProjectionState | undefined {
  const id = toolCallId(event.callId)
  const index = cardIndex(state.cards, id)
  const existing = state.cards[index]
  if (existing === undefined) return undefined

  const result: JsonObject = {
    ok: event.ok,
    output: event.output,
  }
  const next: ActionCard = {
    ...existing,
    seq: event.seq,
    status: event.ok ? 'succeeded' : 'failed',
    summary: event.ok
      ? `完成：${summarize(event.output, 100)}`
      : `失败：${summarize(event.output, 100)}`,
    payload: {
      ...existing.payload,
      result,
    },
  }
  return replaceCard(state, next)
}

export function applyEvent(
  state: CardProjectionState,
  event: SessionEvent,
): CardProjectionState {
  switch (event.type) {
    case 'turn/start': {
      return {
        ...baseState(state, event),
        turn: event.turn,
        status: 'running',
      }
    }

    case 'turn/end': {
      // 正常结束的 turn 不应留下“运行中”的卡；异常中断则标为 cancelled。
      const cards = state.cards.map((card): ActionCard => {
        if (card.status === 'streaming') {
          return { ...card, status: 'succeeded' }
        }
        if (card.status === 'running' || card.status === 'pending') {
          return { ...card, status: 'cancelled' }
        }
        return card
      })
      return { ...baseState(state, event), turn: event.turn, status: 'idle', cards }
    }

    case 'session/status': {
      return { ...baseState(state, event), status: event.status }
    }

    case 'assistant/text': {
      const id = `text:${event.messageId}`
      const index = cardIndex(state.cards, id)
      const existing = state.cards[index]
      const fullText = (existing === undefined ? '' : String(existing.payload.text ?? '')) + event.text
      const next: ActionCard = {
        id,
        kind: 'text',
        seq: event.seq,
        status: event.done === true ? 'succeeded' : 'streaming',
        title: titleFromText(fullText),
        summary: summarize(fullText, 160),
        payload: {
          messageId: event.messageId,
          text: fullText,
          role: 'assistant',
        },
      }
      return replaceCard(baseState(state, event), next)
    }

    case 'tool/call': {
      const next: ActionCard = {
        id: toolCallId(event.callId),
        kind: 'tool-call',
        seq: event.seq,
        status: 'running',
        title: `工具 · ${event.name}`,
        summary: `参数：${summarize(event.args, 110)}`,
        payload: {
          callId: event.callId,
          name: event.name,
          args: event.args,
          turn: event.turn,
          result: null,
        },
      }
      return replaceCard(baseState(state, event), next)
    }

    case 'tool/result': {
      const merged = mergeToolResult(state, event)
      if (merged !== undefined) return merged

      // 从中间窗口恢复：只看到结果，没有看到调用。为它单独建一张卡，
      // 否则客户端会静默丢掉这次工具输出。
      const next: ActionCard = {
        id: `result:${event.callId}`,
        kind: 'tool-result',
        seq: event.seq,
        status: event.ok ? 'succeeded' : 'failed',
        title: `工具结果 · ${event.name ?? event.callId}`,
        summary: summarize(event.output, 140),
        payload: {
          callId: event.callId,
          name: event.name ?? null,
          ok: event.ok,
          output: event.output,
          orphan: true,
        },
      }
      return replaceCard(baseState(state, event), next)
    }

    case 'approval/request': {
      const next: ActionCard = {
        id: approvalCardId(event.approvalId),
        kind: 'approval',
        seq: event.seq,
        status: 'pending',
        title: `审批 · ${event.toolName}`,
        summary: event.summary,
        payload: {
          approvalId: event.approvalId,
          callId: event.callId ?? null,
          toolName: event.toolName,
          args: event.args,
          decision: null,
        },
      }
      return replaceCard(baseState(state, event), next)
    }

    case 'approval/resolve': {
      const id = approvalCardId(event.approvalId)
      const index = cardIndex(state.cards, id)
      const existing = state.cards[index]
      if (existing === undefined) return baseState(state, event)
      const allowed = event.decision === 'allowed-once'
      const next: ActionCard = {
        ...existing,
        seq: event.seq,
        status: allowed ? 'succeeded' : 'denied',
        summary: allowed ? '已允许一次' : '用户拒绝',
        payload: {
          ...existing.payload,
          decision: event.decision,
        },
      }
      return replaceCard(baseState(state, event), next)
    }

    case 'error': {
      const next: ActionCard = {
        id: `error:${event.seq}`,
        kind: 'error',
        seq: event.seq,
        status: 'failed',
        title: `错误 · ${event.code}`,
        summary: event.message,
        payload: {
          code: event.code,
          message: event.message,
          retryable: event.retryable ?? false,
          detail: event.detail ?? null,
        },
      }
      return replaceCard(baseState(state, event), next)
    }

    default: {
      // 未知事件不是错误：新版本 host 可以发送旧客户端不认识的事件。
      return state
    }
  }
}

export function project(events: readonly SessionEvent[]): CardProjectionState {
  return events.reduce(applyEvent, EMPTY_PROJECTION)
}

/**
 * 可增量 push 的投影器。它只是 applyEvent 的薄封装；
 * 测试会验证它和一次性 project 的结果完全一致。
 */
export class CardProjection {
  #state: CardProjectionState

  constructor(initial: CardProjectionState = EMPTY_PROJECTION) {
    this.#state = initial
  }

  get state(): CardProjectionState {
    return this.#state
  }

  push(event: SessionEvent): CardProjectionState {
    this.#state = applyEvent(this.#state, event)
    return this.#state
  }

  pushAll(events: readonly SessionEvent[]): CardProjectionState {
    for (const event of events) this.push(event)
    return this.#state
  }

  cards(): ActionCard[] {
    return [...this.#state.cards]
  }

  byKind(kind: ActionCard['kind']): ActionCard[] {
    return this.#state.cards.filter(card => card.kind === kind)
  }

  find(id: string): ActionCard | undefined {
    return this.#state.cards.find(card => card.id === id)
  }
}

/**
 * 产物投影：只保留 client 真正需要的字段，隐藏内部 seq 之外的实现细节。
 * 目前等同于 state，但单独导出可以让未来加“已读/折叠”时不动 fold。
 */
export function toView(state: CardProjectionState): {
  seq: number
  turn: number
  status: 'idle' | 'running'
  cards: ActionCard[]
} {
  return {
    seq: state.seq,
    turn: state.turn,
    status: state.status,
    cards: state.cards,
  }
}

export { removeCard }
export type { CardStatus, JsonValue }
