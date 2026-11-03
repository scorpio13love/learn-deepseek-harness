#!/usr/bin/env node
/** 生成 28 张“知识点”思维导图 + 一张 DSH 知识图谱（SVG）。 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lessons, course } from './mindmap-data.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, 'mindmaps')
const source = await readFile(resolve(here, '../../site/data.js'), 'utf8')
globalThis.window = {}; eval(source)
const C = globalThis.window.COURSE
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const palette = { core:'#5b5bd6', context:'#0c93ad', composition:'#8b5cf6', execution:'#b87412', product:'#158a63', quality:'#b33a3a' }
const partOf = slug => C.lessons[slug]?.part || 'core'
const partTitle = slug => C.parts.find(p => p.id === partOf(slug))?.title || ''

function wrap(text, width = 22) {
  const chars = [...String(text)]
  const lines = []
  for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join(''))
  return lines.slice(0, 3)
}
function textLines(lines, x, y, size, color, weight = 400, anchor = 'start') {
  return lines.map((line, i) => `<text x="${x}" y="${y + i * (size + 3)}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${esc(line)}</text>`).join('')
}
function lessonMap([slug, title, branches]) {
  const p = palette[partOf(slug)]; const W = 1200, H = 780, cx = 138, cy = H / 2
  const nodeX = 360; const top = 62; const gap = (H - 142) / branches.length
  const branchSvg = branches.map(([label, leaves], i) => {
    const y = top + i * gap
    return `<path d="M${cx + 58} ${cy} C${cx + 170} ${cy} ${nodeX - 70} ${y + 20} ${nodeX} ${y + 20}" fill="none" stroke="${p}" stroke-opacity=".4" stroke-width="1.4"/>
      <rect x="${nodeX}" y="${y}" width="205" height="42" rx="9" fill="${p}"/>
      <text x="${nodeX + 16}" y="${y + 26}" font-size="13.5" font-weight="700" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${esc(label)}</text>
      ${textLines(leaves.flatMap((leaf, k) => wrap(leaf, 28).map((line, j) => `${j === 0 ? '• ' : '  '}${line}`)).slice(0, 7), nodeX + 232, y + 22, 10.5, '#3c3c43')}`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title">
  <title id="title">${esc(title)} 知识点导图</title>
  <defs><pattern id="g" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="#303a63" stroke-opacity=".035"/></pattern></defs>
  <rect width="${W}" height="${H}" fill="#fbfcff"/><rect width="${W}" height="${H}" fill="url(#g)"/>
  <text x="48" y="40" font-size="9" letter-spacing=".12em" fill="${p}" font-family="SFMono-Regular,Consolas,monospace">${esc(title.split(' · ')[0].toUpperCase())} · ${esc(partTitle(slug).toUpperCase())} · KNOWLEDGE POINTS</text>
  <text x="48" y="68" font-size="21" font-weight="750" fill="#222733" letter-spacing="-.02em" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${esc(title.split(' · ').slice(1).join(' · '))}</text>
  <circle cx="${cx}" cy="${cy}" r="58" fill="${p}"/>
  <text x="${cx}" y="${cy - 18}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,.7)" font-family="SFMono-Regular,Consolas,monospace">${esc(title.split(' · ')[0].toUpperCase())}</text>
  ${textLines(wrap(title.split(' · ').slice(1).join(' · '), 12), cx, cy + 4, 11, '#fff', 700, 'middle')}
  ${branchSvg}
  <line x1="48" y1="${H - 46}" x2="${W - 48}" y2="${H - 46}" stroke="#e3e6ef"/>
  <text x="48" y="${H - 24}" font-size="9" fill="#a0a6b6" font-family="SFMono-Regular,Consolas,monospace">${esc(C.lessons[slug]?.source.split(',')[0] || '')}</text>
  <text x="${W - 48}" y="${H - 24}" text-anchor="end" font-size="9" fill="#a0a6b6" font-family="SFMono-Regular,Consolas,monospace">Learn DeepSeek Harness · knowledge map</text>
</svg>`
}

function courseMap() {
  const W = 1600, H = 760, cx = W / 2, cy = 86
  const cols = course.branches.length; const colW = W / cols
  const branches = course.branches.map(([label, leaves], i) => {
    const x = i * colW + 38; const color = ['#5b5bd6','#0c93ad','#8b5cf6','#b87412','#158a63','#b33a3a'][i]
    const rows = leaves.map((leaf, j) => {
      const y = 260 + j * 92
      return `<path d="M${x + 100} 208 C${x + 100} ${y} ${x + 105} ${y} ${x + 120} ${y}" fill="none" stroke="${color}" stroke-opacity=".35" stroke-width="1.1"/>
        <circle cx="${x + 120}" cy="${y}" r="3.5" fill="${color}"/>
        ${textLines(wrap(leaf, 19).slice(0, 2), x + 134, y + 4, 10.5, '#2c2c32')}`
    }).join('')
    return `<path d="M${cx} ${cy + 54} C${cx} 160 ${x + 100} 150 ${x + 100} 205" fill="none" stroke="${color}" stroke-opacity=".38" stroke-width="1.4"/>
      <rect x="${x}" y="165" width="200" height="44" rx="10" fill="${color}"/>
      <text x="${x + 14}" y="192" font-size="12.5" font-weight="700" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${esc(label)}</text>
      ${rows}`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title">
  <title id="title">DeepSeek Harness 知识图谱</title>
  <rect width="${W}" height="${H}" fill="#fbfcff"/>
  <g stroke="#303a63" stroke-opacity=".03"><path d="M0 0H1600M0 120H1600M0 240H1600M0 360H1600M0 480H1600M0 600H1600M0 720H1600M0 840H1600"/></g>
  <text x="48" y="38" font-size="9" letter-spacing=".12em" fill="#5b5bd6" font-family="SFMono-Regular,Consolas,monospace">DEEPSEEK HARNESS · KNOWLEDGE GRAPH</text>
  <text x="48" y="68" font-size="24" font-weight="760" fill="#222733" letter-spacing="-.02em" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${esc(course.title)}</text>
  <rect x="${cx - 160}" y="48" width="320" height="72" rx="16" fill="#222733"/>
  <text x="${cx}" y="76" text-anchor="middle" font-size="11" fill="rgba(255,255,255,.65)" font-family="SFMono-Regular,Consolas,monospace">SIX DOMAINS · NOT A LESSON LIST</text>
  <text x="${cx}" y="102" text-anchor="middle" font-size="16" font-weight="700" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif">${esc(course.subtitle)}</text>
  ${branches}
  <text x="48" y="${H - 28}" font-size="9" fill="#a0a6b6" font-family="SFMono-Regular,Consolas,monospace">控制面 → 事实 → 工具 → 组合 → 执行 → 质量</text>
</svg>`
}

await mkdir(outDir, { recursive: true })
for (const item of lessons) await writeFile(resolve(outDir, `${item[0].slice(0,3)}.svg`), lessonMap(item))
await writeFile(resolve(outDir, 'course.svg'), courseMap())
console.log(`wrote ${lessons.length} knowledge maps + course.svg`)
