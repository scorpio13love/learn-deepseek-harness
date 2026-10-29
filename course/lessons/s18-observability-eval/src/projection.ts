/**
 * s18 · observability / eval：沿用前序课程的实现（本课改动见 README）。
 */

import type { Message, SessionEvent } from './types.ts'
import type { Session } from './session.ts'
import { textOf } from './types.ts'

export interface SessionSnapshot {
  seq: number
  turn: number
  status: 'idle' | 'running'
  messages: Message[]
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
}

export class SessionProjection {
  #session: Session
  #snapshot: SessionSnapshot
  #detach: () => void
  #listeners = new Set<(snapshot: SessionSnapshot) => void>()

  constructor(session: Session) {
    this.#session = session
    this.#snapshot = this.#fold()
    this.#detach = session.onAppend(() => {
      this.#snapshot = this.#fold()
      for (const listener of this.#listeners) listener(this.#snapshot)
    })
  }

  get snapshot(): SessionSnapshot {
    return this.#snapshot
  }

  onChange(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  dispose(): void {
    this.#detach()
    this.#listeners.clear()
  }

  #fold(): SessionSnapshot {
    const events = this.#session.events
    let turn = 0
    let status: SessionSnapshot['status'] = 'idle'
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    for (const event of events) {
      if (event.type === 'turn/start') { turn = event.data.turn; status = 'running' }
      if (event.type === 'turn/end') status = 'idle'
      if (event.type === 'assistant/message' && event.data.usage !== undefined) {
        usage = {
          inputTokens: usage.inputTokens + event.data.usage.inputTokens,
          outputTokens: usage.outputTokens + event.data.usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens + (event.data.usage.cacheReadTokens ?? 0),
        }
      }
    }
    return {
      seq: this.#session.lastSeq,
      turn,
      status,
      messages: this.#session.deriveMessages(),
      usage,
    }
  }
}

export { textOf }
