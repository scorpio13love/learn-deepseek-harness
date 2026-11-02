/**
 * s19 demo：不需要模型、不需要网络。
 *
 * 运行：node src/demo.ts
 */

import { createBrowserTools, openMockBrowser, runTool, sessionActions } from './index.ts'

async function main(): Promise<void> {
  const { session, dispose } = await openMockBrowser({ sessionId: 'demo-session' })
  try {
    const tools = createBrowserTools(session)
    for (const tool of tools) {
      console.log(`tool ${tool.name}: ${tool.description}`)
    }

    const home = await runTool(tools, 'browser_navigate', { url: 'https://mock.example/' })
    console.log('\n--- browser_navigate ---')
    console.log(home.content[0]?.text)

    const products = await runTool(tools, 'browser_click', { ref: 'e1' })
    console.log('\n--- browser_click e1 (Products link) ---')
    console.log(products.content[0]?.text)

    const read = await runTool(tools, 'browser_read', { selector: 'main' })
    console.log('\n--- browser_read main ---')
    console.log(read.content[0]?.text)

    const missing = await runTool(tools, 'browser_click', { ref: 'e99' })
    console.log('\n--- browser_click e99 (expected error) ---')
    console.log(`isError=${missing.isError} text=${missing.content[0]?.text}`)

    const screenshot = await session.screenshot()
    console.log(
      `\nscreenshot: ${screenshot.mimeType} ${screenshot.width}x${screenshot.height} ` +
        `bytes=${screenshot.bytes.byteLength} placeholder=${screenshot.placeholder}`,
    )
    console.log(`provider actions: ${sessionActions(session).join(' | ')}`)
  } finally {
    await dispose()
    console.log(`\nsession closed=${session.closed}`)
  }
}

await main()
