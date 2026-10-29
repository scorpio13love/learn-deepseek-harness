/**
 * 课程站静态服务器：以仓库根目录为根，/ 自动跳到 /site/。
 *
 *   node site/serve.mjs
 *   # http://127.0.0.1:4173/site/
 *
 * 这样课程讲义里的 ../course/... 与 deepseek-harness/... 相对链接也能工作。
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const port = Number(process.env.PORT ?? 4173)

const docRedirects = new Map([
  ['/docs/00-architecture.zh.md', '/site/#/docs/architecture'],
  ['/docs/01-course-design.zh.md', '/site/#/docs/course-design'],
  ['/course/README.md', '/site/#/docs/course-readme'],
])

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    let pathname = decodeURIComponent(url.pathname)
    const wantsHtml = (request.headers.accept ?? '').includes('text/html')
    const target = docRedirects.get(pathname)
    if (target !== undefined && wantsHtml && url.searchParams.get('raw') !== '1') {
      response.writeHead(302, { location: target })
      response.end()
      return
    }
    if (pathname === '/' || pathname === '/site') {
      response.writeHead(302, { location: '/site/' })
      response.end()
      return
    }
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = resolve(root, `.${pathname}`)
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end('forbidden')
      return
    }
    const info = await stat(file).catch(() => null)
    if (info === null || !info.isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }
    const body = await readFile(file)
    response.writeHead(200, {
      'content-type': types[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    response.end(body)
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(error))
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`course site: http://127.0.0.1:${port}/site/`)
})
