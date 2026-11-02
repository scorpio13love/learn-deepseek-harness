/**
 * s16 离线测试：PTC runtime。
 *
 * 全部用本地脚本和本地工具，不访问网络、不需要 key。
 *
 * 运行：
 *   cd course/lessons-v3/s16-ptc
 *   node --test tests/s16.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createCalcTool,
  defineTool,
  PtcRuntime,
  ToolRegistry,
  toJsonValue,
} from '../src/index.ts'
import type { PtcToolDefinition } from '../src/index.ts'

function createRuntime(): PtcRuntime {
  const tools = new ToolRegistry()
  tools.register(createCalcTool())
  tools.register(defineTool<number>({
    name: 'add',
    description: 'Add two numbers.',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    run(args) {
      const { a, b } = args as { a: number; b: number }
      return a + b
    },
  }))
  tools.register(defineTool({
    name: 'sleep',
    description: 'Resolve after ms.',
    parameters: { type: 'object', properties: { ms: { type: 'number' } } },
    async run(args) {
      const { ms } = args as { ms: number }
      await new Promise(resolve => setTimeout(resolve, ms))
      return { slept: ms }
    },
  }))
  tools.register(defineTool({
    name: 'boom',
    description: 'Always throws.',
    parameters: { type: 'object', properties: {} },
    run() {
      throw new Error('kaput')
    },
  }))
  return new PtcRuntime({ tools, timeoutMs: 2_000 })
}

// ---------------------------------------------------------------------------
// 工具调用与异步
// ---------------------------------------------------------------------------

test('ptc: a program can await tools.<name>() and return a JSON value', async () => {
  const runtime = createRuntime()
  const result = await runtime.run(`
    const first = await tools.calc({ expression: '(12 + 30) * 2' })
    const second = await tools.add({ a: first, b: 1 })
    return { first, second }
  `)

  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { first: 84, second: 85 })
  assert.equal(result.calls.length, 2)
  assert.deepEqual(result.calls.map(call => call.tool), ['calc', 'add'])
  assert.equal(result.calls[0]?.ok, true)
  assert.deepEqual(result.calls[0]?.args, { expression: '(12 + 30) * 2' })
  assert.deepEqual(result.calls[0]?.value, 84)
  assert.equal(result.error, undefined)
})

test('ptc: async tools can run in parallel inside one program', async () => {
  const runtime = createRuntime()
  const started = performance.now()
  const result = await runtime.run(`
    const [a, b] = await Promise.all([
      tools.sleep({ ms: 30 }),
      tools.sleep({ ms: 30 }),
    ])
    return { a, b }
  `)
  const elapsed = performance.now() - started

  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { a: { slept: 30 }, b: { slept: 30 } })
  assert.equal(result.calls.length, 2)
  // 并行执行明显快于串行 60ms；给 CI 留足余量。
  assert.equal(elapsed < 110, true, `expected parallel execution, took ${elapsed}ms`)
})

test('ptc: console output is captured instead of printed', async () => {
  const runtime = createRuntime()
  const result = await runtime.run(`
    console.log('hello', { n: 1 })
    console.warn('careful')
    return 'done'
  `)

  assert.equal(result.ok, true)
  assert.deepEqual(result.logs, ['hello {"n":1}', 'careful'])
})

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

test('ptc: a throwing tool becomes a structured tool-error', async () => {
  const runtime = createRuntime()
  const result = await runtime.run('return await tools.boom({})')

  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'tool-error')
  assert.equal(result.error?.code, 'TOOL_ERROR')
  assert.equal(result.error?.tool, 'boom')
  assert.match(result.error?.message ?? '', /kaput/)
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0]?.ok, false)
})

test('ptc: program code can catch a tool error and recover', async () => {
  const runtime = createRuntime()
  const result = await runtime.run(`
    try {
      await tools.boom({})
      return 'unreachable'
    } catch (error) {
      return { name: error.name, code: error.code, message: error.message }
    }
  `)

  assert.equal(result.ok, true)
  assert.deepEqual(result.value, {
    name: 'PtcToolError',
    code: 'TOOL_ERROR',
    message: 'kaput',
  })
  // 即使程序恢复了，调用记录里仍然保留失败事实。
  assert.equal(result.calls[0]?.ok, false)
})

test('ptc: unknown tools fail with UNKNOWN_TOOL, not a JS TypeError', async () => {
  const runtime = createRuntime()
  const result = await runtime.run('return await tools.nope({})')

  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'tool-error')
  assert.equal(result.error?.code, 'UNKNOWN_TOOL')
  assert.equal(result.error?.tool, 'nope')
})

test('ptc: a syntax error is reported as invalid-program', async () => {
  const runtime = createRuntime()
  const result = await runtime.run('return (')

  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'invalid-program')
  assert.equal(result.calls.length, 0)
})

// ---------------------------------------------------------------------------
// 超时与取消
// ---------------------------------------------------------------------------

test('ptc: timeout stops the run and keeps the structured calls', async () => {
  const runtime = createRuntime()
  const result = await runtime.run(`
    await tools.calc({ expression: '1 + 1' })
    await tools.sleep({ ms: 500 })
    return 'too late'
  `, { timeoutMs: 20 })

  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'timeout')
  assert.equal(result.error?.code, 'TIMEOUT')
  assert.equal(result.durationMs < 500, true)
  // 已完成的那次 calc 仍保留在记录里。
  assert.equal(result.calls.length, 1)
  assert.deepEqual(result.calls[0]?.value, 2)
})

test('ptc: an external abort signal cancels the run', async () => {
  const runtime = createRuntime()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 15)
  const result = await runtime.run('await tools.sleep({ ms: 500 }); return 1', {
    signal: controller.signal,
  })

  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'abort')
  assert.match(result.error?.code ?? '', /ABORT/)
})

// ---------------------------------------------------------------------------
// scope 与序列化
// ---------------------------------------------------------------------------

test('ptc: a shared scope persists variables, the default scope is fresh', async () => {
  const runtime = createRuntime()
  const program = 'scope.count = (scope.count ?? 0) + 1; return scope.count'
  const scope = runtime.createScope()

  const first = await runtime.run(program, { scope })
  const second = await runtime.run(program, { scope })
  const fresh = await runtime.run(program)

  assert.deepEqual([first.value, second.value, fresh.value], [1, 2, 1])
})

test('ptc: tool results are serialized to JSON (Date, undefined, bigint)', async () => {
  const runtime = createRuntime()
  const tools = runtime.registry
  tools.register(defineTool({
    name: 'meta',
    description: 'Return values that are not plain JSON yet.',
    parameters: { type: 'object', properties: {} },
    run() {
      return {
        when: new Date('2020-01-02T03:04:05.000Z'),
        missing: undefined,
        big: 10n,
      }
    },
  }))

  const result = await runtime.run('return await tools.meta({})')

  assert.equal(result.ok, true)
  assert.deepEqual(result.value, {
    when: '2020-01-02T03:04:05.000Z',
    missing: null,
    big: '10n',
  })
})

test('ptc: a circular result fails with a serialization error', async () => {
  const runtime = createRuntime()
  const circular: Record<string, unknown> = {}
  circular.self = circular
  runtime.registry.register(defineTool({
    name: 'circular',
    description: 'Return a circular object.',
    parameters: { type: 'object', properties: {} },
    run() {
      return circular
    },
  }))

  const result = await runtime.run('return await tools.circular({})')

  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'serialization')
  assert.match(result.error?.message ?? '', /circular/)
  assert.throws(() => toJsonValue(circular), /circular/)
})

test('ptc: tool schemas stay model-visible', () => {
  const tools = new ToolRegistry()
  tools.register(createCalcTool())
  const schemas = tools.schemas()
  assert.equal(schemas[0]?.name, 'calc')
  assert.equal(schemas[0]?.parameters.type, 'object')
})

test('ptc: duplicate tool names are rejected', () => {
  const tools = new ToolRegistry()
  const tool: PtcToolDefinition = createCalcTool()
  tools.register(tool)
  assert.throws(() => tools.register(tool), /already registered/)
})
