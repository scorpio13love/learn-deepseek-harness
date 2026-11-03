#!/usr/bin/env node
/** 生成知识图谱 XMind / OPML / Markdown；一个总图谱 + 每课一张知识点 sheet。 */
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lessons, course } from './mindmap-data.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, 'mindmaps')
await mkdir(out, { recursive: true })
let seq = 0
const id = prefix => `${prefix}-${++seq}`
const topic = (title, children = [], extra = {}) => ({
  id: id('topic'), class: 'topic', title,
  ...children.length === 0 ? {} : { children: { attached: children } },
  ...extra,
})
const sheetOf = (title, rootTitle, branches) => ({
  id: id('sheet'), class: 'sheet', title,
  rootTopic: topic(rootTitle, branches.map(([label, leaves]) => topic(label, leaves.map(leaf => topic(leaf)))), { structureClass: 'org.xmind.ui.logic.right' }),
})
const sheets = [
  sheetOf('总图谱 · DSH 运行时', course.title, course.branches),
  ...lessons.map(([, title, branches]) => sheetOf(title, title, branches)),
]
const temp = resolve(out, '.xmind-build')
await rm(temp, { recursive: true, force: true })
await mkdir(temp, { recursive: true })
await writeFile(resolve(temp, 'content.json'), JSON.stringify(sheets, null, 2))
await writeFile(resolve(temp, 'metadata.json'), JSON.stringify({
  creator: { name: 'Learn DeepSeek Harness', version: '1.0' },
  activeSheetId: sheets[0].id,
}, null, 2))
await writeFile(resolve(temp, 'manifest.json'), JSON.stringify({
  'file-entries': { 'content.json': {}, 'metadata.json': {} },
}, null, 2))
const xmind = resolve(out, 'course.xmind')
await rm(xmind, { force: true })
execFileSync('zip', ['-qr', xmind, '.'], { cwd: temp })
await rm(temp, { recursive: true, force: true })

const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const outline = (title, children = [], indent = '') => `${indent}<outline text="${esc(title)}">\n${children.join('')}${indent}</outline>\n`
const branchOpml = branches => branches.map(([label, leaves]) => outline(label, leaves.map(leaf => outline(leaf, [], '      ')), '    '))
const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0"><head><title>${esc(course.title)}</title></head><body>
${outline(course.title, branchOpml(course.branches), '  ')}
${lessons.map(([, title, branches]) => outline(title, branchOpml(branches), '  ')).join('')}
</body></opml>`
await writeFile(resolve(out, 'course.opml'), opml)

const md = [`# ${course.title}`, '', `> ${course.subtitle}`, '']
md.push('## 总图谱', '')
for (const [label, leaves] of course.branches) {
  md.push(`### ${label}`, '')
  for (const leaf of leaves) md.push(`- ${leaf}`)
  md.push('')
}
md.push('## 每课知识点', '')
for (const [, title, branches] of lessons) {
  md.push(`### ${title}`, '')
  for (const [label, leaves] of branches) {
    md.push(`- **${label}**`)
    for (const leaf of leaves) md.push(`  - ${leaf}`)
  }
  md.push('')
}
await writeFile(resolve(out, 'course.md'), md.join('\n'))
console.log(`wrote course.xmind (${sheets.length} sheets), course.opml, course.md`)
