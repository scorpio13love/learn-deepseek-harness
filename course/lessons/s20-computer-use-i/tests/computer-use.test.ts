/**
 * s20 离线测试：注册、授权、窗口快照、AX 读取、截图结果。
 *
 * 运行：node --test tests/*.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ApplicationAccess,
  ComputerUseProviderRegistry,
  createCuaTool,
  createMockDesktopProvider,
  CuaError,
  flattenAx,
  openMockDesktop,
  runCua,
} from '../src/index.ts'

test('registry: 单槽位，第二次注册（含同名）失败', async () => {
  const registry = new ComputerUseProviderRegistry()
  const access = new ApplicationAccess()
  const registration = registry.register(createMockDesktopProvider({ access }))

  assert.equal(registry.providerName, 'mock')
  assert.throws(
    () => registry.register(createMockDesktopProvider({ access })),
    (error: unknown) =>
      error instanceof CuaError &&
      error.code === 'PROVIDER_ALREADY_REGISTERED',
  )
  assert.equal(registry.providerName, 'mock')
  await registration.dispose()
})

test('registry: dispose 关闭会话、释放槽位且幂等', async () => {
  const registry = new ComputerUseProviderRegistry()
  const registration = registry.register(createMockDesktopProvider({ access: new ApplicationAccess() }))
  const session = await registry.openSession({ sessionId: 'owned' })
  assert.equal(registry.activeSessionCount, 1)

  await registration.dispose()
  assert.equal(session.closed, true)
  assert.equal(registry.providerName, undefined)
  assert.equal(registry.activeSessionCount, 0)
  await registration.dispose()
  await registry.dispose()
})

test('getApp: 名称/bundleId 均可选择；未知应用与未运行应用分别报错', async () => {
  const { session, dispose } = await openMockDesktop()
  try {
    const byName = await session.getApp('Notes')
    assert.equal(byName.bundleId, 'com.apple.Notes')
    const byBundle = await session.getApp('com.apple.finder')
    assert.equal(byBundle.appId, 'finder')

    await assert.rejects(session.getApp('Terminal'), (error: unknown) =>
      error instanceof CuaError && error.code === 'APP_NOT_FOUND')
    await assert.rejects(session.getApp('Calendar'), (error: unknown) =>
      error instanceof CuaError && error.code === 'APP_NOT_RUNNING')
  } finally {
    await dispose()
  }
})

test('authorization: 未授权应用读不到窗口/AX/截图，listApps 仍可用', async () => {
  const { session, dispose } = await openMockDesktop()
  try {
    assert.equal((await session.listApps()).length, 3)
    for (const call of [
      () => session.getWindows('notes'),
      () => session.getState('notes'),
      () => session.screenshot('notes', 1),
    ]) {
      await assert.rejects(call, (error: unknown) =>
        error instanceof CuaError && error.code === 'APP_ACCESS_REQUIRED')
    }
  } finally {
    await dispose()
  }
})

test('windows: 授权后返回窗口 id、bounds 与 main 标记', async () => {
  const { session, access, dispose } = await openMockDesktop()
  try {
    access.grant('notes')
    const windows = await session.getWindows('notes')
    assert.deepEqual(windows.map(window => window.windowId), [1, 2])
    assert.deepEqual(windows[0]?.bounds, { x: 120, y: 80, width: 900, height: 640 })
    assert.equal(windows[0]?.main, true)
    assert.equal(windows[1]?.main, false)

    await assert.rejects(session.getWindows('calendar'), (error: unknown) =>
      error instanceof CuaError && error.code === 'APP_NOT_RUNNING')
  } finally {
    await dispose()
  }
})

test('state: AX 树被扁平化，index 连续，默认选主窗口', async () => {
  const { session, access, dispose } = await openMockDesktop()
  try {
    access.grant('notes')
    const main = await session.getState('notes')
    assert.equal(main.windowId, 1)
    assert.equal(main.window.title, 'Untitled — Notes')
    assert.ok(main.snapshotId.startsWith('snap-'))
    assert.deepEqual(main.elements.map(node => node.index), main.elements.map((_node, index) => index))
    assert.ok(main.elements.some(node => node.role === 'AXTextArea' && node.value === 'Shopping list'))
    assert.equal(main.elements.find(node => node.role === 'AXWindow')?.title, 'Untitled — Notes')
    assert.equal(main.truncated, false)

    const second = await session.getState('notes', 2)
    assert.equal(second.windowId, 2)
    assert.ok(second.elements.some(node => node.value === 'milk, eggs, coffee'))
    assert.notEqual(second.snapshotId, main.snapshotId)

    await assert.rejects(session.getState('notes', 99), (error: unknown) =>
      error instanceof CuaError && error.code === 'WINDOW_NOT_FOUND')
  } finally {
    await dispose()
  }
})

test('screenshot: bytes + mime + 窗口尺寸 + placeholder', async () => {
  const { session, access, dispose } = await openMockDesktop()
  try {
    access.grant('notes')
    const shot = await session.screenshot('notes', 1)
    assert.equal(shot.appId, 'notes')
    assert.equal(shot.windowId, 1)
    assert.equal(shot.mimeType, 'image/png')
    assert.equal(shot.width, 900)
    assert.equal(shot.height, 640)
    assert.ok(shot.bytes.byteLength > 0)
    assert.equal(shot.placeholder, true)

    const both = await session.screenshot('notes', 2)
    assert.equal(both.width, 760)
  } finally {
    await dispose()
  }
})

test('tool: cua 方法分发、错误收敛、截图只回元数据', async () => {
  const { session, access, dispose } = await openMockDesktop()
  const tool = createCuaTool(session)
  try {
    const denied = await runCua(tool, { method: 'getState', params: { appId: 'notes' } })
    assert.equal(denied.isError, true)
    assert.match(denied.content[0]?.text ?? '', /APP_ACCESS_REQUIRED/)

    access.grant('notes')
    const state = await runCua(tool, { method: 'getState', params: { appId: 'notes' } })
    assert.equal(state.isError, false)
    const parsed = JSON.parse(state.content[0]?.text ?? '{}') as {
      appId: string
      windowId: number
      elements: { role: string }[]
    }
    assert.equal(parsed.appId, 'notes')
    assert.equal(parsed.windowId, 1)
    assert.ok(parsed.elements.length > 0)

    const shot = await runCua(tool, { method: 'screenshot', params: { appId: 'notes', windowId: 1 } })
    assert.equal(shot.isError, false)
    const meta = JSON.parse(shot.content[0]?.text ?? '{}') as Record<string, unknown>
    assert.equal(meta.width, 900)
    assert.equal(meta.byteLength, 70)
    assert.equal(meta.placeholder, true)
    assert.equal(shot.content[0]?.text.includes('base64'), false)

    const missingWindow = await runCua(tool, { method: 'screenshot', params: { appId: 'notes' } })
    assert.equal(missingWindow.isError, true)
    assert.match(missingWindow.content[0]?.text ?? '', /INVALID_ARGUMENT/)

    const unknownMethod = await runCua(tool, { method: 'click', params: { appId: 'notes' } })
    assert.equal(unknownMethod.isError, true)
    assert.match(unknownMethod.content[0]?.text ?? '', /INVALID_ARGUMENT/)

    const badApp = await runCua(tool, { method: 'getWindows', params: { appId: 'safari' } })
    assert.equal(badApp.isError, true)
    assert.match(badApp.content[0]?.text ?? '', /APP_NOT_FOUND/)
  } finally {
    await dispose()
  }
})

test('session: 关闭后所有观测报 SESSION_CLOSED；授权撤销立即生效', async () => {
  const { session, access, dispose } = await openMockDesktop({ sessionId: 'close-test' })
  access.grant('notes')
  assert.equal((await session.getWindows('notes')).length, 2)

  assert.equal(access.revoke('notes'), true)
  await assert.rejects(session.getWindows('notes'), (error: unknown) =>
    error instanceof CuaError && error.code === 'APP_ACCESS_REQUIRED')

  await session.close()
  assert.equal(session.closed, true)
  for (const call of [
    () => session.listApps(),
    () => session.getApp('Notes'),
    () => session.getState('notes'),
  ]) {
    await assert.rejects(call, (error: unknown) =>
      error instanceof CuaError && error.code === 'SESSION_CLOSED')
  }
  await dispose()
})

test('flattenAx: 深层子节点也获得连续下标', () => {
  const flat = flattenAx([
    { role: 'AXWindow', children: [{ role: 'AXGroup', children: [{ role: 'AXButton', title: 'OK' }] }] },
  ])
  assert.deepEqual(flat.map(node => [node.index, node.role]), [
    [0, 'AXWindow'],
    [1, 'AXGroup'],
    [2, 'AXButton'],
  ])
})
