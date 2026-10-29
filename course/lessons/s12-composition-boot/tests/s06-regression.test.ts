/**
 * s06 离线测试：prompt sections/variables/contexts/waterfall、工具顺序、
 * 以及 agent 的 system head 准入/替换。
 *
 * 不需要 API key。真实模型端到端在 live.test.ts。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Agent,
  createTextMessage,
  renderContextMessage,
  renderContexts,
  renderPrompt,
  Session,
  SystemPrompt,
  textOf,
  ToolRegistry,
} from '../src/index.ts'
import type { ChatRequest, Model, StreamChunk, ToolSchema } from '../src/index.ts'

const TOOLS: ToolSchema[] = [
  { name: 'b', description: 'b', parameters: { type: 'object', properties: {} } },
  { name: 'a', description: 'a', parameters: { type: 'object', properties: {} } },
  { name: 'c', description: 'c', parameters: { type: 'object', properties: {} } },
]

function toolSet(tools: ToolSchema[] = TOOLS) {
  return { schemas: () => tools }
}

test('prompt: sections sort by order then name, variables interpolate', async () => {
  const prompt = new SystemPrompt()
  prompt.section({ name: 'late', order: 100, text: 'late' })
  prompt.section({ name: 'early', order: -10, text: 'early {{name}}' })
  prompt.section({ name: 'same-b', order: 0, text: 'b' })
  prompt.section({ name: 'same-a', order: 0, text: 'a' })
  prompt.variable('name', 'world')

  const assembly = await prompt.assemble({
    modelSelection: { provider: 'deepseek', model: 'deepseek-flash' },
    toolSet: toolSet(),
  })
  assert.equal(renderPrompt(assembly), 'early world\n\na\n\nb\n\nlate')
  assert.equal(assembly.variables.provider, 'deepseek')
  assert.equal(assembly.variables.model, 'deepseek-flash')
})

test('prompt: complete section becomes the only prompt and multiple complete fails', async () => {
  const prompt = new SystemPrompt()
  prompt.section({ name: 'a', order: 0, text: 'a' })
  prompt.section({ name: 'complete', order: 10, text: 'only {{x}}', complete: true })
  prompt.variable('x', 'me')

  const assembly = await prompt.assemble({
    modelSelection: { provider: 'p', model: 'm' },
    toolSet: toolSet(),
  })
  assert.equal(renderPrompt(assembly), 'only me')

  prompt.section({ name: 'complete-2', order: 20, text: 'two', complete: true })
  await assert.rejects(
    async () => prompt.assemble({ modelSelection: { provider: 'p', model: 'm' }, toolSet: toolSet() }),
    /more than one complete/,
  )
})

test('prompt: unknown variable and interpolate:false', async () => {
  const prompt = new SystemPrompt()
  prompt.section({ name: 'a', order: 0, text: 'hello {{missing}}' })
  prompt.section({ name: 'literal', order: 1, text: 'keep {{this}}', interpolate: false })

  const assembly = await prompt.assemble({
    modelSelection: { provider: 'p', model: 'm' },
    toolSet: toolSet(),
  })
  assert.throws(() => renderPrompt(assembly), /unknown prompt variable "missing"/)

  const literal = new SystemPrompt()
  literal.section({ name: 'literal', order: 0, text: 'keep {{this}}', interpolate: false })
  const literalAssembly = await literal.assemble({
    modelSelection: { provider: 'p', model: 'm' },
    toolSet: toolSet(),
  })
  assert.equal(renderPrompt(literalAssembly), 'keep {{this}}')
})

test('prompt: contexts render into one user snapshot', async () => {
  const prompt = new SystemPrompt()
  prompt.variable('cwd', '/tmp/work')
  prompt.context({ name: 'workspace', order: 0, text: 'cwd={{cwd}}' })
  prompt.context({ name: 'empty', order: 1, text: '   ' })

  const assembly = await prompt.assemble({
    modelSelection: { provider: 'p', model: 'm' },
    toolSet: toolSet(),
  })
  assert.deepEqual(renderContexts(assembly), ['cwd=/tmp/work'])
  const message = renderContextMessage(assembly)
  assert.equal(message?.role, 'user')
  assert.equal(textOf(message!), 'cwd=/tmp/work')
})

test('prompt: toolOrder with rest and unknown tool validation', async () => {
  const prompt = new SystemPrompt({ toolOrder: ['c', '<unlisted-tools>'] })
  const assembly = await prompt.assemble({
    modelSelection: { provider: 'p', model: 'm' },
    toolSet: toolSet(),
  })
  assert.deepEqual(assembly.tools.map(tool => tool.name), ['c', 'b', 'a'])

  assert.throws(() => new SystemPrompt({ toolOrder: ['a'] }), /exactly one/)
  assert.throws(() => new SystemPrompt({ toolOrder: ['a', 'a', '<unlisted-tools>'] }), /duplicates/)

  const missing = new SystemPrompt({ toolOrder: ['nope', '<unlisted-tools>'] })
  await assert.rejects(
    async () => missing.assemble({ modelSelection: { provider: 'p', model: 'm' }, toolSet: toolSet() }),
    /unknown tool/,
  )
})

test('prompt: assemble waterfall can observe and replace the assembly', async () => {
  const prompt = new SystemPrompt()
  prompt.section({ name: 'base', order: 0, text: 'base' })
  const seen: string[] = []
  prompt.onAssemble(async (assembly, next) => {
    seen.push(assembly.sections.map(section => section.name).join(','))
    const downstream = await next()
    return {
      ...downstream,
      sections: [
        ...downstream.sections,
        { name: 'added', order: 99, text: 'added by middleware' },
      ],
    }
  })

  const assembly = await prompt.assemble({
    modelSelection: { provider: 'p', model: 'm' },
    toolSet: toolSet(),
  })
  assert.deepEqual(seen, ['base'])
  assert.equal(renderPrompt(assembly), 'base\n\nadded by middleware')
})

test('prompt: variable and section disposers remove contributions', async () => {
  const prompt = new SystemPrompt()
  const section = prompt.section({ name: 's', order: 0, text: 's {{v}}' })
  const variable = prompt.variable('v', '1')

  let assembly = await prompt.assemble({ modelSelection: { provider: 'p', model: 'm' }, toolSet: toolSet() })
  assert.equal(renderPrompt(assembly), 's 1')

  variable()
  section()
  assembly = await prompt.assemble({ modelSelection: { provider: 'p', model: 'm' }, toolSet: toolSet() })
  assert.equal(renderPrompt(assembly), '')
})

class CapturingModel implements Model {
  readonly provider = 'test'
  readonly model = 'capture'
  readonly requests: ChatRequest[] = []

  async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('agent: system head is admitted before the first user message', async () => {
  const prompt = new SystemPrompt()
  prompt.section({ name: 'persona', order: 0, text: 'You are {{who}}.' })
  prompt.variable('who', 'a calculator')
  prompt.context({ name: 'ctx', order: 0, text: 'context {{who}}' })

  const session = new Session('head')
  const model = new CapturingModel()
  await new Agent(session, model, new ToolRegistry(), { prompt }).run('hi')

  const first = model.requests[0]!
  assert.deepEqual(first.messages.map(message => message.role), ['system', 'user', 'user'])
  assert.equal(textOf(first.messages[0]!), 'You are a calculator.')
  assert.equal(textOf(first.messages[2]!), 'context a calculator')
  assert.deepEqual(
    session.events.slice(0, 4).map(event => event.type),
    ['turn/start', 'step/start', 'system/message', 'user/message'],
  )
  assert.equal(textOf(session.deriveMessages()[0]!), 'You are a calculator.')
})

test('agent: a changed prompt replaces the head without deleting the old event', async () => {
  const prompt = new SystemPrompt()
  const variable = prompt.variable('version', 'v1')
  prompt.section({ name: 'version', order: 0, text: 'prompt {{version}}' })

  const session = new Session('replace-head')
  const model = new CapturingModel()
  const agent = new Agent(session, model, new ToolRegistry(), { prompt })

  await agent.run('first')
  variable()
  prompt.variable('version', 'v2')
  await agent.run('second')

  assert.equal(textOf(model.requests[0]!.messages[0]!), 'prompt v1')
  assert.equal(textOf(model.requests[1]!.messages[0]!), 'prompt v2')
  const systemEvents = session.events.filter(event => event.type === 'system/message')
  assert.equal(systemEvents.length, 2)
  assert.equal(session.surfaceSeqs[0], systemEvents[1]!.seq)
  assert.equal(textOf(session.deriveMessages()[0]!), 'prompt v2')
  assert.equal(session.events.some(event => event.type === 'system/message' && event.seq === systemEvents[0]!.seq), true)
})

test('agent: an empty prompt reserves the head but derives no system message', async () => {
  const prompt = new SystemPrompt()
  const session = new Session('empty-prompt')
  const model = new CapturingModel()
  await new Agent(session, model, new ToolRegistry(), { prompt }).run('hi')

  const system = session.events.find(event => event.type === 'system/message')
  assert.notEqual(system, undefined)
  assert.equal(system?.type === 'system/message' ? system.data.message.content.length : -1, 0)
  assert.deepEqual(model.requests[0]!.messages.map(message => message.role), ['user'])
})
