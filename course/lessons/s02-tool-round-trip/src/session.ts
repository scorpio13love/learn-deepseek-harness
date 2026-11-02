/**
 * s01 的会话日志：仅追加的事件数组，消息历史由 `deriveMessages()` 派生。
 *
 * 这一课先建立两个最重要的习惯：
 * 1. loop 不直接维护 `messages: Message[]`，它每次从日志派生请求；
 * 2. 消息一旦写入，就带上稳定 id 并深度冻结，后续步骤只能追加新事实。
 *
 * s02 会在这之上加入 surface replace、request/header 折叠、重放校验。
 */

import { randomUUID } from 'node:crypto'
import type {
  Message,
  SessionEvent,
  SessionEventDataMap,
  SessionEventType,
} from './types.ts'
import { deepFreeze } from './types.ts'

/** 创建一条带稳定 id 的消息。 */
export function createMessage(input: Omit<Message, 'id'> & { id?: string }): Message {
  return deepFreeze({
    ...input,
    id: input.id ?? randomUUID(),
    content: input.content.map(block => ({ ...block })),
  }) as Message
}

export function createTextMessage(
  role: Message['role'],
  text: string,
  extra: Partial<Pick<Message, 'toolCallId' | 'isError' | 'interrupted'>> = {},
): Message {
  return createMessage({
    role,
    content: [{ type: 'text', text }],
    ...extra,
  })
}

export class Session {
  readonly id: string
  #events: SessionEvent[] = []
  #nextSeq = 0

  constructor(id: string = `session-${randomUUID()}`) {
    this.id = id
  }

  /** 从已持久化的事件恢复（s01 的简单版本，s02 做完整校验）。 */
  static restore(id: string, events: readonly SessionEvent[]): Session {
    const session = new Session(id)
    for (const event of events) {
      session.#events.push(deepFreeze(structuredClone(event)))
      session.#nextSeq = Math.max(session.#nextSeq, event.seq + 1)
    }
    return session
  }

  get events(): readonly SessionEvent[] {
    return this.#events
  }

  get lastSeq(): number {
    return this.#nextSeq - 1
  }

  get lastTurn(): number {
    for (let index = this.#events.length - 1; index >= 0; index -= 1) {
      const event = this.#events[index]
      if (event?.type === 'turn/start') return event.data.turn
    }
    return 0
  }

  /**
   * 追加一个事件，返回已冻结的副本。
   * 调用方后续修改自己的对象不会影响日志，日志也不能被外部修改。
   */
  append<K extends SessionEventType>(type: K, data: SessionEventDataMap[K]): SessionEvent<K> {
    const event = deepFreeze({
      type,
      seq: this.#nextSeq,
      time: Date.now(),
      data: structuredClone(data),
    }) as SessionEvent<K>
    this.#nextSeq += 1
    this.#events.push(event as SessionEvent)
    return event as SessionEvent<K>
  }

  /**
   * 从日志投影模型历史。
   *
   * 只有消息事件进入历史；turn/step/tool-call/request-header 等是
   * 「日志事实」而不是「模型可见消息」。这个区分是 s02 的核心。
   */
  deriveMessages(): Message[] {
    const messages: Message[] = []
    for (const event of this.#events) {
      switch (event.type) {
        case 'system/message':
        case 'user/message':
          messages.push(event.data.message)
          break
        case 'tool/result':
          messages.push(event.data.message)
          break
        case 'assistant/message':
          // 空内容（例如只有 finish、没有文本）不进入派生历史。
          if (event.data.message.content.length > 0) messages.push(event.data.message)
          break
        default:
          break
      }
    }
    return messages
  }

  /** 最近的 assistant 文本，供 demo / 测试使用。 */
  lastAssistantText(): string | undefined {
    for (let index = this.#events.length - 1; index >= 0; index -= 1) {
      const event = this.#events[index]
      if (event?.type !== 'assistant/message') continue
      const text = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (text.length > 0) return text
    }
    return undefined
  }

  toJSON(): { id: string; events: readonly SessionEvent[] } {
    return { id: this.id, events: this.#events }
  }
}
