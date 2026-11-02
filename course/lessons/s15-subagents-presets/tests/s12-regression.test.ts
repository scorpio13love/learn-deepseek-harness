/**
 * s12 离线测试：patch 叠加、boot 启动/回滚、required、config 传递。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyPatch, Boot, composeProfile } from '../src/index.ts'
import type { ConfigEntry } from '../src/index.ts'

const base: ConfigEntry[] = [
  { id: 'a', name: 'a', config: { value: 1 } },
  { id: 'b', name: 'b' },
]

test('patch: insert/replace/disable/remove are layered', () => {
  const patched = applyPatch(base, {
    insert: [{ id: 'c', name: 'c' }],
    replace: [{ id: 'a', config: { value: 2 } }],
    disable: ['b'],
  })
  assert.deepEqual(patched, [
    { id: 'a', name: 'a', config: { value: 2 } },
    { id: 'b', name: 'b', disabled: true },
    { id: 'c', name: 'c' },
  ])

  const removed = applyPatch(patched, { remove: ['b'] })
  assert.deepEqual(removed.map(entry => entry.id), ['a', 'c'])
})

test('patch: unknown ids fail loud and insert duplicates are rejected', () => {
  assert.throws(() => applyPatch(base, { replace: [{ id: 'nope', config: {} }] }), /does not exist/)
  assert.throws(() => applyPatch(base, { disable: ['nope'] }), /does not exist/)
  assert.throws(() => applyPatch(base, { remove: ['nope'] }), /does not exist/)
  assert.throws(() => applyPatch(base, { insert: [{ id: 'a', name: 'a' }] }), /already exists/)
})

test('profile: bundle order then profile patch', () => {
  const entries = composeProfile({
    name: 'p',
    bundles: [
      { name: 'one', patches: [{ insert: [{ id: 'a', name: 'a', config: { v: 1 } }] }] },
      { name: 'two', patches: [{ replace: [{ id: 'a', config: { v: 2 } }] }] },
    ],
    patch: { insert: [{ id: 'b', name: 'b' }] },
  })
  assert.deepEqual(entries, [
    { id: 'a', name: 'a', config: { v: 2 } },
    { id: 'b', name: 'b' },
  ])
})

test('boot: mounts plugins, passes config, disposes', async () => {
  const seen: unknown[] = []
  const boot = new Boot().register('x', (ctx) => {
    seen.push(ctx.config)
    ctx.on('ping', () => seen.push('ping'))
  })
  const ctx = await boot.start([{ id: 'x', name: 'x', config: { n: 1 } }], { required: ['x'] })
  ctx.emit('ping')
  assert.deepEqual(seen, [{ n: 1 }, 'ping'])
  boot.dispose()
  assert.equal(ctx.get('missing'), undefined)
})

test('boot: required missing or disabled fails and rolls back', async () => {
  const boot = new Boot().register('x', () => {})
  await assert.rejects(
    async () => boot.start([{ id: 'x', name: 'x', disabled: true }], { required: ['x'] }),
    /required entry "x"/,
  )
  await assert.rejects(
    async () => boot.start([{ id: 'x', name: 'x' }], { required: ['missing'] }),
    /required entry "missing"/,
  )
})

test('boot: unregistered plugin and plugin failure roll back', async () => {
  const boot = new Boot()
  await assert.rejects(
    async () => boot.start([{ id: 'x', name: 'nope' }]),
    /unregistered plugin "nope"/,
  )

  const failing = new Boot().register('bad', () => { throw new Error('apply failed') })
  await assert.rejects(
    async () => failing.start([{ id: 'bad', name: 'bad' }]),
    /apply failed/,
  )
})

test('boot: disabled entries are skipped', async () => {
  let mounted = false
  const boot = new Boot().register('x', () => { mounted = true })
  await boot.start([{ id: 'x', name: 'x', disabled: true }])
  assert.equal(mounted, false)
  boot.dispose()
})

test('dumpConfig returns deep clones', () => {
  const boot = new Boot()
  const source: ConfigEntry[] = [{ id: 'x', name: 'x', config: { a: { b: 1 } } }]
  const dumped = boot.dumpConfig(source)
  ;(dumped[0]!.config as { a: { b: number } }).a.b = 2
  assert.deepEqual(source[0]!.config, { a: { b: 1 } })
})
