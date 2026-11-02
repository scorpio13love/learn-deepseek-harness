/** s21 · computer-use II：动作、坐标、快照失效、授权撤销。 */

import { ComputerUseProviderRegistry } from './registry.ts'
import { ApplicationAccess } from './access.ts'
import { createMockDesktopProvider } from './mock-desktop.ts'
import type { CuaSession } from './types.ts'

export { CuaError } from './types.ts'
export type {
  AccessScope,
  ComputerUseProvider,
  CuaActionMethod,
  CuaActionReceipt,
  CuaAppInfo,
  CuaAxNode,
  CuaCancelResult,
  CuaDispatch,
  CuaElementTarget,
  CuaErrorCode,
  CuaPointTarget,
  CuaScreenshot,
  CuaSession,
  CuaState,
  CuaTarget,
  CuaWindowBounds,
  CuaWindowInfo,
} from './types.ts'

export { ComputerUseProviderRegistry } from './registry.ts'
export type { ComputerUseRegistration } from './registry.ts'

export { ApplicationAccess, createMemoryStorage } from './access.ts'
export type { AccessStorage, GrantOptions } from './access.ts'

export { toNativePoint } from './coordinates.ts'
export type { FrameGeometry, ScreenshotGeometry } from './coordinates.ts'

export {
  createMockDesktopProvider,
  DEFAULT_MOCK_APPS,
  flattenAx,
  MockDesktopSession,
  resizeMockWindow,
} from './mock-desktop.ts'
export type { MockApp, MockAxNode, MockWindow } from './mock-desktop.ts'

export { createCuaTool, CUA_METHODS, formatError, runCua } from './tool.ts'
export type { CuaMethod, CuaTool, ToolContent, ToolResult } from './tool.ts'

/** 组合 helper：注册 mock 桌面、用给定 sessionId 打开会话。 */
export async function openMockDesktop(options?: {
  access?: ApplicationAccess
  sessionId?: string
}): Promise<{
  registry: ComputerUseProviderRegistry
  session: CuaSession
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
