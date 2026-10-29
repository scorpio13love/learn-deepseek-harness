/**
 * s15 · MCP / skills / commands：沿用前序课程的实现（本课改动见 README）。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CommandRegistry,
  McpClient,
  mcpTools,
  SkillCatalog,
  textOf,
  ToolRegistry,
} from './index.ts'

async function main(): Promise<void> {
  const mock = fileURLToPath(new URL('./mock-mcp-server.ts', import.meta.url))
  const client = await McpClient.connect(process.execPath, [mock])
  try {
    const tools = await client.listTools()
    console.log('mcp tools:', tools.map(tool => tool.name))
    const registry = new ToolRegistry()
    for (const tool of mcpTools(client, 'mock', tools)) registry.register(tool)
    const result = await registry.execute({
      type: 'tool-call', id: 'c', name: 'mcp__mock__echo', arguments: JSON.stringify({ text: 'hello' }),
    }, { signal: new AbortController().signal, callId: 'c', sessionId: 's' })
    console.log('mcp call:', textOf({ id: 'x', role: 'tool', content: result.content }))
  } finally {
    client.close()
  }

  const root = await mkdtemp(join(tmpdir(), 'dsh-s15-skills-'))
  try {
    await mkdir(join(root, 'pdf'))
    await writeFile(join(root, 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Read PDF files\n---\n# PDF\nUse pdftotext.\n')
    const catalog = new SkillCatalog(root)
    await catalog.refresh()
    console.log('skills:\n' + catalog.catalogText())
    console.log('load pdf:', catalog.load('pdf').trim())
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  const commands = new CommandRegistry()
  commands.register({ name: 'help', description: 'Show help', run: () => 'commands: /help' })
  console.log('command:', await commands.dispatch('/help'))
  console.log('not a command:', await commands.dispatch('hello'))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
