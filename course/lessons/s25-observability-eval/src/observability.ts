/** s18 的可观测与评测工具：span、record/replay、snapshot、fault。 */

import type { ChatRequest, Model, SessionEvent, StreamChunk, TokenUsage } from './types.ts'
import type { Message } from './types.ts'
import type { Session } from './session.ts'
import { textOf } from './types.ts'

export interface Span {
  id: string
  name: string
  parentId?: string
  start: number
  end?: number
  attributes: Record<string, unknown>
  events: Array<{ name: string; time: number; attributes?: Record<string, unknown> }>
}

export class Telemetry {
  #next = 1
  #spans: Span[] = []
  #stack: Span[] = []

  start(name: string, attributes: Record<string, unknown> = {}): Span {
    const parent = this.#stack.at(-1)
    const span: Span = {
      id: `span-${this.#next++}`,
      name,
      ...parent === undefined ? {} : { parentId: parent.id },
      start: Date.now(),
      attributes,
      events: [],
    }
    this.#spans.push(span)
    this.#stack.push(span)
    return span
  }

  end(span: Span): void {
    span.end = Date.now()
    const index = this.#stack.lastIndexOf(span)
    if (index >= 0) this.#stack.length = index
  }

  event(span: Span, name: string, attributes?: Record<string, unknown>): void {
    span.events.push({
      name,
      time: Date.now(),
      ...attributes === undefined ? {} : { attributes },
    })
  }

  get spans(): readonly Span[] {
    return this.#spans
  }

  toJSON(): { spans: Span[] } {
    return { spans: this.#spans }
  }
}

export interface RecordedCall {
  request: ChatRequest
  chunks: StreamChunk[]
}

export class RecordingModel implements Model {
  readonly provider: string
  readonly model: string
  readonly calls: RecordedCall[] = []
  #inner: Model

  constructor(inner: Model) {
    this.#inner = inner
    this.provider = inner.provider
    this.model = inner.model
  }

  get records(): readonly RecordedCall[] {
    return this.calls
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const chunks: StreamChunk[] = []
    for await (const chunk of this.#inner.stream(request)) {
      chunks.push(chunk)
      yield chunk
    }
    this.calls.push({
      request: structuredClone(request) as ChatRequest,
      chunks,
    })
  }
}

export class ReplayModel implements Model {
  readonly provider: string
  readonly model: string
  #records: readonly RecordedCall[]
  #cursor = 0

  constructor(records: readonly RecordedCall[], identity?: { provider: string; model: string }) {
    this.#records = records
    this.provider = identity?.provider ?? 'replay'
    this.model = identity?.model ?? 'replay'
  }

  async *stream(_request: ChatRequest): AsyncIterable<StreamChunk> {
    const record = this.#records[this.#cursor++]
    if (record === undefined) throw new Error('replay exhausted')
    for (const chunk of record.chunks) yield structuredClone(chunk)
  }
}

export interface EvalSnapshot {
  events: string[]
  messages: Array<{ role: string; text: string }>
  usage: TokenUsage[]
}

export function snapshotSession(session: Session): EvalSnapshot {
  return {
    events: session.events.map(event => event.type),
    messages: session.deriveMessages().map(message => ({ role: message.role, text: textOf(message) })),
    usage: session.events
      .filter((event): event is Extract<SessionEvent, { type: 'assistant/message' }> => event.type === 'assistant/message')
      .flatMap(event => event.data.usage === undefined ? [] : [event.data.usage]),
  }
}

export function assertSnapshot(a: EvalSnapshot, b: EvalSnapshot): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`snapshot mismatch\nA=${JSON.stringify(a)}\nB=${JSON.stringify(b)}`)
  }
}

/** 注入一个终止失败；用于测试重试/错误 UI。 */
export class FaultModel implements Model {
  readonly provider = 'fault'
  readonly model = 'fault'
  #failure: { message: string; code: string; status?: number }

  constructor(failure: { message: string; code: string; status?: number }) {
    this.#failure = failure
  }

  async *stream(_request: ChatRequest): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: this.#failure } }
  }
}

/** 把消息转成单行，便于日志/断言。 */
export function transcript(messages: readonly Message[]): string[] {
  return messages.map(message => `${message.role}:${textOf(message)}`)
}
