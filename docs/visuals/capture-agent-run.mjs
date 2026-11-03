#!/usr/bin/env node
/**
 * 用 Chrome DevTools Protocol 一次性抓取 s04–s26 的 agent-run 动画帧。
 * 前置：Chrome、gifski、ffmpeg。
 *
 * 用法：
 *   node docs/visuals/capture-flow.mjs           # s04..s07, s09..s28
 *   node docs/visuals/capture-flow.mjs s04 s05   # 只抓指定课
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const port = Number(process.env.CDP_PORT || 9333)
const all = ['s04','s05','s06','s11','s12','s15','s16','s17','s19','s20','s21','s22','s24','s25','s26']
const wanted = process.argv.slice(2).filter(Boolean)
const lessons = wanted.length ? all.filter(x => wanted.includes(x)) : all
const TOTAL = 120
const work = '/tmp/dsh-flow-capture'
const chromeProfile = '/tmp/dsh-flow-chrome-profile'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const write = (p, b64) => writeFile(p, Buffer.from(b64, 'base64'))

async function waitHttp(url, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    try { const r = await fetch(url); if (r.ok) return await r.json() } catch {}
    await sleep(100)
  }
  throw new Error(`timeout waiting for ${url}`)
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map() }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result)
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() { try { this.ws.close() } catch {} }
}

await rm(work, { recursive: true, force: true })
await mkdir(work, { recursive: true })
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${chromeProfile}`, 'about:blank'], { stdio: 'ignore' })
let cdp
try {
  const version = await waitHttp(`http://127.0.0.1:${port}/json/version`)
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json()
  cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
  const base = pathToFileURL(resolve(here, 'agent-run.html')).href

  for (const id of lessons) {
    const dir = resolve(work, id)
    await mkdir(dir, { recursive: true })
    await cdp.send('Page.navigate', { url: `${base}?lesson=${id}&capture=1&frame=0` })
    let ready = false
    for (let i = 0; i < 80; i += 1) {
      const result = await cdp.send('Runtime.evaluate', { expression: 'Boolean(window.RUN_READY)', returnByValue: true })
      if (result.result.value === true) { ready = true; break }
      await sleep(50)
    }
    if (!ready) throw new Error(`${id}: page not ready`)
    await sleep(80)
    for (let frame = 0; frame < TOTAL; frame += 1) {
      await cdp.send('Runtime.evaluate', { expression: `window.setFrame(${frame})`, returnByValue: true })
      await sleep(8)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false })
      await write(resolve(dir, `frame_${String(frame).padStart(3, '0')}.png`), shot.data)
    }
    console.log(`${id}: ${TOTAL} frames`)
  }
  cdp.close()
} finally {
  try { child.kill('SIGTERM') } catch {}
}

// 组装 GIF / MP4 / poster。使用一条 shell，避免在 Node 里重复实现编码参数。
const shell = spawn('bash', ['-lc', `
set -euo pipefail
cd ${JSON.stringify(here)}
for id in ${lessons.join(' ')}; do
  gifski --fps 10 --width 1120 --quality 90 --repeat 0 -o "$id-agent-run.gif" ${JSON.stringify(work)}/"$id"/frame_*.png >/dev/null
  ffmpeg -y -loglevel error -framerate 10 -i ${JSON.stringify(work)}/"$id"/frame_%03d.png -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart "$id-agent-run.mp4"
  echo "encoded $id"
done
`], { stdio: 'inherit' })
const code = await new Promise(r => shell.on('exit', r))
if (code !== 0) process.exit(code)
console.log(`done: ${lessons.length} lessons`)
