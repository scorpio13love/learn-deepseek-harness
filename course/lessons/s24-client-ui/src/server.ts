/** 可选的本地演示服务：GET / 渲染卡片，GET /api/cards 返回投影 JSON。 */

import { createServer } from 'node:http'
import { demoEvents, orphanResultEvents } from './demo.ts'
import { pageHtml } from './html.ts'
import { project } from './projection.ts'

const port = Number(process.env.S24_PORT ?? '0')
const snapshot = project([...demoEvents(), ...orphanResultEvents()])

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method !== 'GET') {
    response.writeHead(405).end()
    return
  }
  if (url.pathname === '/api/cards') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(snapshot))
    return
  }
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(pageHtml(snapshot.cards, snapshot.seq))
    return
  }
  response.writeHead(404).end()
})

server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  const actual = typeof address === 'object' && address !== null ? address.port : port
  console.log(`s24 cards demo: http://127.0.0.1:${actual}`)
})
