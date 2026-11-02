/**
 * s17 · SDK / headless：沿用前序课程的实现（本课改动见 README）。
 */

import { randomUUID } from 'node:crypto'
import type {
  AppendIntent,
  EpochHeader,
  Message,
  MessageRole,
  RequestContext,
  SessionEvent,
  SessionEventDataMap,
  SessionEventType,
  SurfaceEventType,
  SurfaceOp,
} from './types.ts'
import {
  assertJsonValue,
  deepFreeze,
  isSurfaceEventType,
} from './types.ts'

const SURFACE_MESSAGE_ROLE: Record<SurfaceEventType, MessageRole> = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SESSION_EVENT_TYPES: ReadonlySet<string> = new Set<SessionEventType>([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'request/header',
  'request/context',
  'session/end-seed',
])

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
  #surface: number[] = []
  #nextSeq = 0
  #contentGeneration = 0
  #listeners: Array<(event: SessionEvent) => void> = []

  constructor(id: string = `session-${randomUUID()}`) {
    this.id = id
  }

  /**
   * 从已持久化的事件恢复。
   * 它会重新校验 seq 连续性、事件合法性和 surface 引用，而不是盲目信任输入。
   */
  static restore(id: string, events: readonly SessionEvent[]): Session {
    const session = new Session(id)
    for (const raw of events) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new TypeError(`event #${session.#nextSeq} is not an object`)
      }
      assertJsonValue(raw, `event #${session.#nextSeq}`)
      const event = deepFreeze(structuredClone(raw)) as SessionEvent
      session.#validateRestoredEvent(event)
      session.#surface = session.#applySurface(session.#surface, event)
      session.#events.push(event)
      session.#nextSeq += 1
    }
    return session
  }

  get events(): readonly SessionEvent[] {
    return this.#events
  }

  /** 观察已提交事件；持久化/检查点用它写盘。 */
  onAppend(listener: (event: SessionEvent) => void): () => void {
    this.#listeners.push(listener)
    return () => {
      const index = this.#listeners.indexOf(listener)
      if (index >= 0) this.#listeners.splice(index, 1)
    }
  }

  /** 当前派生历史引用的 surface 节点 seq，按模型顺序排列。 */
  get surfaceSeqs(): readonly number[] {
    return this.#surface
  }

  /** replace 会推进 generation；s06/s10 用它决定是否重建派生缓存。 */
  get contentGeneration(): number {
    return this.#contentGeneration
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
   * 追加一个事件。
   *
   * surface 事件必须给出 `surfaceOp`；非 surface 事件必须不带 surface 元数据。
   * 校验失败时日志完全不变（先构造并校验，再提交）。
   */
  append<K extends SessionEventType>(
    type: K,
    data: SessionEventDataMap[K],
    intent: AppendIntent = {},
  ): SessionEvent<K> {
    if (!SESSION_EVENT_TYPES.has(type)) {
      throw new TypeError(`unknown session event type "${type}"`)
    }
    assertJsonValue(data, `data(${type})`)

    const surface = isSurfaceEventType(type)
    const hasSurfaceOp = intent.surfaceOp !== undefined
    if (surface !== hasSurfaceOp) {
      throw new TypeError(
        surface
          ? `surface event "${type}" requires surfaceOp`
          : `log-only event "${type}" must not carry surfaceOp`,
      )
    }
    if (!surface && intent.sourceEventSeqs !== undefined) {
      throw new TypeError(`log-only event "${type}" must not carry sourceEventSeqs`)
    }
    if (intent.sourceEventSeqs !== undefined) {
      this.#validateSourceEventSeqs(intent.sourceEventSeqs, this.#nextSeq)
    }

    const event = {
      type,
      seq: this.#nextSeq,
      time: Date.now(),
      data: structuredClone(data),
      ...intent.ignorable === true ? { ignorable: true as const } : {},
      ...surface
        ? {
          surfaceOp: intent.surfaceOp as SurfaceOp,
          ...intent.sourceEventSeqs === undefined
            ? {}
            : { sourceEventSeqs: [...intent.sourceEventSeqs] },
        }
        : {},
    } as SessionEvent<K>

    // data 已在上面校验；event 的其余字段都是构造出来的标量/对象。
    const nextSurface = this.#applySurface(this.#surface, event)
    const frozen = deepFreeze(event)
    this.#events.push(frozen as SessionEvent)
    this.#surface = nextSurface
    this.#nextSeq += 1
    for (const listener of this.#listeners) listener(frozen as SessionEvent)
    return frozen
  }

  /** 从日志投影模型历史：只走 surface，不看原始事件顺序。 */
  deriveMessages(): Message[] {
    const messages: Message[] = []
    for (const seq of this.#surface) {
      const event = this.#events[seq]
      if (event === undefined) continue
      const message = this.#deriveEventMessage(event)
      if (message !== null) messages.push(message)
    }
    return messages
  }

  /** 最近一份 request/header 快照；没有时返回 undefined。 */
  requestHeader(): EpochHeader | undefined {
    for (let index = this.#events.length - 1; index >= 0; index -= 1) {
      const event = this.#events[index]
      if (event?.type === 'request/header') return event.data.header
    }
    return undefined
  }

  /** 最近一份 request/context；只在路由变化时才有新事件。 */
  requestContext(): RequestContext | undefined {
    for (let index = this.#events.length - 1; index >= 0; index -= 1) {
      const event = this.#events[index]
      if (event?.type === 'request/context') return event.data
    }
    return undefined
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

  /**
   * 派生单条事件的消息；返回 null 表示它不进入模型历史。
   * 注意 system/developer/assistant 的空内容节点保留 surface 位置，但不产生消息。
   */
  #deriveEventMessage(event: SessionEvent): Message | null {
    switch (event.type) {
      case 'user/message':
      case 'tool/result':
        return event.data.message
      case 'system/message':
      case 'developer/message':
      case 'assistant/message':
        return event.data.message.content.length === 0 ? null : event.data.message
      default:
        return null
    }
  }

  #validateRestoredEvent(event: SessionEvent): void {
    if (event.seq !== this.#nextSeq) {
      throw new Error(`event #${this.#nextSeq} has seq ${String(event.seq)}; expected ${this.#nextSeq}`)
    }
    if (!SESSION_EVENT_TYPES.has(event.type)) {
      throw new TypeError(`event #${event.seq} has unknown type "${String(event.type)}"`)
    }
    if (typeof event.time !== 'number' || !Number.isFinite(event.time)) {
      throw new TypeError(`event #${event.seq} has invalid time`)
    }
    if (event.ignorable !== undefined && event.ignorable !== true) {
      throw new TypeError(`event #${event.seq} has invalid ignorable`)
    }

    const surface = isSurfaceEventType(event.type)
    if (surface !== (event.surfaceOp !== undefined)) {
      throw new TypeError(
        surface
          ? `surface event #${event.seq} is missing surfaceOp`
          : `log-only event #${event.seq} carries surfaceOp`,
      )
    }
    if (!surface && event.sourceEventSeqs !== undefined) {
      throw new TypeError(`log-only event #${event.seq} carries sourceEventSeqs`)
    }
    if (event.sourceEventSeqs !== undefined) {
      this.#validateSourceEventSeqs(event.sourceEventSeqs, event.seq)
    }

    if (surface) {
      const message = (event.data as { message?: unknown }).message
      if (!isRecord(message)) throw new TypeError(`surface event #${event.seq} has no message object`)
      const expected = SURFACE_MESSAGE_ROLE[event.type as SurfaceEventType]
      if (message['role'] !== expected) {
        throw new TypeError(`surface event #${event.seq} requires role "${expected}"`)
      }
      if (typeof message['id'] !== 'string' || message['id'].length === 0) {
        throw new TypeError(`surface event #${event.seq} message has no id`)
      }
      if (!Array.isArray(message['content'])) {
        throw new TypeError(`surface event #${event.seq} message has no content array`)
      }
      if (event.type === 'tool/result' && typeof message['toolCallId'] !== 'string') {
        throw new TypeError(`tool/result #${event.seq} message has no toolCallId`)
      }
    }

    if (event.type === 'request/header') {
      const header = event.data.header
      if (!isRecord(header) || !isRecord(header.config)
        || typeof header.config.provider !== 'string'
        || typeof header.config.model !== 'string'
        || !Array.isArray(header.tools)) {
        throw new TypeError(`request/header #${event.seq} has invalid header`)
      }
    }
    if (event.type === 'request/context') {
      if (typeof event.data.provider !== 'string' || typeof event.data.model !== 'string') {
        throw new TypeError(`request/context #${event.seq} has invalid route`)
      }
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const stream = (event.data as { stream?: unknown }).stream
      if (!Array.isArray(stream)) {
        throw new TypeError(`${event.type} #${event.seq} has no stream array`)
      }
      for (const [index, record] of stream.entries()) {
        if (!isRecord(record) || typeof record.time !== 'number' || !Number.isFinite(record.time)
          || !isRecord(record.chunk)) {
          throw new TypeError(`${event.type} #${event.seq} stream[${index}] is invalid`)
        }
      }
    }
  }

  #validateSourceEventSeqs(sourceEventSeqs: readonly number[], seq: number): void {
    if (!Array.isArray(sourceEventSeqs) || sourceEventSeqs.length === 0) {
      throw new TypeError(`event #${seq} sourceEventSeqs must be a non-empty array`)
    }
    const seen = new Set<number>()
    for (const source of sourceEventSeqs) {
      if (!Number.isSafeInteger(source) || source < 0 || source >= seq) {
        throw new TypeError(`event #${seq} cites invalid source seq ${String(source)}`)
      }
      if (seen.has(source)) throw new TypeError(`event #${seq} cites duplicate source seq ${source}`)
      seen.add(source)
    }
  }

  /** 计算下一个 surface；append 追加节点，replace 用新节点替换闭区间。 */
  #applySurface<K extends SessionEventType>(surface: readonly number[], event: SessionEvent<K>): number[] {
    const surfaceOp = event.surfaceOp as SurfaceOp | undefined
    if (surfaceOp === undefined) return [...surface]
    if (surfaceOp === 'append') return [...surface, event.seq]

    const { startSeq, endSeq } = surfaceOp
    if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq) || startSeq > endSeq) {
      throw new TypeError(`event #${event.seq} has invalid replace range ${String(startSeq)}..${String(endSeq)}`)
    }
    const startIndex = surface.indexOf(startSeq)
    const endIndex = surface.indexOf(endSeq)
    if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
      throw new TypeError(
        `event #${event.seq} replace range ${startSeq}..${endSeq} is not a contiguous surface range`,
      )
    }
    const shadowed = surface.slice(startIndex, endIndex + 1)
    const sources = new Set((event.sourceEventSeqs ?? []) as readonly number[])
    for (const seq of shadowed) {
      if (!sources.has(seq)) {
        throw new TypeError(`event #${event.seq} must cite shadowed surface node #${seq}`)
      }
    }
    const next = [...surface.slice(0, startIndex), event.seq, ...surface.slice(endIndex + 1)]
    this.#contentGeneration += 1
    return next
  }
}
