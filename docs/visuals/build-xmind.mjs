#!/usr/bin/env node
/** 生成课程总知识导图的 XMind / OPML / Markdown 大纲。 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '../../site/data.js'), 'utf8')
globalThis.window = {}; eval(source)
const C = globalThis.window.COURSE
const out = resolve(here, 'mindmaps')
await mkdir(out, { recursive: true })
let seq = 0
const id = prefix => `${prefix}-${++seq}`
const topic = (title, children = [], extra = {}) => ({
  id: id('topic'), class: 'topic', title,
  ...children.length === 0 ? {} : { children: { attached: children } },
  ...extra,
})
const root = topic('DSH 运行时 · 28 课', C.parts.map(part => topic(
  part.title,
  part.lessons.map(slug => {
    const l = C.lessons[slug]
    return topic(`s${String(l.n).padStart(2, '0')} ${l.title}`, [
      topic('问题：' + l.short),
      topic('机制：' + l.tags.join(' / ')),
      topic('代码：' + l.source.split(',')[0]),
      topic('验收：' + l.tests),
    ])
  }),
)), { structureClass: 'org.xmind.ui.logic.right' })

const sheet = {
  id: id('sheet'), class: 'sheet', title: 'Learn DeepSeek Harness · 28 课',
  rootTopic: root,
}
const temp = resolve(out, '.xmind-build')
await rm(temp, { recursive: true, force: true })
await mkdir(temp, { recursive: true })
await writeFile(resolve(temp, 'content.json'), JSON.stringify([sheet], null, 2))
await writeFile(resolve(temp, 'metadata.json'), JSON.stringify({
  creator: { name: 'Learn DeepSeek Harness', version: '1.0' },
  activeSheetId: sheet.id,
}, null, 2))
await writeFile(resolve(temp, 'manifest.json'), JSON.stringify({
  'file-entries': { 'content.json': {}, 'metadata.json': {} },
}, null, 2))
const xmind = resolve(out, 'course.xmind')
await rm(xmind, { force: true })
execFileSync('zip', ['-qr', xmind, '.'], { cwd: temp })
await rm(temp, { recursive: true, force: true })

function opmlTopic(title, children = [], indent = '') {
  const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  return `${indent}<outline text="${esc(title)}">\n${children.join('')}${indent}</outline>\n`
}
const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0"><head><title>Learn DeepSeek Harness 28 课</title></head><body>
${opmlTopic('DSH 运行时 · 28 课', C.parts.map(part => opmlTopic(part.title, part.lessons.map(slug => {
  const l = C.lessons[slug]
  return opmlTopic(`s${String(l.n).padStart(2, '0')} ${l.title}`, [opmlTopic('问题：' + l.short), opmlTopic('机制：' + l.tags.join(' / ')), opmlTopic('代码：' + l.source.split(',')[0])])
}), '  ')), '  ')}
</body></opml>`
await writeFile(resolve(out, 'course.opml'), opml)

const md = ['# Learn DeepSeek Harness · 28 课知识导图', '']
for (const part of C.parts) {
  md.push(`## ${part.title}`, '')
  for (const slug of part.lessons) {
    const l = C.lessons[slug]
    md.push(`- **s${String(l.n).padStart(2, '0')} ${l.title}**`)
    md.push(`  - 问题：${l.short}`)
    md.push(`  - 机制：${l.tags.join(' / ')}`)
    md.push(`  - 代码：${l.source.split(',')[0]}`)
  }
  md.push('')
}
await writeFile(resolve(out, 'course.md'), md.join('\n'))
console.log('wrote course.xmind, course.opml, course.md')
