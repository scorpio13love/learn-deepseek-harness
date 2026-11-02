/** s19 · browser-use：单槽位 registry、mock 浏览器、模型工具投影。 */

import { BrowserProviderRegistry } from './registry.ts'
import { createMockBrowserProvider } from './mock-browser.ts'
import type { BrowserProvider, BrowserSession } from './types.ts'

export { BrowserError } from './types.ts'
export type {
  BrowserElement,
  BrowserErrorCode,
  BrowserPageSnapshot,
  BrowserProvider,
  BrowserSession,
  BrowserScreenshot,
} from './types.ts'

export { BrowserProviderRegistry } from './registry.ts'
export type { BrowserProviderRegistration } from './registry.ts'

export {
  createMockBrowserProvider,
  DEFAULT_MOCK_PAGES,
  sessionActions,
} from './mock-browser.ts'
export type { MockBrowserProviderOptions, MockElement, MockPage } from './mock-browser.ts'

export { createBrowserTools, formatError, renderSnapshot, runTool } from './tools.ts'
export type { BrowserTool, ToolContent, ToolResult } from './tools.ts'

/** 一次性搭好 demo/测试常用的组合：注册 mock provider 并打开一个会话。 */
export async function openMockBrowser(options?: {
  provider?: BrowserProvider
  sessionId?: string
}): Promise<{ registry: BrowserProviderRegistry; session: BrowserSession; dispose: () => Promise<void> }> {
  const registry = new BrowserProviderRegistry()
  const registration = registry.register(options?.provider ?? createMockBrowserProvider())
  const session = await registry.openSession(
    options?.sessionId === undefined ? undefined : { sessionId: options.sessionId },
  )
  return { registry, session, dispose: () => registration.dispose() }
}
