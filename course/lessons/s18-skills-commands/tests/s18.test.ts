/**
 * s18 离线测试：skills catalog、load_skill 工具、slash commands 路由。
 *
 * 全部使用临时目录和本地假 agent，不访问网络、不需要 key。
 *
 * 运行：
 *   cd course/lessons-v3/s18-skills-commands
 *   node --test tests/s18.test.ts
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import {
  CommandRegistry,
  createLoadSkillTool,
  parseFrontmatter,
  routeInput,
  scanSkills,
  SkillCatalog,
  ToolRegistry,
  toolResultText,
} from '../src/index.ts'

let root: string

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-s18-test-'))
  await mkdir(join(root, 'pdf'), { recursive: true })
  await writeFile(join(root, 'pdf', 'SKILL.md'), `---
name: pdf
description: Fill and inspect PDF forms. Use when the task involves a .pdf file.
---

# PDF workflow

1. Inspect the form fields.
2. Fill exact field names.
`)
  await writeFile(join(root, 'review.md'), `---
name: review
description: "Review a diff: correctness, tests and risk."
---

# Review workflow

1. Read the diff.
`)
  await mkdir(join(root, 'empty'), { recursive: true })
  await writeFile(join(root, 'notes.txt'), 'not a skill')
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

const signal = (): AbortSignal => new AbortController().signal

// ---------------------------------------------------------------------------
// 扫描 / catalog / 按需加载
// ---------------------------------------------------------------------------

test('skills: scan bundle + flat files, parse frontmatter and sort by name', async () => {
  const skills = await scanSkills(root)

  assert.deepEqual(skills.map(skill => skill.name), ['pdf', 'review'])
  assert.equal(skills[0]?.source, 'bundle')
  assert.equal(skills[1]?.source, 'flat')
  assert.equal(skills[1]?.description, 'Review a diff: correctness, tests and risk.')
  assert.match(skills[0]?.path ?? '', /pdf[/\\]SKILL\.md$/)
  assert.match(skills[1]?.path ?? '', /review\.md$/)
})

test('skills: the catalog exposes names + descriptions, never bodies', async () => {
  const catalog = new SkillCatalog(root)
  await catalog.refresh()

  assert.deepEqual(catalog.list().map(skill => skill.name), ['pdf', 'review'])
  assert.equal(
    catalog.catalogText(),
    [
      '- pdf: Fill and inspect PDF forms. Use when the task involves a .pdf file.',
      '- review: Review a diff: correctness, tests and risk.',
    ].join('\n'),
  )
  // 正文没有进入 catalog。
  assert.equal(catalog.catalogText().includes('PDF workflow'), false)
  assert.equal(catalog.catalogText().includes('Read the diff'), false)
})

test('skills: load returns the body on demand, without frontmatter', async () => {
  const catalog = new SkillCatalog(root)
  await catalog.refresh()

  const body = catalog.load('pdf')
  assert.match(body, /^# PDF workflow/)
  assert.match(body, /Inspect the form fields/)
  assert.equal(body.includes('description:'), false)
  assert.equal(body.includes('---'), false)

  assert.throws(() => catalog.load('missing'), /unknown skill/)
})

test('skills: malformed directories and non-markdown files are ignored', async () => {
  const catalog = new SkillCatalog(root)
  await catalog.refresh()
  const names = catalog.list().map(skill => skill.name)
  assert.equal(names.includes('empty'), false)
  assert.equal(names.includes('notes'), false)
})

test('skills: parseFrontmatter handles quotes, colons and missing frontmatter', () => {
  const parsed = parseFrontmatter(`---
name: review
description: "Review a diff: correctness, tests."
---

body here`)
  assert.deepEqual(parsed.meta, {
    name: 'review',
    description: 'Review a diff: correctness, tests.',
  })
  assert.equal(parsed.body.trim(), 'body here')

  const plain = parseFrontmatter('no frontmatter')
  assert.deepEqual(plain.meta, {})
  assert.equal(plain.body, 'no frontmatter')
})

// ---------------------------------------------------------------------------
// 模型可见的 load_skill 工具
// ---------------------------------------------------------------------------

test('tool: load_skill is model-visible and returns the requested skill body', async () => {
  const catalog = new SkillCatalog(root)
  await catalog.refresh()
  const tools = new ToolRegistry()
  tools.register(createLoadSkillTool(catalog))

  assert.deepEqual(tools.schemas().map(schema => schema.name), ['load_skill'])
  assert.deepEqual(tools.schemas()[0]?.parameters.required, ['name'])

  const result = await tools.execute(
    { id: 'c1', name: 'load_skill', arguments: JSON.stringify({ name: 'review' }) },
    { signal: signal(), callId: 'c1' },
  )

  assert.equal(result.isError, false)
  assert.match(toolResultText(result), /# Review workflow/)
  assert.match(toolResultText(result), /Read the diff/)
})

test('tool: unknown skill, missing name and invalid JSON become error results', async () => {
  const catalog = new SkillCatalog(root)
  await catalog.refresh()
  const tools = new ToolRegistry()
  tools.register(createLoadSkillTool(catalog))
  const ctx = { signal: signal(), callId: 'c1' }

  const unknown = await tools.execute(
    { id: 'c1', name: 'load_skill', arguments: '{"name":"nope"}' }, ctx,
  )
  assert.equal(unknown.isError, true)
  assert.match(toolResultText(unknown), /unknown skill "nope"/)

  const missing = await tools.execute({ id: 'c1', name: 'load_skill', arguments: '{}' }, ctx)
  assert.equal(missing.isError, true)
  assert.match(toolResultText(missing), /"name" is required/)

  const badJson = await tools.execute({ id: 'c1', name: 'load_skill', arguments: '{bad' }, ctx)
  assert.equal(badJson.isError, true)
  assert.match(toolResultText(badJson), /invalid JSON/)

  const unknownTool = await tools.execute({ id: 'c1', name: 'nope', arguments: '{}' }, ctx)
  assert.equal(unknownTool.isError, true)
  assert.match(toolResultText(unknownTool), /unknown tool/)
})

// ---------------------------------------------------------------------------
// slash commands
// ---------------------------------------------------------------------------

test('commands: dispatch slash commands directly and pass through normal input', async () => {
  const commands = new CommandRegistry()
  commands.register({
    name: 'echo',
    description: 'Echo args',
    run: args => `echo:${args}`,
  })

  assert.deepEqual(await commands.dispatch('/echo hello world'), {
    handled: true,
    output: 'echo:hello world',
  })
  assert.deepEqual(await commands.dispatch('/echo'), { handled: true, output: 'echo:' })
  assert.deepEqual(await commands.dispatch('hello'), { handled: false })
  assert.deepEqual(await commands.dispatch('/missing'), {
    handled: true,
    output: 'unknown command: /missing',
  })
  assert.deepEqual(await commands.dispatch('/'), { handled: true, output: 'invalid command' })
})

test('commands: slash commands never create a model turn', async () => {
  const commands = new CommandRegistry()
  commands.register({ name: 'help', description: 'Show help', run: () => 'commands: /help' })

  let turns = 0
  const agent = {
    async run(prompt: string): Promise<string> {
      turns += 1
      return `answer:${prompt}`
    },
  }

  const help = await routeInput('/help', { commands, agent })
  assert.equal(help.kind, 'command')
  assert.equal(help.modelTurn, false)
  assert.equal(turns, 0)

  // 未知命令也不落到模型。
  const unknown = await routeInput('/nope', { commands, agent })
  assert.equal(unknown.modelTurn, false)
  assert.equal(turns, 0)

  const normal = await routeInput('please review this diff', { commands, agent })
  assert.equal(normal.kind, 'turn')
  assert.equal(normal.modelTurn, true)
  assert.equal(turns, 1)
  assert.equal(normal.output, 'answer:please review this diff')
})

test('commands: duplicate names are rejected', () => {
  const commands = new CommandRegistry()
  commands.register({ name: 'help', description: 'Help', run: () => 'ok' })
  assert.throws(
    () => commands.register({ name: 'help', description: 'Again', run: () => 'no' }),
    /already registered/,
  )
})
