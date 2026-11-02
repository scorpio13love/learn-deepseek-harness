/**
 * s19 离线测试：provider 单例、工具调用、错误、会话关闭。
 *
 * 运行：node --test tests/*.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BrowserError,
  BrowserProviderRegistry,
  createBrowserTools,
  createMockBrowserProvider,
  openMockBrowser,
  runTool,
  sessionActions,
} from '../src/index.ts'

test('registry: 只允许一个 provider，第二次注册（含同名）失败', async () => {
  const registry = new BrowserProviderRegistry()
  const registration = registry.register(createMockBrowserProvider())

  assert.equal(registry.providerName, 'mock')
  assert.equal(registry.hasProvider, true)
  assert.throws(
    () => registry.register(createMockBrowserProvider()),
    (error: unknown) =>
      error instanceof BrowserError &&
      error.code === 'PROVIDER_ALREADY_REGISTERED' &&
      error.message.includes('mock'),
  )
  // 失败的注册不能破坏已有 provider。
  assert.equal(registry.providerName, 'mock')
  await registration.dispose()
})

test('registry: dispose 释放槽位，disposer 幂等且能换 provider', async () => {
  const registry = new BrowserProviderRegistry()
  const first = registry.register(createMockBrowserProvider())
  const session = await registry.openSession({ sessionId: 'owned' })
  assert.equal(registry.activeSessionCount, 1)

  await first.dispose()
  assert.equal(registry.providerName, undefined)
  assert.equal(registry.hasProvider, false)
  assert.equal(registry.activeSessionCount, 0)
  assert.equal(session.closed, true, 'dispose 必须关闭注册表拥有的会话')

  await first.dispose() // 幂等
  await registry.dispose() // 空注册表也安全

  const second = registry.register({ name: 'second', open: async () => createMockBrowserProvider().open() })
  assert.equal(registry.providerName, 'second')
  await second.dispose()
})

test('registry: 未注册时打开会话报 PROVIDER_NOT_REGISTERED', async () => {
  const registry = new BrowserProviderRegistry()
  await assert.rejects(registry.openSession(), (error: unknown) =>
    error instanceof BrowserError && error.code === 'PROVIDER_NOT_REGISTERED')
  await registry.dispose()
})

test('mock: navigate / read 返回页面与稳定的元素 ref', async () => {
  const { session, dispose } = await openMockBrowser({ sessionId: 'read-test' })
  try {
    const home = await session.navigate('https://mock.example/')
    assert.equal(home.title, 'Mock Shop')
    assert.match(home.text, /offline mock shop/)
    assert.deepEqual(home.elements.map(element => element.ref), ['e1', 'e2', 'e3', 'e4', 'e5'])
    assert.equal(home.elements[0]?.href, 'https://mock.example/products')

    const main = await session.read({ selector: 'main' })
    assert.match(main.lastAction ?? '', /read main/)
    await assert.rejects(session.read({ selector: '#missing' }), (error: unknown) =>
      error instanceof BrowserError && error.code === 'ELEMENT_NOT_FOUND')
  } finally {
    await dispose()
  }
})

test('tools: browser_navigate → browser_read → browser_click 闭环', async () => {
  const { session, dispose } = await openMockBrowser({ sessionId: 'tools-test' })
  try {
    const tools = createBrowserTools(session)
    assert.deepEqual(tools.map(tool => tool.name), ['browser_navigate', 'browser_read', 'browser_click'])

    const opened = await runTool(tools, 'browser_navigate', { url: 'https://mock.example/products' })
    assert.equal(opened.isError, false)
    assert.match(opened.content[0]?.text ?? '', /title: Products — Mock Shop/)
    assert.match(opened.content[0]?.text ?? '', /\[e1\] link "Back home" -> https:\/\/mock\.example\//)

    const read = await runTool(tools, 'browser_read', {})
    assert.equal(read.isError, false)
    assert.match(read.content[0]?.text ?? '', /\[e2\] button "Add to cart"/)

    const clicked = await runTool(tools, 'browser_click', { ref: 'e1' })
    assert.equal(clicked.isError, false)
    assert.match(clicked.content[0]?.text ?? '', /url: https:\/\/mock\.example\//)
    assert.match(clicked.content[0]?.text ?? '', /lastAction: click e1 → https:\/\/mock\.example\//)
    assert.ok(sessionActions(session).includes('click e1 Back home'))
  } finally {
    await dispose()
  }
})

test('tools: 错误变成模型可见的 isError 结果（未知工具/禁用元素/缺参数）', async () => {
  const { session, dispose } = await openMockBrowser({ sessionId: 'errors-test' })
  try {
    const tools = createBrowserTools(session)

    const unknown = await runTool(tools, 'browser_scroll', {})
    assert.equal(unknown.isError, true)
    assert.match(unknown.content[0]?.text ?? '', /TOOL_UNKNOWN/)

    const disabled = await runTool(tools, 'browser_click', { ref: 'e5' })
    assert.equal(disabled.isError, true)
    assert.match(disabled.content[0]?.text ?? '', /ELEMENT_DISABLED/)

    const missing = await runTool(tools, 'browser_click', { ref: 'e99' })
    assert.equal(missing.isError, true)
    assert.match(missing.content[0]?.text ?? '', /ELEMENT_NOT_FOUND/)

    const noUrl = await runTool(tools, 'browser_navigate', {})
    assert.equal(noUrl.isError, true)
    assert.match(noUrl.content[0]?.text ?? '', /INVALID_ARGUMENT/)

    const badPage = await runTool(tools, 'browser_navigate', { url: 'https://mock.example/missing' })
    assert.equal(badPage.isError, true)
    assert.match(badPage.content[0]?.text ?? '', /PAGE_NOT_FOUND/)

    // 错误不能把 loop 打挂：会话仍然可用。
    const ok = await runTool(tools, 'browser_read', {})
    assert.equal(ok.isError, false)
  } finally {
    await dispose()
  }
})

test('mock: 截图是 bytes + mime + 尺寸的占位结果', async () => {
  const { session, dispose } = await openMockBrowser({ sessionId: 'shot-test' })
  try {
    const shot = await session.screenshot()
    assert.equal(shot.mimeType, 'image/png')
    assert.equal(shot.width, 1280)
    assert.equal(shot.height, 720)
    assert.ok(shot.bytes.byteLength > 0)
    assert.equal(shot.placeholder, true)
  } finally {
    await dispose()
  }
})

test('session: 关闭后所有操作报 SESSION_CLOSED，工具也拒绝', async () => {
  const { session, dispose } = await openMockBrowser({ sessionId: 'close-test' })
  const tools = createBrowserTools(session)

  await session.close()
  assert.equal(session.closed, true)
  await assert.rejects(session.navigate('https://mock.example/'), (error: unknown) =>
    error instanceof BrowserError && error.code === 'SESSION_CLOSED')
  await assert.rejects(session.read(), (error: unknown) =>
    error instanceof BrowserError && error.code === 'SESSION_CLOSED')

  const result = await runTool(tools, 'browser_click', { ref: 'e1' })
  assert.equal(result.isError, true)
  assert.match(result.content[0]?.text ?? '', /SESSION_CLOSED/)

  await dispose() // 已关闭的会话再 dispose 不应报错
})
