/**
 * s18 · observability / eval：沿用前序课程的实现（本课改动见 README）。
 */

import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export type RequestHandler = (params: unknown) => unknown | Promise<unknown>
export type NotificationHandler = (params: unknown) => void

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export class JsonRpcPeer {
  #input: Readable
  #output: Writable
  #handlers = new Map<string, RequestHandler>()
  #notifications = new Map<string, NotificationHandler>()
  #pending = new Map<number, Pending>()
  #nextId = 1
  #closed = false

  constructor(input: Readable, output: Writable) {
    this.#input = input
    this.#output = output
    const lines = createInterface({ input })
    lines.on('line', line => { void this.#onLine(line) })
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.#handlers.set(method, handler)
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.#notifications.set(method, handler)
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error('JSON-RPC peer is closed'))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`JSON-RPC request "${method}" timed out`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      this.#write({ jsonrpc: '2.0', id, method, ...params === undefined ? {} : { params } })
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return
    this.#write({ jsonrpc: '2.0', method, ...params === undefined ? {} : { params } })
  }

  close(): void {
    this.#closed = true
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('JSON-RPC peer closed'))
    }
    this.#pending.clear()
    this.#input.removeAllListeners()
    this.#output.end()
  }

  #write(message: unknown): void {
    this.#output.write(`${JSON.stringify(message)}\n`)
  }

  async #onLine(line: string): Promise<void> {
    if (line.trim().length === 0) return
    let message: {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: { message?: string; code?: number }
    }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }

    if (typeof message.method === 'string' && message.id !== undefined) {
      const handler = this.#handlers.get(message.method)
      if (handler === undefined) {
        this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } })
        return
      }
      try {
        const result = await handler(message.params)
        this.#write({ jsonrpc: '2.0', id: message.id, result })
      } catch (error) {
        this.#write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        })
      }
      return
    }

    if (typeof message.method === 'string') {
      this.#notifications.get(message.method)?.(message.params)
      return
    }

    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error !== undefined) pending.reject(new Error(message.error.message ?? 'JSON-RPC error'))
      else pending.resolve(message.result)
    }
  }
}
