/**
 * s18 demo：skill catalog、按需加载、slash command 路由。
 *
 *   cd course/lessons-v3/s18-skills-commands
 *   node src/demo.ts
 *
 * 完全离线：在临时目录里造两个 skill，扫描、列目录、加载正文，
 * 再用一个假 agent 证明命令不会产生模型轮次。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CommandRegistry,
  createLoadSkillTool,
  routeInput,
  SkillCatalog,
  ToolRegistry,
  toolResultText,
} from './index.ts'

const PDF_SKILL = `---
name: pdf
description: Fill, split and inspect PDF forms. Use when the task involves a .pdf file.
---

# PDF workflow

1. Inspect the form fields before filling anything.
2. Fill values with the exact field names.
3. Re-render and verify the output.
`

const REVIEW_SKILL = `---
name: review
description: "Review a diff for correctness, tests and risk."
---

# Review workflow

1. Read the diff, then the surrounding code.
2. Check behavior changes against tests.
3. Report only actionable findings.
`

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-s18-skills-'))
  try {
    await mkdir(join(root, 'pdf'), { recursive: true })
    await writeFile(join(root, 'pdf', 'SKILL.md'), PDF_SKILL)
    await writeFile(join(root, 'review.md'), REVIEW_SKILL)

    const catalog = new SkillCatalog(root)
    await catalog.refresh()

    console.log('=== catalog (what the model sees at startup) ===')
    console.log(catalog.catalogText())

    console.log('\n=== load on demand ===')
    const pdf = catalog.load('pdf')
    console.log(`pdf: ${pdf.length} chars, first line: ${pdf.split('\n')[0]}`)

    const tools = new ToolRegistry()
    tools.register(createLoadSkillTool(catalog))
    const loaded = await tools.execute(
      { id: 'call-1', name: 'load_skill', arguments: JSON.stringify({ name: 'review' }) },
      { signal: new AbortController().signal, callId: 'call-1' },
    )
    console.log(`load_skill(review): isError=${loaded.isError}, ${toolResultText(loaded).length} chars`)

    const commands = new CommandRegistry()
    commands.register({ name: 'help', description: 'Show help', run: () => 'commands: /help /skills' })
    commands.register({ name: 'skills', description: 'List the skill catalog', run: () => catalog.catalogText() })

    let turns = 0
    const agent = {
      async run(prompt: string): Promise<string> {
        turns += 1
        return `[offline] would ask the model: ${prompt}`
      },
    }

    console.log('\n=== routing ===')
    for (const input of ['/help', '/skills pdf', 'please review this diff']) {
      const result = await routeInput(input, { commands, agent })
      console.log(`${input.padEnd(30)} -> ${result.kind.padEnd(7)} modelTurn=${result.modelTurn} turns=${turns}`)
      console.log(`  output: ${JSON.stringify(result.output.slice(0, 70))}`)
    }
    console.log(`\nmodel turns: ${turns} (slash commands contributed 0)`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
