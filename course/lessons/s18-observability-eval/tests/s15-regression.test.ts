/** s15 离线测试：MCP、skills、commands。 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
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
} from '../src/index.ts'

const mock = fileURLToPath(new URL('../src/mock-mcp-server.ts', import.meta.url))

test('mcp: initialize, list and call echo', async () => {
  const client = await McpClient.connect(process.execPath, [mock])
  try {
    const tools = await client.listTools()
    assert.deepEqual(tools.map(tool => tool.name), ['echo'])
    const registry = new ToolRegistry()
    for (const tool of mcpTools(client, 'mock', tools)) registry.register(tool)
    const result = await registry.execute({
      type: 'tool-call', id: 'c', name: 'mcp__mock__echo', arguments: JSON.stringify({ text: 'hi' }),
    }, { signal: new AbortController().signal, callId: 'c', sessionId: 's' })
    assert.equal(result.isError, false)
    assert.equal(textOf({ id: 'x', role: 'tool', content: result.content }), 'echo:hi')
  } finally {
    client.close()
  }
})

test('mcp: unknown tool becomes a model-visible error', async () => {
  const client = await McpClient.connect(process.execPath, [mock])
  try {
    await assert.rejects(async () => client.callTool('nope', {}), /unknown tool/)
  } finally {
    client.close()
  }
})

test('skills: scan frontmatter, catalog and load', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-s15-test-'))
  try {
    await mkdir(join(root, 'pdf'))
    await mkdir(join(root, 'empty'))
    await writeFile(join(root, 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Read PDF files\n---\n# PDF\nUse pdftotext.\n')
    const catalog = new SkillCatalog(root)
    await catalog.refresh()
    assert.equal(catalog.catalogText(), '- pdf: Read PDF files')
    assert.match(catalog.load('pdf'), /pdftotext/)
    assert.throws(() => catalog.load('missing'), /unknown skill/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commands: dispatch slash commands directly, pass through normal input', async () => {
  const registry = new CommandRegistry()
  registry.register({ name: 'help', description: 'help', run: () => 'help text' })
  assert.deepEqual(await registry.dispatch('hello'), { handled: false })
  assert.deepEqual(await registry.dispatch('/help'), { handled: true, output: 'help text' })
  assert.match((await registry.dispatch('/missing')).output ?? '', /unknown command/)
})
