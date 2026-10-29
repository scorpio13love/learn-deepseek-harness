/**
 * s04 离线测试：schema 编译/校验、输出契约、条件、作用域、掩码、ToolSet。
 *
 * 不需要 API key。真实模型端到端在 live.test.ts；s03 的流式回归在 s03-regression.test.ts。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  defineTool,
  parametersToJsonSchema,
  textOf,
  ToolActivationError,
  ToolRegistry,
  validateParameters,
} from '../src/index.ts'
import type { ToolContext } from '../src/index.ts'

function ctx(scope?: string): ToolContext {
  return {
    signal: new AbortController().signal,
    callId: 'call-1',
    sessionId: 'session-1',
    ...scope === undefined ? {} : { scope },
  }
}

function call(name: string, args: unknown) {
  return { type: 'tool-call' as const, id: 'call-1', name, arguments: JSON.stringify(args) }
}

const ADD = defineTool({
  name: 'add',
  description: 'Add two numbers.',
  parameters: {
    a: { type: 'number', required: true, description: 'left' },
    b: { type: 'number', required: true, description: 'right' },
  },
  output: {
    schema: { type: 'number' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
    presentationMeta: (args, value) => ({ a: args.a, b: args.b, sum: value }),
  },
  execute: args => args.a + args.b,
})

test('schema: parameters compile to a closed object with required keys', () => {
  const schema = parametersToJsonSchema({
    expression: { type: 'string', required: true, minLength: 1 },
    mode: { type: 'string', enum: ['fast', 'slow'] },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    nested: {
      type: 'object',
      properties: { count: { type: 'integer', required: true } },
      additionalProperties: false,
    },
  })

  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      expression: { type: 'string', minLength: 1 },
      mode: { type: 'string', enum: ['fast', 'slow'] },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
      nested: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
        additionalProperties: false,
      },
    },
    required: ['expression'],
    additionalProperties: false,
  })
})

test('schema: validateParameters reports type, required, enum and extra keys', () => {
  const parameters = {
    expression: { type: 'string' as const, required: true as const, minLength: 1 },
    mode: { type: 'string' as const, enum: ['fast', 'slow'] as const },
    nested: {
      type: 'object' as const,
      properties: { count: { type: 'integer' as const, required: true as const } },
      additionalProperties: false,
    },
  }

  assert.deepEqual(validateParameters(parameters, {}), ['args.expression is required'])
  assert.deepEqual(validateParameters(parameters, { expression: 1 }), ['args.expression must be string, got number'])
  assert.deepEqual(validateParameters(parameters, { expression: 'x', mode: 'other' }), [
    'args.mode must be one of ["fast","slow"]',
  ])
  assert.deepEqual(validateParameters(parameters, { expression: 'x', extra: 1 }), ['args.extra is not allowed'])
  assert.deepEqual(validateParameters(parameters, { expression: 'x', nested: {} }), ['args.nested.count is required'])
})

test('schema: oneOf requires exactly one matching branch', () => {
  const parameters = {
    value: {
      oneOf: [
        { type: 'string' as const, minLength: 2 },
        { type: 'number' as const, minimum: 10 },
      ] as const,
      required: true as const,
    },
  }
  assert.deepEqual(validateParameters(parameters, { value: 'ab' }), [])
  assert.deepEqual(validateParameters(parameters, { value: 10 }), [])
  assert.equal(validateParameters(parameters, { value: 'a' }).length, 1)
})

test('defineTool: valid value renders content and presentation meta', async () => {
  const registry = new ToolRegistry()
  registry.register(ADD)

  const result = await registry.execute(call('add', { a: 2, b: 3 }), ctx())
  assert.equal(result.isError, false)
  assert.equal(textOf({ id: 'x', role: 'tool', content: result.content }), '5')
  assert.deepEqual(result.meta, { a: 2, b: 3, sum: 5 })
})

test('defineTool: invalid output and render failure become error results', async () => {
  const registry = new ToolRegistry()
  registry.register(defineTool({
    name: 'bad-output',
    description: 'Returns a string despite declaring a number.',
    parameters: {},
    output: { schema: { type: 'number' }, render: () => [{ type: 'text', text: 'x' }] },
    execute: () => 'oops' as never,
  }))
  registry.register(defineTool({
    name: 'bad-render',
    description: 'Render throws.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: () => { throw new Error('render exploded') },
    },
    execute: () => 'ok',
  }))

  const output = await registry.execute(call('bad-output', {}), ctx())
  assert.equal(output.isError, true)
  assert.match(textOf({ id: 'x', role: 'tool', content: output.content }), /invalid output/)

  const render = await registry.execute(call('bad-render', {}), ctx())
  assert.equal(render.isError, true)
  assert.match(textOf({ id: 'x', role: 'tool', content: render.content }), /render failed/)
})

test('tool: invalid args, unknown tool and thrown bodies are error results', async () => {
  const registry = new ToolRegistry()
  registry.register(ADD)
  registry.register(defineTool({
    name: 'boom',
    description: 'Throws.',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'x' }] },
    execute: () => { throw new Error('kaput') },
  }))

  const args = await registry.execute(call('add', { a: 1 }), ctx())
  assert.equal(args.isError, true)
  assert.match(textOf({ id: 'x', role: 'tool', content: args.content }), /args\.b is required/)

  const unknown = await registry.execute(call('missing', {}), ctx())
  assert.match(textOf({ id: 'x', role: 'tool', content: unknown.content }), /unknown tool/)

  const thrown = await registry.execute(call('boom', {}), ctx())
  assert.equal(textOf({ id: 'x', role: 'tool', content: thrown.content }), 'Error: kaput')
})

test('conditions: when sees the scope, filters tools, and fails loudly', async () => {
  const registry = new ToolRegistry()
  registry.register(ADD, { when: context => context.scope === 'admin' })
  registry.register(defineTool({
    name: 'broken-condition',
    description: 'Condition throws.',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'x' }] },
    execute: () => 'x',
  }), { scope: 'broken', when: () => { throw new Error('condition failed') } })

  const common = await registry.resolve({ signal: new AbortController().signal })
  assert.equal(common.get('add'), undefined)
  common.dispose()

  const admin = await registry.resolve({ signal: new AbortController().signal, scope: 'admin' })
  assert.equal(admin.get('add')?.name, 'add')
  admin.dispose()

  await assert.rejects(
    async () => registry.resolve({ signal: new AbortController().signal, scope: 'broken' }),
    (error: unknown) => error instanceof ToolActivationError && error.code === 'TOOL_ACTIVATION_FAILED',
  )
})

test('scopes: scoped tools shadow globals and stay isolated', async () => {
  const registry = new ToolRegistry()
  registry.register(defineTool({
    name: 'who',
    description: 'global',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
    execute: () => 'global',
  }))
  registry.register(defineTool({
    name: 'who',
    description: 'admin',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
    execute: () => 'admin',
  }), { scope: 'admin' })

  const global = await registry.resolve({ signal: new AbortController().signal })
  assert.equal(global.get('who')?.description, 'global')
  global.dispose()

  const admin = await registry.resolve({ signal: new AbortController().signal, scope: 'admin' })
  assert.equal(admin.get('who')?.description, 'admin')
  admin.dispose()
})

test('restrictions: allow/deny mask globals but not scoped tools', async () => {
  const registry = new ToolRegistry()
  for (const name of ['a', 'b']) {
    registry.register(defineTool({
      name,
      description: name,
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
      execute: () => name,
    }))
  }
  registry.register(defineTool({
    name: 'admin-only',
    description: 'admin',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
    execute: () => 'admin',
  }), { scope: 'admin' })

  const allow = registry.restrict({ allow: ['a'] })
  const allowed = await registry.resolve({ signal: new AbortController().signal, scope: 'admin' })
  assert.deepEqual([...allowed.names].sort(), ['a', 'admin-only'])
  allowed.dispose()
  allow()

  const deny = registry.restrict({ deny: ['a'] })
  const denied = await registry.resolve({ signal: new AbortController().signal })
  assert.deepEqual([...denied.names], ['b'])
  denied.dispose()
  deny()
})

test('tool set: dispose removes visibility and prevents unstarted execution', async () => {
  const registry = new ToolRegistry()
  registry.register(ADD)
  const set = await registry.resolve({ signal: new AbortController().signal })
  assert.equal(set.get('add')?.name, 'add')
  set.dispose()
  assert.equal(set.get('add'), undefined)
  assert.deepEqual(set.schemas(), [])

  const result = await registry.execute(call('add', { a: 1, b: 2 }), ctx(), set)
  assert.equal(result.isError, true)
  assert.match(textOf({ id: 'x', role: 'tool', content: result.content }), /unknown tool/)
})

test('metadata: isConcurrencySafe survives defineTool', () => {
  const tool = defineTool({
    name: 'safe',
    description: 'safe',
    parameters: { id: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
    execute: args => args.id,
    isConcurrencySafe: () => true,
  })
  assert.equal(tool.isConcurrencySafe?.({ id: 'x' }), true)
})
