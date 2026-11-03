#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lessons } from './flow-specs.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

function strip(md) {
  md = md.split(/\n---\s*\n/)[0]
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function section(md, names) {
  for (const name of names) {
    const re = new RegExp(`#{2,3}\\s*(?:\\d+(?:\\.\\d+)*\\s*)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n([\\s\\S]*?)(?=\\n#{2,3}|\n---|$)`)
    const m = md.match(re)
    if (m) {
      const text = strip(m[1])
      if (text) return text.length > 220 ? `${text.slice(0, 217)}…` : text
    }
  }
  return ''
}

const out = {}
for (const [slug, n, title, subtitle, part, nodes, anchor] of lessons) {
  const md = await readFile(resolve(root, 'course/lessons', slug, 'README.md'), 'utf8')
  const what = section(md, ['这一课学什么', '学什么'])
  const why = section(md, ['DeepSeek 为什么这么做', 'DSH 为什么这样拆？', 'DSH 为什么这样设计？', '为什么'])
  const scene = section(md, ['服务的场景', '场景'])
  out[`s${String(n).padStart(2, '0')}`] = { slug, n, title, subtitle, part, nodes, anchor, what, why, scene }
}
const body = `window.FLOW = ${JSON.stringify(out, null, 2)};\n`
await writeFile(resolve(here, 'flow-data.js'), body)
console.log(`wrote flow data for ${Object.keys(out).length} lessons`)
