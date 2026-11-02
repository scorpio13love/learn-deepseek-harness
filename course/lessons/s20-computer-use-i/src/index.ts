/** s20 · computer-use：单槽位 registry、mock 桌面、AX 快照、cua 工具。 */

import { ComputerUseProviderRegistry } from './registry.ts'
import { ApplicationAccess } from './access.ts'
import { createMockDesktopProvider } from './mock-desktop.ts'
import type { CuaDesktopSession } from './types.ts'

export { CuaError } from './types.ts'
export type {
  ComputerUseProvider,
  CuaAppInfo,
  CuaAxNode,
  CuaDesktopSession,
  CuaErrorCode,
  CuaScreenshot,
  CuaState,
  CuaWindowBounds,
  CuaWindowInfo,
} from './types.ts'

export { ComputerUseProviderRegistry } from './registry.ts'
export type { ComputerUseRegistration } from './registry.ts'

export { ApplicationAccess } from './access.ts'

export {
  createMockDesktopProvider,
  DEFAULT_MOCK_APPS,
  denyAllAccess,
  flattenAx,
} from './mock-desktop.ts'
export type { MockApp, MockAxNode, MockDesktopProviderOptions, MockWindow } from './mock-desktop.ts'

export { createCuaTool, CUA_METHODS, formatError, runCua } from './tool.ts'
export type { CuaMethod, CuaTool, ToolContent, ToolResult } from './tool.ts'

/** 组合 helper：注册 mock 桌面、打开会话，并把授权表交给调用方。 */
export async function openMockDesktop(options?: {
  access?: ApplicationAccess
  sessionId?: string
}): Promise<{
  registry: ComputerUseProviderRegistry
  session: CuaDesktopSession
  access: ApplicationAccess
  dispose: () => Promise<void>
}> {
  const access = options?.access ?? new ApplicationAccess()
  const registry = new ComputerUseProviderRegistry()
  const registration = registry.register(createMockDesktopProvider({ access }))
  const session = await registry.openSession(
    options?.sessionId === undefined ? undefined : { sessionId: options.sessionId },
  )
  return { registry, session, access, dispose: () => registration.dispose() }
}
