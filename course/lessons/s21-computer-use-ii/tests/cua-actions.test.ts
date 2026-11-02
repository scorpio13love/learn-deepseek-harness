/**
 * s21 离线测试：动作、坐标校验、快照失效、窗口变化、授权撤销。
 *
 * 运行：node --test tests/*.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ApplicationAccess,
  createCuaTool,
  createMemoryStorage,
  CuaError,
  openMockDesktop,
  resizeMockWindow,
  runCua,
  toNativePoint,
} from '../src/index.ts'

const NOTES = 'notes'
const WINDOW = 1

test('registry: 单槽位、第二个注册失败、dispose 释放', async () => {
  const { registry, session, dispose } = await openMockDesktop()
  try {
    assert.equal(registry.providerName, 'mock')
    assert.throws(
      () => registry.register({ name: 'other', open: async () => session }),
      (error: unknown) => error instanceof CuaError && error.code === 'PROVIDER_ALREADY_REGISTERED',
    )
  } finally {
    await dispose()
  }
  assert.equal(session.closed, true)
  assert.equal(registry.providerName, undefined)
})

test('access: 持久授权跨会话，会话授权不跨会话，撤销分开生效', () => {
  // 没有 profile storage 时持久授权不可用。
  const memoryOnly = new ApplicationAccess()
  assert.equal(memoryOnly.persistentAvailable, false)
  assert.throws(
    () => memoryOnly.grant(NOTES, { scope: 'persistent' }),
    (error: unknown) => error instanceof CuaError && error.code === 'PERSISTENCE_UNAVAILABLE',
  )
  assert.throws(
    () => memoryOnly.grant(NOTES, { scope: 'session' }),
    (error: unknown) => error instanceof CuaError && error.code === 'INVALID_ARGUMENT',
  )

  const storage = createMemoryStorage()
  const access = new ApplicationAccess({ storage })
  assert.equal(access.persistentAvailable, true)

  access.grant(NOTES, { scope: 'session', sessionId: 'session-a' })
  access.grant('finder', { scope: 'persistent' })

  // 会话授权只属于 session-a；持久授权对任何会话有效。
  assert.equal(access.isAllowed(NOTES, 'session-a'), true)
  assert.equal(access.isAllowed(NOTES, 'session-b'), false)
  assert.equal(access.isAllowed('finder', 'session-b'), true)

  // 模拟重启：同一份存储上新建授权表，持久授权仍在。
  const restarted = new ApplicationAccess({ storage })
  assert.deepEqual(restarted.persistentGrants, ['finder'])
  assert.equal(restarted.isAllowed(NOTES, 'session-a'), false)

  // 撤销会话授权不影响持久授权；撤销全部会同时清掉两级。
  assert.equal(access.revoke(NOTES, { sessionId: 'session-a' }), true)
  assert.equal(access.isAllowed(NOTES, 'session-a'), false)
  assert.equal(access.revoke(NOTES, { sessionId: 'session-a' }), false)
  assert.equal(access.revoke('finder'), true)
  assert.equal(access.isAllowed('finder', 'session-b'), false)

  assert.deepEqual(access.snapshot(), { persistent: [], sessions: {} })
})

test('authorization: 未授权时动作被拒绝；撤销后立即再次拒绝', async () => {
  const { session, access, dispose } = await openMockDesktop({ sessionId: 's21-auth' })
  try {
    let denied: unknown
    try {
      await session.getState(NOTES)
    } catch (error) {
      denied = error
    }
    assert.ok(denied instanceof CuaError)
    assert.equal(denied.code, 'APP_ACCESS_REQUIRED')

    access.grant(NOTES, { scope: 'session', sessionId: 's21-auth' })
    const fresh = await session.getState(NOTES)
    const receipt = await session.click({
      appId: NOTES,
      windowId: WINDOW,
      target: { kind: 'element', snapshotId: fresh.snapshotId, elementIndex: 2 },
    })
    assert.equal(receipt.status, 'dispatched')

    assert.equal(access.revoke(NOTES), true)
    await assert.rejects(
      session.click({
        appId: NOTES,
        windowId: WINDOW,
        target: { kind: 'element', snapshotId: fresh.snapshotId, elementIndex: 2 },
      }),
      (error: unknown) => error instanceof CuaError && error.code === 'APP_ACCESS_REQUIRED',
    )
  } finally {
    await dispose()
  }
})

test('actions: click 记录 dispatched、verified=false、不可撤销', async () => {
  const { session, access, dispose } = await openMockDesktop({ sessionId: 's21-click' })
  try {
    access.grant(NOTES, { scope: 'session', sessionId: 's21-click' })
    const state = await session.getState(NOTES)
    assert.equal(state.snapshotId, 'snap-1')

    const receipt = await session.click({
      appId: NOTES,
      windowId: WINDOW,
      target: { kind: 'element', snapshotId: state.snapshotId, elementIndex: 2 },
    })
    assert.equal(receipt.status, 'dispatched')
    assert.equal(receipt.verified, false)
    assert.equal(receipt.irreversible, true)
    assert.equal(receipt.elementIndex, 2)
    assert.match(receipt.note, /cannot be undone/)

    assert.equal(session.dispatched.length, 1)
    assert.equal(session.dispatched[0]?.method, 'click')
    assert.equal(session.dispatched[0]?.verified, false)

    const cancelled = await session.cancel()
    assert.deepEqual(cancelled, {
      cancelled: true,
      undone: false,
      dispatchCount: 1,
      note: 'Dispatched desktop input cannot be undone; observe fresh state before deciding what to do next.',
    })
    // 取消之后，已派发的输入仍在记录里 —— 它不可撤销。
    assert.equal(session.dispatched.length, 1)
  } finally {
    await dispose()
  }
})

test('stale: 旧 snapshotId 报 STALE_SNAPSHOT，最新快照可用', async () => {
  const { session, access, dispose } = await openMockDesktop({ sessionId: 's21-stale' })
  try {
    access.grant(NOTES, { scope: 'session', sessionId: 's21-stale' })
    const first = await session.getState(NOTES)
    const second = await session.getState(NOTES)

    await assert.rejects(
      session.click({
        appId: NOTES,
        windowId: WINDOW,
        target: { kind: 'element', snapshotId: first.snapshotId, elementIndex: 2 },
      }),
      (error: unknown) => error instanceof CuaError && error.code === 'STALE_SNAPSHOT',
    )

    const ok = await session.click({
      appId: NOTES,
      windowId: WINDOW,
      target: { kind: 'element', snapshotId: second.snapshotId, elementIndex: 2 },
    })
    assert.equal(ok.status, 'dispatched')

    await assert.rejects(
      session.click({
        appId: NOTES,
        windowId: WINDOW,
        target: { kind: 'element', snapshotId: second.snapshotId, elementIndex: 99 },
      }),
      (error: unknown) => error instanceof CuaError && error.code === 'INVALID_ARGUMENT',
    )
  } finally {
    await dispose()
  }
})

test('coordinates: 相对 0-999 与绝对截图像素换算', async () => {
  const frame = { width: 900, height: 640, scale: 2 }
  const shot = { pixelWidth: 1800, pixelHeight: 1280 }

  assert.deepEqual(toNativePoint({ kind: 'point', x: 500, y: 500, relative: true }, frame, undefined), {
    x: 450,
    y: 320,
  })
  assert.deepEqual(toNativePoint({ kind: 'point', x: 999, y: 999, relative: true }, frame, undefined), {
    x: 899,
    y: 639,
  })
  assert.deepEqual(toNativePoint({ kind: 'point', x: 900, y: 640 }, frame, shot), { x: 450, y: 320 })

  for (const bad of [
    { kind: 'point' as const, x: -1, y: 0, relative: true },
    { kind: 'point' as const, x: 1000, y: 0, relative: true },
    { kind: 'point' as const, x: 1.5, y: 0, relative: true },
  ]) {
    assert.throws(
      () => toNativePoint(bad, frame, undefined),
      (error: unknown) => error instanceof CuaError && error.code === 'INVALID_ARGUMENT',
    )
  }

  assert.throws(
    () => toNativePoint({ kind: 'point', x: 10, y: 10 }, frame, undefined),
    (error: unknown) => error instanceof CuaError && error.code === 'SCREENSHOT_REQUIRED',
  )
  assert.throws(
    () => toNativePoint({ kind: 'point', x: 1800, y: 10 }, frame, shot),
    (error: unknown) => error instanceof CuaError && error.code === 'INVALID_ARGUMENT',
  )
})

test('coordinates: 会话里绝对坐标需要先截图，相对坐标需要先观测', async () => {
  const { session, access, dispose } = await openMockDesktop({ sessionId: 's21-coords' })
  try {
    access.grant(NOTES, { scope: 'session', sessionId: 's21-coords' })

    // 没有任何观测：相对坐标也不知道窗口几何。
    await assert.rejects(
      session.click({ appId: NOTES, windowId: WINDOW, target: { kind: 'point', x: 500, y: 500, relative: true } }),
      (error: unknown) => error instanceof CuaError && error.code === 'STALE_SNAPSHOT',
    )

    await session.getState(NOTES)
    const relative = await session.click({
      appId: NOTES,
      windowId: WINDOW,
      target: { kind: 'point', x: 500, y: 500, relative: true },
    })
    assert.deepEqual(relative.nativePoint, { x: 450, y: 320 })

    // 只有 AX 观测、没有截图：绝对坐标被拒绝。
    await assert.rejects(
      session.click({ appId: NOTES, windowId: WINDOW, target: { kind: 'point', x: 900, y: 640 } }),
      (error: unknown) => error instanceof CuaError && error.code === 'SCREENSHOT_REQUIRED',
    )

    const shot = await session.screenshot(NOTES, WINDOW)
    assert.equal(shot.pixelWidth, 1800)
    assert.equal(shot.pixelHeight, 1280)
    assert.equal(shot.scale, 2)

    const absolute = await session.click({
      appId: NOTES,
      windowId: WINDOW,
      target: { kind: 'point', x: 900, y: 640 },
    })
    assert.deepEqual(absolute.nativePoint, { x: 450, y: 320 })

    await assert.rejects(
      session.click({ appId: NOTES, windowId: WINDOW, target: { kind: 'point', x: 1800, y: 640 } }),
      (error: unknown) => error instanceof CuaError && error.code === 'INVALID_ARGUMENT',
    )
  } finally {
    await dispose()
  }
})

test('window changed: 尺寸变化让旧快照/旧截图/相对坐标全部失效，重新观测后恢复', async () => {
  const { session, access, dispose } = await openMockDesktop({ sessionId: 's21-window' })
  try {
    access.grant(NOTES, { scope: 'session', sessionId: 's21-window' })
    const state = await session.getState(NOTES)
    await session.screenshot(NOTES, WINDOW)

    resizeMockWindow(session, NOTES, WINDOW, { width: 800, height: 600 })

    await assert.rejects(
      session.click({
        appId: NOTES,
        windowId: WINDOW,
        target: { kind: 'element', snapshotId: state.snapshotId, elementIndex: 2 },
      }),
      (error: unknown) => error instanceof CuaError && error.code === 'WINDOW_CHANGED',
    )
    await assert.rejects(
      session.click({ appId: NOTES, windowId: WINDOW, target: { kind: 'point', x: 500, y: 500, relative: true } }),
      (error: unknown) => error instanceof CuaError && error.code === 'WINDOW_CHANGED',
    )
    await assert.rejects(
      session.click({ appId: NOTES, windowId: WINDOW, target: { kind: 'point', x: 100, y: 100 } }),
      (error: unknown) => error instanceof CuaError && error.code === 'WINDOW_CHANGED',
    )

    // 重新观测：元素动作与相对坐标恢复；绝对坐标仍需要新截图。
    const fresh = await session.getState(NOTES)
    assert.equal(fresh.window.bounds.width, 800)
    const element = await session.click({
      appId: NOTES,
      windowId: WINDOW,
      target: { kind: 'element', snapshotId: fresh.snapshotId, elementIndex: 2 },
    })
    assert.equal(element.status, 'dispatched')

    const relative = await session.click({
      appId: NOTES,
      windowId: WINDOW,
      target: { kind: 'point', x: 500, y: 500, relative: true },
    })
    assert.deepEqual(relative.nativePoint, { x: 400, y: 300 })

    await assert.rejects(
      session.click({ appId: NOTES, windowId: WINDOW, target: { kind: 'point', x: 100, y: 100 } }),
      (error: unknown) => error instanceof CuaError && error.code === 'SCREENSHOT_REQUIRED',
    )

    const shot = await session.screenshot(NOTES, WINDOW)
    assert.equal(shot.pixelWidth, 1600)
    assert.equal(shot.pixelHeight, 1200)
    const absolute = await session.click({
      appId: NOTES,
      windowId: WINDOW,
      target: { kind: 'point', x: 800, y: 600 },
    })
    assert.deepEqual(absolute.nativePoint, { x: 400, y: 300 })
  } finally {
    await dispose()
  }
})

test('type: 派发后 verified=false，重新观测能看到 mock 的可见效果', async () => {
  const { session, access, dispose } = await openMockDesktop({ sessionId: 's21-type' })
  try {
    access.grant(NOTES, { scope: 'session', sessionId: 's21-type' })
    const before = await session.getState(NOTES)
    assert.ok(before.elements.some(node => node.value === 'Shopping list'))

    const receipt = await session.type({ appId: NOTES, windowId: WINDOW, text: ' — milk' })
    assert.equal(receipt.method, 'type')
    assert.equal(receipt.verified, false)
    assert.equal(session.dispatched[0]?.text, ' — milk')

    const after = await session.getState(NOTES)
    assert.ok(after.elements.some(node => node.value === 'Shopping list — milk'))
    assert.notEqual(after.snapshotId, before.snapshotId)
  } finally {
    await dispose()
  }
})

test('press / scroll: 参数与派发记录', async () => {
  const { session, access, dispose } = await openMockDesktop({ sessionId: 's21-input' })
  try {
    access.grant(NOTES, { scope: 'session', sessionId: 's21-input' })
    await session.getState(NOTES)
    await session.screenshot(NOTES, WINDOW)

    const press = await session.press({ appId: NOTES, windowId: WINDOW, key: 's', modifiers: ['command'] })
    assert.equal(press.method, 'press')
    assert.deepEqual(session.dispatched[0]?.modifiers, ['command'])
    assert.equal(session.dispatched[0]?.key, 's')

    const scroll = await session.scroll({
      appId: NOTES,
      windowId: WINDOW,
      target: { kind: 'point', x: 450, y: 320 },
      deltaLinesX: 0,
      deltaLinesY: -3,
    })
    assert.deepEqual(scroll.nativePoint, { x: 225, y: 160 })
    assert.equal(session.dispatched[1]?.deltaLinesY, -3)

    await assert.rejects(
      session.scroll({
        appId: NOTES,
        windowId: WINDOW,
        target: { kind: 'point', x: 10, y: 10 },
        deltaLinesX: 0,
        deltaLinesY: -11,
      }),
      (error: unknown) => error instanceof CuaError && error.code === 'INVALID_ARGUMENT',
    )
    await assert.rejects(
      session.press({ appId: NOTES, windowId: WINDOW, key: '' }),
      (error: unknown) => error instanceof CuaError && error.code === 'INVALID_ARGUMENT',
    )

    const cancelled = await session.cancel()
    assert.equal(cancelled.dispatchCount, 2)
    assert.equal(cancelled.undone, false)
  } finally {
    await dispose()
  }
})

test('tool: cua 动作分发、错误收敛、截图元数据', async () => {
  const { session, access, dispose } = await openMockDesktop({ sessionId: 's21-tool' })
  const tool = createCuaTool(session)
  try {
    const denied = await runCua(tool, { method: 'click', params: { appId: NOTES, windowId: WINDOW, x: 1, y: 1 } })
    assert.equal(denied.isError, true)
    assert.match(denied.content[0]?.text ?? '', /APP_ACCESS_REQUIRED/)

    access.grant(NOTES, { scope: 'session', sessionId: 's21-tool' })

    const state = await runCua(tool, { method: 'getState', params: { appId: NOTES } })
    assert.equal(state.isError, false)
    const observed = JSON.parse(state.content[0]?.text ?? '{}') as { snapshotId: string; elements: unknown[] }
    assert.ok(observed.snapshotId.startsWith('snap-'))
    assert.ok(observed.elements.length > 0)

    const clicked = await runCua(tool, {
      method: 'click',
      params: { appId: NOTES, windowId: WINDOW, snapshotId: observed.snapshotId, elementIndex: 2 },
    })
    assert.equal(clicked.isError, false)
    const receipt = JSON.parse(clicked.content[0]?.text ?? '{}') as { status: string; verified: boolean }
    assert.equal(receipt.status, 'dispatched')
    assert.equal(receipt.verified, false)

    const relative = await runCua(tool, {
      method: 'click',
      params: { appId: NOTES, windowId: WINDOW, x: 500, y: 500, relative: true },
    })
    assert.equal(relative.isError, false)

    const noTarget = await runCua(tool, { method: 'click', params: { appId: NOTES, windowId: WINDOW } })
    assert.equal(noTarget.isError, true)
    assert.match(noTarget.content[0]?.text ?? '', /INVALID_ARGUMENT/)

    const stale = await runCua(tool, {
      method: 'click',
      params: { appId: NOTES, windowId: WINDOW, snapshotId: 'snap-0', elementIndex: 2 },
    })
    assert.equal(stale.isError, true)
    assert.match(stale.content[0]?.text ?? '', /STALE_SNAPSHOT/)

    const shot = await runCua(tool, { method: 'screenshot', params: { appId: NOTES, windowId: WINDOW } })
    const meta = JSON.parse(shot.content[0]?.text ?? '{}') as Record<string, unknown>
    assert.equal(meta.pixelWidth, 1800)
    assert.equal(meta.scale, 2)
    assert.equal(meta.placeholder, true)

    const unknown = await runCua(tool, { method: 'drag', params: { appId: NOTES } })
    assert.equal(unknown.isError, true)
    assert.match(unknown.content[0]?.text ?? '', /INVALID_ARGUMENT/)
  } finally {
    await dispose()
  }
})

test('session: 关闭后动作报 SESSION_CLOSED', async () => {
  const { session, access, dispose } = await openMockDesktop({ sessionId: 's21-close' })
  access.grant(NOTES, { scope: 'session', sessionId: 's21-close' })
  const state = await session.getState(NOTES)
  await session.close()

  for (const call of [
    () => session.getState(NOTES),
    () => session.click({
      appId: NOTES,
      windowId: WINDOW,
      target: { kind: 'element', snapshotId: state.snapshotId, elementIndex: 2 },
    }),
    () => session.cancel(),
  ]) {
    await assert.rejects(call, (error: unknown) => error instanceof CuaError && error.code === 'SESSION_CLOSED')
  }
  await dispose()
})
