/**
 * s05 离线测试：pre/guard/approval/execute/post/result、并发批次、超时与恢复。
 *
 * 不需要 API key。真实模型端到端在 live.test.ts。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createTextMessage,
  defineTool,
  recoverMissingToolResults,
  Session,
  textOf,
  ToolRegistry,
} from '../src/index.ts'
import type { ApprovalService, ToolContext, ToolDefinition } from '../src/index.ts'

function ctx(signal = new AbortController().signal, scope?: string): ToolContext {
  return {
    signal,
    callId: 'call-1',
    sessionId: 'session-1',
    ...scope === undefined ? {} : { scope },
  }
}

function call(name: string, args: unknown = {}, id = `call-${name}`) {
  return { type: 'tool-call' as const, id, name, arguments: JSON.stringify(args) }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) { reject(signal.reason); return }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function stringTool(
  name: string,
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string,
  extra: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    ...defineTool({
      name,
      description: name,
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: (args, context) => execute(args as Record<string, unknown>, context),
    }),
    ...extra,
  }
}

test('pipeline: deny in pre-execute skips guards and the body', async () => {
  const registry = new ToolRegistry()
  let executed = false
  let guarded = false
  registry.register(stringTool('danger', () => { executed = true; return 'ran' }))
  registry.pipeline.usePre(async () => ({ kind: 'deny', reason: 'not allowed' }))
  registry.pipeline.guard(() => { guarded = true; return undefined })

  const result = await registry.execute(call('danger'), ctx())
  assert.equal(result.isError, true)
  assert.match(textOf({ id: 'x', role: 'tool', content: result.content }), /not allowed/)
  assert.equal(executed, false)
  assert.equal(guarded, false)
})

test('pipeline: guards are monotonic and run after pre-execute', async () => {
  const registry = new ToolRegistry()
  let executed = false
  registry.register(stringTool('tool', () => { executed = true; return 'ran' }))
  registry.pipeline.guard(() => 'blocked by guard')

  const result = await registry.execute(call('tool'), ctx())
  assert.equal(result.isError, true)
  assert.match(textOf({ id: 'x', role: 'tool', content: result.content }), /blocked by guard/)
  assert.equal(executed, false)
})

test('approval: ask requires allowed-once; absent/denied fails closed', async () => {
  let executed = 0
  const make = (approval?: ApprovalService): ToolRegistry => {
    const registry = new ToolRegistry(approval === undefined ? {} : { approval })
    registry.register(stringTool('deploy', () => { executed += 1; return 'deployed' }))
    registry.pipeline.usePre(async (_exec, next) => {
      const decision = await next()
      return decision.kind === 'allow' ? { kind: 'ask', reason: 'deploy?' } : decision
    })
    return registry
  }

  const absent = await make().execute(call('deploy'), ctx())
  assert.equal(absent.isError, true)
  assert.match(textOf({ id: 'x', role: 'tool', content: absent.content }), /approval unavailable/)
  assert.equal(executed, 0)

  const denied = await make({ request: async () => 'denied' }).execute(call('deploy'), ctx())
  assert.equal(denied.isError, true)
  assert.equal(executed, 0)

  const allowed = await make({ request: async () => 'allowed-once' }).execute(call('deploy'), ctx())
  assert.equal(allowed.isError, false)
  assert.equal(executed, 1)
})

test('pipeline: post-execute can replace content or block the result', async () => {
  const registry = new ToolRegistry()
  registry.register(stringTool('tool', () => 'original'))
  registry.pipeline.usePost(async (_exec, _result, next) => {
    await next()
    return { kind: 'accept', content: [{ type: 'text', text: 'rewritten' }] }
  })

  const replaced = await registry.execute(call('tool'), ctx())
  assert.equal(replaced.isError, false)
  assert.equal(textOf({ id: 'x', role: 'tool', content: replaced.content }), 'rewritten')

  const blocking = new ToolRegistry()
  blocking.register(stringTool('tool', () => 'original'))
  blocking.pipeline.usePost(async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'policy says no' }] }))
  const blocked = await blocking.execute(call('tool'), ctx())
  assert.equal(blocked.isError, true)
  assert.equal(textOf({ id: 'x', role: 'tool', content: blocked.content }), 'policy says no')
})

test('pipeline: result observers see the final result and cannot break it', async () => {
  const registry = new ToolRegistry()
  registry.register(stringTool('tool', () => 'value'))
  const seen: string[] = []
  registry.pipeline.onResult((exec, result) => {
    seen.push(`${exec.name}:${result.isError ? 'error' : textOf({ id: 'x', role: 'tool', content: result.content })}`)
    throw new Error('observer failed')
  })

  const result = await registry.execute(call('tool'), ctx())
  assert.equal(result.isError, false)
  assert.deepEqual(seen, ['tool:value'])
})

test('pipeline: timeout aborts a cooperative tool and returns TIMEOUT', async () => {
  const registry = new ToolRegistry()
  registry.register({
    ...stringTool('slow', async (_args, context) => {
      await sleep(100, context.signal)
      return 'late'
    }),
    timeoutMs: 10,
  })

  const result = await registry.execute(call('slow'), ctx())
  assert.equal(result.isError, true)
  assert.match(textOf({ id: 'x', role: 'tool', content: result.content }), /timed out/)
})

test('pipeline: deferred context and concludeTurn reach the ToolResult', async () => {
  const registry = new ToolRegistry()
  registry.register(defineTool({
    name: 'finish',
    description: 'finish',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
    execute: (_args, context) => {
      context.deferContext?.(createTextMessage('user', 'follow-up context'))
      context.concludeTurn?.()
      return 'done'
    },
  }))

  const result = await registry.execute(call('finish'), ctx())
  assert.equal(result.additionalContexts?.[0]?.content[0]?.type, 'text')
  assert.equal(textOf(result.additionalContexts![0]!), 'follow-up context')
  assert.equal(result.concludesTurn, true)
})

test('batch: parallel-safe calls overlap and results stay in model order', async () => {
  const registry = new ToolRegistry()
  const events: string[] = []
  for (const name of ['a', 'b', 'c']) {
    registry.register({
      ...stringTool(name, async () => {
        events.push(`start:${name}`)
        await sleep(20)
        events.push(`end:${name}`)
        return name
      }),
      isConcurrencySafe: () => true,
    })
  }
  const set = await registry.resolve({ signal: new AbortController().signal })
  const batch = await registry.executeBatch(
    [call('a'), call('b'), call('c')],
    ctx(),
    set,
    2,
  )

  assert.deepEqual(
    batch.results.map(result => textOf({ id: 'x', role: 'tool', content: result.content })),
    ['a', 'b', 'c'],
  )
  assert.equal(events.indexOf('start:a') < events.indexOf('end:a'), true)
  assert.equal(events.indexOf('start:b') < events.indexOf('end:a'), true)
  assert.equal(batch.aborted, false)
  set.dispose()
})

test('batch: exclusive tools form barriers', async () => {
  const registry = new ToolRegistry()
  const events: string[] = []
  const make = (name: string, safe: boolean): ToolDefinition => ({
    ...stringTool(name, async () => {
      events.push(`start:${name}`)
      await sleep(5)
      events.push(`end:${name}`)
      return name
    }),
    isConcurrencySafe: () => safe,
  })
  registry.register(make('a', true))
  registry.register(make('lock', false))
  registry.register(make('b', true))

  const set = await registry.resolve({ signal: new AbortController().signal })
  const batch = await registry.executeBatch([call('a'), call('lock'), call('b')], ctx(), set, 4)
  assert.deepEqual(batch.results.map(result => textOf({ id: 'x', role: 'tool', content: result.content })), ['a', 'lock', 'b'])
  assert.deepEqual(events, ['start:a', 'end:a', 'start:lock', 'end:lock', 'start:b', 'end:b'])
  set.dispose()
})

test('batch: abort produces aligned synthetic results for skipped calls', async () => {
  const registry = new ToolRegistry()
  const controller = new AbortController()
  registry.register({
    ...stringTool('slow', async (_args, context) => {
      await sleep(100, context.signal)
      return 'late'
    }),
    isConcurrencySafe: () => true,
  })
  registry.register({ ...stringTool('next', () => 'next'), isConcurrencySafe: () => true })

  const set = await registry.resolve({ signal: controller.signal })
  const pending = registry.executeBatch([call('slow'), call('next')], ctx(controller.signal), set, 1)
  setTimeout(() => controller.abort(), 10)
  const batch = await pending

  assert.equal(batch.aborted, true)
  assert.equal(batch.results.length, 2)
  assert.equal(batch.results.every(result => result.isError), true)
  assert.match(textOf({ id: 'x', role: 'tool', content: batch.results[1]!.content }), /aborted before dispatch/)
  set.dispose()
})

test('recovery: missing tool results are filled once and keep call ordering', () => {
  const session = new Session('recovery')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'a', arguments: '{}' })
  session.append('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'b', arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: 'm1',
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    },
  }, { surfaceOp: 'append' })

  assert.equal(recoverMissingToolResults(session, 1, 1), 1)
  const results = session.events.filter(event => event.type === 'tool/result')
  assert.equal(results.length, 2)
  assert.deepEqual(
    results.map(event => event.type === 'tool/result' ? event.data.message.toolCallId : undefined),
    ['c1', 'c2'],
  )
  assert.equal(recoverMissingToolResults(session, 1, 1), 0)
})
