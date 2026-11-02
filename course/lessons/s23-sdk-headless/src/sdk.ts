/** s17 的 SDK server：newline JSON-RPC 上的 session/create / prompt / session/event。 */

import type { Model, SessionEvent } from './types.ts'
import { Agent } from './agent.ts'
import { Session } from './session.ts'
import { ToolRegistry } from './tools.ts'
import type { JsonRpcPeer } from './jsonrpc.ts'

export class SdkServer {
  #peer: JsonRpcPeer
  #modelFactory: () => Model
  #sessions = new Map<string, Session>()
  #next = 1

  constructor(peer: JsonRpcPeer, modelFactory: () => Model) {
    this.#peer = peer
    this.#modelFactory = modelFactory
    peer.onRequest('session/create', (params) => this.createSession(params))
    peer.onRequest('prompt', (params) => this.prompt(params))
    peer.onRequest('shutdown', () => {
      // 先把响应写回，再关闭输出。
      setImmediate(() => peer.close())
      return { ok: true }
    })
  }

  createSession(params: unknown): { sessionId: string } {
    const requested = (params as { id?: unknown } | undefined)?.id
    const id = typeof requested === 'string' && requested.length > 0
      ? requested
      : `sdk-${this.#next++}`
    if (this.#sessions.has(id)) throw new Error(`session "${id}" already exists`)
    const session = new Session(id)
    this.#sessions.set(id, session)
    return { sessionId: id }
  }

  async prompt(params: unknown): Promise<{ sessionId: string; answer: string; reason: string }> {
    const input = params as { sessionId?: unknown; text?: unknown } | undefined
    if (typeof input?.sessionId !== 'string' || typeof input.text !== 'string') {
      throw new Error('prompt requires { sessionId, text }')
    }
    const session = this.#sessions.get(input.sessionId)
    if (session === undefined) throw new Error(`unknown session "${input.sessionId}"`)
    const detach = session.onAppend((event: SessionEvent) => {
      this.#peer.notify('session/event', { sessionId: session.id, event })
    })
    try {
      const agent = new Agent(session, this.#modelFactory(), new ToolRegistry())
      const result = await agent.run(input.text)
      return {
        sessionId: session.id,
        answer: session.lastAssistantText() ?? '',
        reason: result.reason.kind,
      }
    } finally {
      detach()
    }
  }
}
