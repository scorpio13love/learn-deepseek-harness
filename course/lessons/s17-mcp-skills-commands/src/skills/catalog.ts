/** s15 的 skill 目录：扫描 SKILL.md，按需加载正文。 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface Skill {
  name: string
  description: string
  path: string
  body: string
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith('---\n')) return { meta: {}, body: text }
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (match !== null) meta[match[1]!] = match[2]!.trim()
  }
  return { meta, body: text.slice(end + 5) }
}

export async function scanSkills(root: string): Promise<Skill[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const skills: Skill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name, 'SKILL.md')
    try {
      const text = await readFile(path, 'utf8')
      const { meta, body } = parseFrontmatter(text)
      skills.push({
        name: meta.name ?? entry.name,
        description: meta.description ?? '',
        path,
        body,
      })
    } catch {
      // 没有 SKILL.md 的目录不是技能。
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
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
    return [...this.#skills.values()]
  }

  /** 注入给模型的目录文本；正文按需 load。 */
  catalogText(): string {
    return this.list().map(skill => `- ${skill.name}: ${skill.description}`).join('\n')
  }

  load(name: string): string {
    const skill = this.#skills.get(name)
    if (skill === undefined) throw new Error(`unknown skill "${name}"`)
    return skill.body
  }
}
