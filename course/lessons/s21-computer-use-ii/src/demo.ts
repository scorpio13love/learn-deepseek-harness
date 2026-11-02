/**
 * s21 demo：动作、坐标、失效与撤销；不需要模型、不需要真实桌面。
 *
 * 运行：node src/demo.ts
 */

import {
  createCuaTool,
  createMemoryStorage,
  ApplicationAccess,
  formatError,
  openMockDesktop,
  resizeMockWindow,
  runCua,
} from './index.ts'

async function main(): Promise<void> {
  const storage = createMemoryStorage()
  const access = new ApplicationAccess({ storage })
  const { session, dispose } = await openMockDesktop({ access, sessionId: 'demo-a' })
  const tool = createCuaTool(session)

  try {
    const denied = await runCua(tool, { method: 'getState', params: { appId: 'notes' } })
    console.log(`未授权 getState → isError=${denied.isError} ${denied.content[0]?.text}`)

    access.grant('notes', { scope: 'session', sessionId: 'demo-a' })
    access.grant('finder', { scope: 'persistent' })
    console.log(`授权: session(notes)=${access.grantsFor('demo-a').join(',')} persistent=${access.persistentGrants.join(',')}`)
    console.log(`持久授权对另一个会话可见: finder=${access.isAllowed('finder', 'other-session')}, notes=${access.isAllowed('notes', 'other-session')}`)

    const state = await session.getState('notes')
    console.log(`\ngetState → ${state.snapshotId}, elements=${state.elements.length}, window=${state.window.bounds.width}x${state.window.bounds.height}`)

    const click = await session.click({
      appId: 'notes',
      windowId: 1,
      target: { kind: 'element', snapshotId: state.snapshotId, elementIndex: 2 },
    })
    console.log(`click element 2 → ${JSON.stringify(click)}`)

    const shot = await session.screenshot('notes', 1)
    console.log(`\nscreenshot → ${shot.pixelWidth}x${shot.pixelHeight}px @${shot.scale}x (window ${shot.width}x${shot.height}pt)`)

    const absolute = await session.click({ appId: 'notes', windowId: 1, target: { kind: 'point', x: 900, y: 640 } })
    const relative = await session.click({ appId: 'notes', windowId: 1, target: { kind: 'point', x: 500, y: 500, relative: true } })
    console.log(`absolute (900,640)px → native ${JSON.stringify(absolute.nativePoint)}`)
    console.log(`relative (500,500) → native ${JSON.stringify(relative.nativePoint)}`)

    await session.type({ appId: 'notes', windowId: 1, text: ' — milk' })
    const afterType = await session.getState('notes')
    const textArea = afterType.elements.find(node => node.role === 'AXTextArea')
    console.log(`\ntype → re-observe textArea = ${JSON.stringify(textArea?.value)} (verified=false)`)

    resizeMockWindow(session, 'notes', 1, { width: 800, height: 600 })
    const stale = await session
      .click({ appId: 'notes', windowId: 1, target: { kind: 'element', snapshotId: afterType.snapshotId, elementIndex: 2 } })
      .catch((error: unknown) => error)
    console.log(`\nresize 后旧快照 click → ${stale instanceof Error ? formatError(stale) : 'unexpected success'}`)

    const fresh = await session.getState('notes')
    const refreshed = await session.click({
      appId: 'notes',
      windowId: 1,
      target: { kind: 'point', x: 500, y: 500, relative: true },
    })
    console.log(`重新 getState (${fresh.snapshotId}) 后 relative → native ${JSON.stringify(refreshed.nativePoint)}`)
    const noShot = await session
      .click({ appId: 'notes', windowId: 1, target: { kind: 'point', x: 100, y: 100 } })
      .catch((error: unknown) => error)
    console.log(`resize 后未重新截图，绝对坐标 → ${noShot instanceof Error ? formatError(noShot) : 'unexpected success'}`)

    const cancelled = await session.cancel()
    console.log(`\ncancel → ${JSON.stringify(cancelled)}`)
    console.log(`dispatched 记录: ${session.dispatched.map(item => `${item.method}#${item.id}`).join(', ')}`)

    access.revoke('notes')
    const revoked = await runCua(tool, {
      method: 'click',
      params: { appId: 'notes', windowId: 1, x: 10, y: 10, relative: true },
    })
    console.log(`\n撤销后 click → isError=${revoked.isError} ${revoked.content[0]?.text}`)
  } finally {
    await dispose()
    console.log(`\nsession closed=${session.closed}`)
  }
}

await main()
