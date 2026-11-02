/**
 * s17 · SDK / headless：沿用前序课程的实现（本课改动见 README）。
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { SessionEvent } from './types.ts'
import type { Session } from './session.ts'
import type { SessionProjection } from './projection.ts'

const HTML = `<!doctype html>
<meta charset="utf-8">
<title>mini harness</title>
<pre id="log"></pre>
<script>
const log = document.getElementById('log')
const print = (text) => { log.textContent += text + '\\n' }
fetch('/api/session').then(r => r.json()).then(s => print('snapshot seq=' + s.seq + ' turn=' + s.turn + ' status=' + s.status))
const events = new EventSource('/api/events?since=-1')
events.onmessage = (message) => {
  const event = JSON.parse(message.data)
  print('#' + event.seq + ' ' + event.type)
}
</script>`

export class SessionWebServer {
  #session: Session
  #projection: SessionProjection
  #server: Server | undefined
  #clients = new Set<ServerResponse>()
  #detach: () => void
  #heartbeat: NodeJS.Timeout | undefined

  constructor(session: Session, projection: SessionProjection) {
    this.#session = session
    this.#projection = projection
    this.#detach = session.onAppend(event => this.#broadcast(event))
  }

  async start(port = 0): Promise<{ url: string; port: number }> {
    if (this.#server !== undefined) throw new Error('server already started')
    const server = createServer((request, response) => this.#handle(request, response))
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
    this.#heartbeat = setInterval(() => {
      for (const client of this.#clients) client.write(': heartbeat\n\n')
    }, 15_000)
    const address = server.address()
    const actual = typeof address === 'object' && address !== null ? address.port : port
    return { url: `http://127.0.0.1:${actual}`, port: actual }
  }

  async close(): Promise<void> {
    this.#detach()
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat)
    for (const client of this.#clients) client.end()
    this.#clients.clear()
    const server = this.#server
    this.#server = undefined
    if (server === undefined) return
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method !== 'GET') {
      response.writeHead(405).end()
      return
    }
    if (url.pathname === '/api/session') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(this.#projection.snapshot))
      return
    }
    if (url.pathname === '/api/events') {
      const since = Number(url.searchParams.get('since') ?? '-1')
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const event of this.#session.events) {
        if (event.seq <= since) continue
        response.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      this.#clients.add(response)
      request.on('close', () => this.#clients.delete(response))
      return
    }
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(HTML)
      return
    }
    response.writeHead(404).end()
  }

  #broadcast(event: SessionEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const client of this.#clients) client.write(payload)
  }
}
