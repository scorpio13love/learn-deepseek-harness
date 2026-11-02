/**
 * s20 demo：不需要模型、不需要真实桌面。
 *
 * 运行：node src/demo.ts
 */

import { createCuaTool, openMockDesktop, runCua } from './index.ts'

async function main(): Promise<void> {
  const { session, access, dispose } = await openMockDesktop({ sessionId: 'demo-desktop' })
  const tool = createCuaTool(session)

  try {
    console.log('apps:')
    for (const app of await session.listApps()) {
      console.log(`  ${app.appId.padEnd(9)} ${app.name.padEnd(9)} running=${app.running}`)
    }

    const notes = await runCua(tool, { method: 'getApp', params: { selector: 'Notes' } })
    console.log('\n--- getApp ---')
    console.log(notes.content[0]?.text)

    const denied = await runCua(tool, { method: 'getWindows', params: { appId: 'notes' } })
    console.log(`\n未授权 getWindows → isError=${denied.isError} ${denied.content[0]?.text}`)

    access.grant('notes')
    console.log(`\nafter grant: ${access.list().join(', ')}`)

    const windows = await runCua(tool, { method: 'getWindows', params: { appId: 'notes' } })
    console.log('\n--- getWindows ---')
    console.log(windows.content[0]?.text)

    const state = await runCua(tool, { method: 'getState', params: { appId: 'notes', windowId: 1 } })
    console.log('\n--- getState (window 1) ---')
    console.log(state.content[0]?.text)

    const shot = await runCua(tool, { method: 'screenshot', params: { appId: 'notes', windowId: 1 } })
    console.log('\n--- screenshot (metadata) ---')
    console.log(shot.content[0]?.text)

    access.revoke('notes')
    const afterRevoke = await runCua(tool, { method: 'getState', params: { appId: 'notes' } })
    console.log(`\n撤销后 getState → isError=${afterRevoke.isError} ${afterRevoke.content[0]?.text}`)
  } finally {
    await dispose()
    console.log(`\nsession closed=${session.closed}`)
  }
}

await main()
