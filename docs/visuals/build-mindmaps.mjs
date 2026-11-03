#!/usr/bin/env node
/** 生成 28 张本课知识导图 + 一张总知识导图（SVG）。 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, 'mindmaps')
const source = await readFile(resolve(here, '../../site/data.js'), 'utf8')
globalThis.window = {}
eval(source)
const C = globalThis.window.COURSE
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const palette = { core:'#5b5bd6', context:'#0c93ad', composition:'#8b5cf6', execution:'#b87412', product:'#158a63', quality:'#b33a3a' }
const soft = { core:'#ecebff', context:'#e5f8fb', composition:'#f1eafe', execution:'#fff3dd', product:'#e8f8f1', quality:'#fbeaea' }

function wrap(text, width = 20) {
  const words = String(text)
  if (/[\u4e00-\u9fff]/.test(words)) {
    const chars = [...words]; const lines = []
    for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join(''))
    return lines.slice(0, 3)
  }
  const out = []; let line = ''
  for (const word of words.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > width) { if (line) out.push(line); line = word }
    else line = (line + ' ' + word).trim()
  }
  if (line) out.push(line)
  return out.slice(0, 3)
}

function textLines(lines, x, y, size, color, weight = 400, anchor = 'start') {
  return lines.map((line, i) => `<text x="${x}" y="${y + i * (size + 3)}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${esc(line)}</text>`).join('')
}

function partOf(slug) { return C.lessons[slug].part }
function lessonMindmap(slug) {
  const l = C.lessons[slug]; const p = palette[l.part]; const s = soft[l.part]
  const part = C.parts.find(x => x.id === l.part)
  const branches = [
    { title: '本课问题', color: p, leaves: [l.short, l.desc] },
    { title: '机制', color: p, leaves: l.tags.slice(0, 3) },
    { title: '代码', color: p, leaves: [l.source.split(',')[0].split('/').pop() || l.source, 'src/'] },
    { title: '验收', color: p, leaves: [l.tests, `难度 ${'●'.repeat(l.difficulty)}`] },
    { title: '连接', color: p, leaves: [part?.title || l.part, `第 ${l.n} / 28 课`] },
  ]
  const W = 1080, H = 620, cx = 126, cy = H / 2, bx = 330, by = 74
  const branchSvg = branches.map((b, i) => {
    const y = by + i * 108
    const leaves = b.leaves.flatMap(x => wrap(x, 22)).slice(0, 4)
    return `<path d="M${cx + 54} ${cy} C${cx + 160} ${cy} ${bx - 60} ${y + 20} ${bx} ${y + 20}" fill="none" stroke="${b.color}" stroke-opacity=".4" stroke-width="1.4"/>
      <rect x="${bx}" y="${y}" width="190" height="40" rx="9" fill="${b.color}"/>
      <text x="${bx + 16}" y="${y + 25}" font-size="13" font-weight="700" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${esc(b.title)}</text>
      ${textLines(leaves, bx + 210, y + 22, 11, '#3c3c43')}`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title">
  <title id="title">s${String(l.n).padStart(2,'0')} ${esc(l.title)} 知识导图</title>
  <defs><pattern id="g" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="#303a63" stroke-opacity=".035"/></pattern></defs>
  <rect width="${W}" height="${H}" fill="#fbfcff"/><rect width="${W}" height="${H}" fill="url(#g)"/>
  <text x="48" y="44" font-size="9" letter-spacing=".12em" fill="${p}" font-family="SFMono-Regular,Consolas,monospace">S${String(l.n).padStart(2,'0')} · ${(part?.title || l.part).toUpperCase()} · KNOWLEDGE MAP</text>
  <text x="48" y="72" font-size="22" font-weight="750" fill="#222733" letter-spacing="-.02em" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${esc(l.title)}</text>
  <circle cx="${cx}" cy="${cy}" r="54" fill="${p}"/>
  <text x="${cx}" y="${cy - 18}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,.72)" font-family="SFMono-Regular,Consolas,monospace">S${String(l.n).padStart(2,'0')}</text>
  ${textLines(wrap(l.title, 12), cx, cy + 4, 11, '#fff', 700, 'middle')}
  ${branchSvg}
  <line x1="48" y1="${H - 50}" x2="${W - 48}" y2="${H - 50}" stroke="#e3e6ef"/>
  <text x="48" y="${H - 26}" font-size="9" fill="#a0a6b6" font-family="SFMono-Regular,Consolas,monospace">Learn DeepSeek Harness · 28 lessons v3</text>
  <text x="${W - 48}" y="${H - 26}" text-anchor="end" font-size="9" fill="#a0a6b6" font-family="SFMono-Regular,Consolas,monospace">${esc(l.source.split(',')[0])}</text>
</svg>`
}

function courseMindmap() {
  const W = 1600, H = 1020, cx = 800, cy = 92
  const parts = C.parts
  const colW = 245
  const branchSvg = parts.map((part, i) => {
    const x = 90 + i * 250
    const color = palette[part.id] || '#5b5bd6'
    const lessons = part.lessons
    const rows = lessons.map((slug, j) => {
      const l = C.lessons[slug]; const y = 248 + j * 82
      return `<path d="M${x + 106} 206 C${x + 106} ${y} ${x + 110} ${y} ${x + 126} ${y}" fill="none" stroke="${color}" stroke-opacity=".35" stroke-width="1.1"/>
        <circle cx="${x + 126}" cy="${y}" r="3" fill="${color}" opacity=".8"/>
        <text x="${x + 138}" y="${y + 4}" font-size="11" font-weight="600" fill="#2c2c32" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${String(l.n).padStart(2,'0')} ${esc(l.short)}</text>
        <text x="${x + 138}" y="${y + 18}" font-size="8.5" fill="#8a8f9c" font-family="SFMono-Regular,Consolas,monospace">${esc(l.tags[0] || '')}</text>`
    }).join('')
    return `<path d="M${cx} ${cy + 54} C${cx} 160 ${x + 106} 140 ${x + 106} 190" fill="none" stroke="${color}" stroke-opacity=".38" stroke-width="1.4"/>
      <rect x="${x}" y="160" width="212" height="46" rx="10" fill="${color}"/>
      <text x="${x + 14}" y="188" font-size="12.5" font-weight="700" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${esc(part.title)}</text>
      ${rows}`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title">
  <title id="title">Learn DeepSeek Harness 28 课知识导图</title>
  <rect width="${W}" height="${H}" fill="#fbfcff"/>
  <g stroke="#303a63" stroke-opacity=".03"><path d="M0 0H1600M0 120H1600M0 240H1600M0 360H1600M0 480H1600M0 600H1600M0 720H1600M0 840H1600M0 960H1600"/></g>
  <text x="48" y="40" font-size="9" letter-spacing=".12em" fill="#5b5bd6" font-family="SFMono-Regular,Consolas,monospace">LEARN DEEPSEEK HARNESS · KNOWLEDGE MAP V3</text>
  <text x="48" y="70" font-size="24" font-weight="760" fill="#222733" letter-spacing="-.02em" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">从 loop 到 computer use：28 课的知识树</text>
  <rect x="${cx - 150}" y="${cy - 40}" width="300" height="80" rx="18" fill="#222733"/>
  <text x="${cx}" y="${cy - 18}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,.65)" font-family="SFMono-Regular,Consolas,monospace">28 LESSONS · 6 PARTS</text>
  <text x="${cx}" y="${cy + 20}" text-anchor="middle" font-size="17" font-weight="700" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">DSH 运行时</text>
  ${branchSvg}
  <text x="48" y="${H - 28}" font-size="9" fill="#a0a6b6" font-family="SFMono-Regular,Consolas,monospace">内核 → 上下文 → 组合 → 执行 → 产品 → 质量</text>
</svg>`
}

await mkdir(outDir, { recursive: true })
for (const slug of Object.keys(C.lessons)) {
  await writeFile(resolve(outDir, `${slug.slice(0,3)}.svg`), lessonMindmap(slug))
}
await writeFile(resolve(outDir, 'course.svg'), courseMindmap())
console.log(`wrote ${Object.keys(C.lessons).length} lesson mindmaps + course.svg`)
