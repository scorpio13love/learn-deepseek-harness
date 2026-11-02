/**
 * s18 的 skill 目录。
 *
 * 真实 DSH 的 skill 是「可复用指令包」：
 *   - `<root>/<name>/SKILL.md`（bundle）或 `<root>/<name>.md`（flat）；
 *   - frontmatter 只带元数据（name / description）；
 *   - 启动时只把 catalog（名字 + 描述）注入上下文，正文按需加载。
 *
 * 这样做的核心收益：技能正文可能很长，但不一定每次都用；把所有正文
 * 塞进系统提示词既贵又会让模型分心。
 */

import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

export interface Skill {
  name: string
  description: string
  /** SKILL.md 或 flat .md 的绝对/相对路径。 */
  path: string
  /** frontmatter 之后的正文。 */
  body: string
  source: 'bundle' | 'flat'
}

export interface Frontmatter {
  meta: Record<string, string>
  body: string
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'")
    }
  }
  return value
}

/** 解析 `---` 包围的简单 key: value frontmatter；无法识别时 body 原文返回。 */
export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { meta: {}, body: text }
  let end = normalized.indexOf('\n---\n', 4)
  let bodyStart = end + 5
  if (end < 0 && normalized.endsWith('\n---')) {
    end = normalized.length - 4
    bodyStart = normalized.length
  }
  if (end < 0) return { meta: {}, body: text }

  const meta: Record<string, string> = {}
  for (const line of normalized.slice(4, end).split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (match !== null) meta[match[1]!] = unquote(match[2]!.trim())
  }
  return { meta, body: normalized.slice(bodyStart) }
}

async function readSkill(path: string, fallbackName: string, source: Skill['source']): Promise<Skill | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  const { meta, body } = parseFrontmatter(text)
  return {
    name: meta.name ?? fallbackName,
    description: meta.description ?? '',
    path,
    body,
    source,
  }
}

/** 扫描一个 skill 根目录：bundle 目录优先，其次 flat `.md` 文件。 */
export async function scanSkills(root: string): Promise<Skill[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const skills: Skill[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skill = await readSkill(join(root, entry.name, 'SKILL.md'), entry.name, 'bundle')
    if (skill !== undefined) skills.push(skill)
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'SKILL.md') continue
    const name = basename(entry.name, '.md')
    const skill = await readSkill(join(root, entry.name), name, 'flat')
    if (skill !== undefined) skills.push(skill)
  }

  // 同名时 bundle 优先（先出现的保留），再按名字排序。
  const byName = new Map<string, Skill>()
  for (const skill of skills) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export class SkillCatalog {
  readonly root: string
  #skills = new Map<string, Skill>()

  constructor(root: string) {
    this.root = root
  }

  async refresh(): Promise<void> {
    this.#skills = new Map((await scanSkills(this.root)).map(skill => [skill.name, skill]))
  }

  list(): Skill[] {
    return [...this.#skills.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get(name: string): Skill | undefined {
    return this.#skills.get(name)
  }

  /** 注入给模型的目录文本：只有名字和描述，不含正文。 */
  catalogText(): string {
    return this.list().map(skill => `- ${skill.name}: ${skill.description}`).join('\n')
  }

  /**
   * 按需加载完整正文。
   * 返回值去掉首尾空白，便于直接作为一个文本块交给模型。
   */
  load(name: string): string {
    const skill = this.#skills.get(name)
    if (skill === undefined) throw new Error(`unknown skill "${name}"`)
    return skill.body.trim()
  }
}
