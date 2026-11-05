#!/usr/bin/env node
/** 生成总知识图谱：Markdown / HTML / SVG / XMind / OPML。 */
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { meta, domains } from './knowledge-data.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, 'mindmaps')
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

function wrap(text, width = 22) {
  const chars = [...String(text)]; const lines = []
  for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join(''))
  return lines.slice(0, 3)
}
function textLines(lines, x, y, size, color, anchor = 'start', weight = 400) {
  return lines.map((line, i) => `<text x="${x}" y="${y + i * (size + 3)}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${esc(line)}</text>`).join('')
}

function svgMap() {
  const W = 1800, H = 1140, cx = W / 2, cy = 64
  const body = domains.map((d, i) => {
    const col = i % 3, row = Math.floor(i / 3)
    const x = 60 + col * 580, y = 150 + row * 485, w = 540
    const rows = d.questions.map((q, j) => {
      const qy = y + 62 + j * 72
      const qLines = wrap(q.q, 19).slice(0, 2)
      const short = q.a.split('。')[0].slice(0, 72) + (q.a.split('。')[0].length > 72 ? '…' : '。')
      const aLines = wrap(short, 24).slice(0, 3)
      return `${textLines(qLines, x + 20, qy, 11, '#2c2c32', 'start', 600)}
        ${textLines(aLines, x + 285, qy, 9.5, '#8b909c')}`
    }).join('')
    const tx = x + w / 2
    return `<path d="M${cx} ${cy + 22} C${cx} ${y - 10} ${tx} ${y - 50} ${tx} ${y}" fill="none" stroke="${d.color}" stroke-opacity=".3" stroke-width="1.3"/>
      <rect x="${x}" y="${y}" width="${w}" height="440" rx="13" fill="#fff" stroke="#e6e7ee"/>
      <rect x="${x}" y="${y}" width="${w}" height="42" rx="13" fill="${d.color}"/>
      <rect x="${x}" y="${y + 30}" width="${w}" height="12" fill="${d.color}"/>
      <text x="${x + 18}" y="${y + 27}" font-size="13" font-weight="700" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${esc(d.title)}</text>
      <text x="${x + w - 18}" y="${y + 27}" text-anchor="end" font-size="9" fill="rgba(255,255,255,.72)" font-family="SFMono-Regular,Consolas,monospace">${d.questions.length} Q</text>
      <line x1="${x + 268}" y1="${y + 48}" x2="${x + 268}" y2="${y + 430}" stroke="#eceef4"/>
      ${rows}`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title">
  <title id="title">${esc(meta.title)}</title>
  <rect width="${W}" height="${H}" fill="#fbfcff"/>
  <g stroke="#303a63" stroke-opacity=".03"><path d="M0 0H1800M0 100H1800M0 200H1800M0 300H1800M0 400H1800M0 500H1800M0 600H1800M0 700H1800M0 800H1800M0 900H1800M0 1000H1800"/></g>
  <text x="48" y="38" font-size="9" letter-spacing=".12em" fill="#5b5bd6" font-family="SFMono-Regular,Consolas,monospace">LEARN DEEPSEEK HARNESS · KNOWLEDGE GRAPH</text>
  <text x="48" y="68" font-size="25" font-weight="760" fill="#222733" letter-spacing="-.02em" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${esc(meta.title)}</text>
  <rect x="${cx - 160}" y="34" width="320" height="64" rx="14" fill="#222733"/>
  <text x="${cx}" y="57" text-anchor="middle" font-size="9" fill="rgba(255,255,255,.65)" font-family="SFMono-Regular,Consolas,monospace">SIX DOMAINS · 30 Q</text>
  <text x="${cx}" y="80" text-anchor="middle" font-size="14" font-weight="700" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${esc(meta.subtitle)}</text>
  ${body}
  <a href="../../quiz/index.html"><rect x="${W - 286}" y="${H - 82}" width="238" height="30" rx="7" fill="#5b5bd6"/><text x="${W - 167}" y="${H - 62}" text-anchor="middle" font-size="10.5" font-weight="650" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">DSH 面试自测 · 96 题 →</text></a>
  <line x1="48" y1="${H - 44}" x2="${W - 48}" y2="${H - 44}" stroke="#e3e6ef"/>
  <text x="48" y="${H - 20}" font-size="9" fill="#a0a6b6" font-family="SFMono-Regular,Consolas,monospace">完整答案：knowledge-map.html / 04-knowledge-map.zh.md / course.xmind</text>
  <text x="${W - 48}" y="${H - 20}" text-anchor="end" font-size="9" fill="#a0a6b6" font-family="SFMono-Regular,Consolas,monospace">控制面 → 事实 → 工具 → 组合 → 执行 → 质量</text>
</svg>`
}

function markdown() {
  const out = [`# ${meta.title}`, '', `> ${meta.intro}`, '', '[**开始 96 题面试自测 →**](quiz/index.html)', '']
  for (const d of domains) {
    out.push(`## ${d.title}`, '')
    for (const q of d.questions) {
      out.push(`### ${q.q}`, '', `**答案。** ${q.a}`, '')
    }
  }
  return out.join('\n')
}

function html() {
  const cards = domains.map(d => `<section class="domain" style="--accent:${d.color}">
    <h2>${esc(d.title)}</h2>
    ${d.questions.map((q, i) => `<details class="qa"${i === 0 ? ' open' : ''}>
      <summary>${esc(q.q)}</summary>
      <p>${esc(q.a)}</p>
    </details>`).join('')}
  </section>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.title)}</title>
<style>
:root{--bg:#fff;--ink:#2c2c32;--soft:#3c3c43;--muted:#67676c;--line:#e6e6e9;--brand:#5b5bd6;--mono:"SFMono-Regular",Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","PingFang SC",sans-serif;font-size:16px;line-height:1.75}
header{max-width:1180px;margin:0 auto;padding:40px 28px 24px}h1{font-size:34px;letter-spacing:-.03em;margin:0 0 10px}p.lead{color:var(--muted);max-width:760px;margin:0}.topnav{display:flex;justify-content:space-between;gap:12px;margin-bottom:24px}.topnav a{font:11px var(--mono);color:var(--muted);text-decoration:none}.topnav a:hover{color:var(--brand)}.topnav .quiz{color:#fff;background:var(--brand);border-radius:7px;padding:7px 10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;font-weight:650}
.grid{max-width:1180px;margin:0 auto;padding:12px 28px 80px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
.domain{border:1px solid var(--line);border-radius:14px;padding:18px 18px 8px;background:#fff}.domain h2{font-size:18px;margin:0 0 12px;color:var(--accent);letter-spacing:-.01em}
.qa{border-top:1px solid var(--line);padding:10px 0}.qa summary{cursor:pointer;font-weight:600;font-size:14px;color:var(--soft);list-style:none}.qa summary::-webkit-details-marker{display:none}.qa summary:before{content:"Q ";color:var(--accent);font-family:var(--mono);font-size:11px}.qa p{margin:8px 0 4px;color:var(--muted);font-size:13.5px;line-height:1.75}
footer{max-width:1180px;margin:0 auto;padding:0 28px 40px;color:var(--muted);font-size:12px}@media(max-width:800px){.grid{grid-template-columns:1fr}h1{font-size:28px}}
</style></head><body>
<header><div class="topnav"><a href="mindmaps/course.svg">知识图谱 SVG</a><a class="quiz" href="../quiz/index.html">DSH 面试自测 →</a></div><h1>${esc(meta.title)}</h1><p class="lead">${esc(meta.intro)}</p></header>
<main class="grid">${cards}</main>
<footer>点击问题展开答案 · 共 ${domains.reduce((n, d) => n + d.questions.length, 0)} 道面试题</footer>
</body></html>`
}

function xmind() {
  let seq = 0
  const id = p => `${p}-${++seq}`
  const topic = (title, children = []) => ({ id: id('topic'), class: 'topic', title, ...children.length === 0 ? {} : { children: { attached: children } } })
  const root = topic(meta.title, domains.map(d => topic(d.title, d.questions.map(q => topic(q.q, [topic('答案：' + q.a)])))))
  const sheet = { id: id('sheet'), class: 'sheet', title: meta.title, rootTopic: { ...root, structureClass: 'org.xmind.ui.logic.right' } }
  return [sheet]
}

await mkdir(out, { recursive: true })
await writeFile(resolve(here, '../04-knowledge-map.zh.md'), markdown() + '\n')
await writeFile(resolve(here, 'knowledge-map.html'), html())
await writeFile(resolve(out, 'course.svg'), svgMap())
const sheets = xmind()
const temp = resolve(out, '.xmind-build'); await rm(temp, { recursive: true, force: true }); await mkdir(temp, { recursive: true })
await writeFile(resolve(temp, 'content.json'), JSON.stringify(sheets, null, 2))
await writeFile(resolve(temp, 'metadata.json'), JSON.stringify({ creator: { name: 'Learn DeepSeek Harness', version: '1.0' }, activeSheetId: sheets[0].id }, null, 2))
await writeFile(resolve(temp, 'manifest.json'), JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }, null, 2))
const xmindPath = resolve(out, 'course.xmind'); await rm(xmindPath, { force: true }); execFileSync('zip', ['-qr', xmindPath, '.'], { cwd: temp }); await rm(temp, { recursive: true, force: true })

const outline = (title, children = [], indent = '') => `${indent}<outline text="${esc(title)}">\n${children.join('')}${indent}</outline>\n`
const opml = `<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>${esc(meta.title)}</title></head><body>
${outline(meta.title, domains.map(d => outline(d.title, d.questions.map(q => outline(q.q, [outline('答案：' + q.a, [], '        ')], '      ')), '    ')), '  ')}
</body></opml>`
await writeFile(resolve(out, 'course.opml'), opml)
const mdOutline = [`# ${meta.title}`, '', ...domains.flatMap(d => [`## ${d.title}`, '', ...d.questions.flatMap(q => [`- **${q.q}**`, `  - 答案：${q.a}`]), ''])]
await writeFile(resolve(out, 'course.md'), mdOutline.join('\n'))
console.log('wrote 04-knowledge-map.zh.md, knowledge-map.html, course.svg, course.xmind, course.opml, course.md')
