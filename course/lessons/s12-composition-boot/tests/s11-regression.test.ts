/**
 * s11 离线测试：Context/Service/inject、effect 卸载、事件模式、scope。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context, Service } from '../src/index.ts'
import type { Disposer } from '../src/index.ts'

class Sessions extends Service {
  readonly log: string[] = []
  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }
}

class Tools extends Service {
  readonly names = ['calc']
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
}

test('context: provide/get resolves own and parent services', async () => {
  const root = new Context()
  await root.plugin(Sessions)
  const child = root.createScope('a')
  assert.equal(root.require<Sessions>('sessions'), child.require<Sessions>('sessions'))
  assert.equal(root.get('missing'), undefined)
  root.dispose()
  assert.equal(root.get('sessions'), undefined)
})

test('plugin: inject missing service fails and rolls back', async () => {
  const root = new Context()
  let ran = false
  const plugin = Object.assign((_ctx: Context) => { ran = true }, {
    inject: ['tools'],
  })
  await assert.rejects(async () => root.plugin(plugin), /requires service "tools"/)
  assert.equal(ran, false)
  root.dispose()
})

test('fiber: effects unwind in reverse order and remove listeners', async () => {
  const root = new Context()
  const order: string[] = []
  const plugin = async (ctx: Context) => {
    ctx.effect(() => {
      order.push('first')
      return () => order.push('first:down')
    })
    ctx.effect(() => {
      order.push('second')
      return () => order.push('second:down')
    })
    ctx.on('ping', () => order.push('ping'))
  }
  const fiber = await root.plugin(plugin)
  root.emit('ping')
  fiber.dispose()
  root.emit('ping')
  assert.deepEqual(order, ['first', 'second', 'ping', 'second:down', 'first:down'])
  root.dispose()
})

test('events: waterfall wraps, serial orders, bail stops', async () => {
  const root = new Context()
  root.on('wf', async (value, next) => `before(${await (next as () => Promise<string>)()})`)
  root.on('wf', async (value, next) => `inner(${String(await (next as () => Promise<string>)())})`)

  const wf = await root.waterfall('wf', ['v'], () => 'base')
  assert.equal(wf, 'before(inner(base))')

  const order: string[] = []
  root.on('serial', async () => { order.push('a'); return 'a' })
  root.on('serial', async () => { order.push('b'); return 'b' })
  assert.equal(await root.serial('serial'), 'b')
  assert.deepEqual(order, ['a', 'b'])

  let calls = 0
  root.on('bail', () => { calls += 1; return 'first' })
  root.on('bail', () => { calls += 1; return 'second' })
  assert.equal(root.bail('bail'), 'first')
  assert.equal(calls, 1)
  root.dispose()
})

test('scope: scoped listeners only receive matching scope', async () => {
  const root = new Context()
  const seen: string[] = []
  root.on('tool', name => seen.push(`global:${String(name)}`))
  const a = root.createScope('a')
  const b = root.createScope('b')
  a.on('tool', name => seen.push(`a:${String(name)}`), { scope: 'a' })
  b.on('tool', name => seen.push(`b:${String(name)}`), { scope: 'b' })

  root.emit('tool', 'root')
  a.emit('tool', 'one')
  b.emit('tool', 'two')
  assert.deepEqual(seen, ['global:root', 'global:one', 'a:one', 'global:two', 'b:two'])
  a.dispose()
  root.dispose()
})

test('scope: disposing a child removes its listeners and subtree', async () => {
  const root = new Context()
  const seen: string[] = []
  const child = root.createScope('child')
  child.on('x', () => seen.push('child'))
  root.emit('x')
  child.dispose()
  root.emit('x')
  assert.deepEqual(seen, ['child'])
  root.dispose()
})

test('plugin: class services register and can be found by sibling plugins', async () => {
  const root = new Context()
  await root.plugin(Sessions)
  await root.plugin(Tools)
  const loop = async (ctx: Context) => {
    ctx.require('sessions')
    ctx.require('tools')
  }
  ;(loop as typeof loop & { inject: string[] }).inject = ['sessions', 'tools']
  const fiber = await root.plugin(loop)
  assert.equal(root.get('sessions') instanceof Sessions, true)
  fiber.dispose()
  root.dispose()
})

test('disposer: effect can be removed independently', () => {
  const root = new Context()
  const order: string[] = []
  const dispose: Disposer = root.effect(() => () => order.push('down'))
  dispose()
  root.dispose()
  assert.deepEqual(order, ['down'])
})
