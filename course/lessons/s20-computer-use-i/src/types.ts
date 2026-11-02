/**
 * s20 · computer-use 的公开契约（macOS CUA 的简化版）。
 *
 * 真实 DSH 把「桌面」拆成 provider（Cua Driver MCP / 原生）+ 共享的
 * `ComputerUseRegistry`（只登记名字）。本课保留同样的分层：
 *
 *   ComputerUseProvider → CuaDesktopSession → app / window / AX / screenshot
 */

/** 本课错误码；真实 DSH 用 `NativeError` 的 code 承载。 */
export type CuaErrorCode =
  | 'PROVIDER_ALREADY_REGISTERED'
  | 'PROVIDER_NOT_REGISTERED'
  | 'SESSION_CLOSED'
  | 'APP_NOT_FOUND'
  | 'APP_NOT_RUNNING'
  | 'APP_ACCESS_REQUIRED'
  | 'WINDOW_NOT_FOUND'
  | 'INVALID_ARGUMENT'

export class CuaError extends Error {
  readonly code: CuaErrorCode

  constructor(code: CuaErrorCode, message: string) {
    super(message)
    this.name = 'CuaError'
    this.code = code
  }
}

/** 桌面上的一个应用。`running` 为 false 时窗口/AX/截图都不可用。 */
export interface CuaAppInfo {
  readonly appId: string
  readonly name: string
  readonly bundleId: string
  readonly pid: number
  readonly running: boolean
}

/** 窗口在屏幕坐标系中的位置与大小（单位：point）。 */
export interface CuaWindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface CuaWindowInfo {
  readonly windowId: number
  readonly appId: string
  readonly title: string
  readonly bounds: CuaWindowBounds
  /** 是否为主窗口；`getState` 省略 windowId 时使用它。 */
  readonly main: boolean
}

/** 扁平化后的一个可访问性节点。 */
export interface CuaAxNode {
  /** 在本次快照内的下标；真实 CUA 里对应 elementIndex。 */
  readonly index: number
  readonly role: string
  readonly title?: string
  readonly value?: string
  readonly actions?: readonly string[]
}

/** 一次 AX 观测；快照只在下一次观测前有效。 */
export interface CuaState {
  readonly appId: string
  readonly windowId: number
  readonly snapshotId: string
  readonly capturedAt: number
  readonly window: CuaWindowInfo
  readonly elements: readonly CuaAxNode[]
  /** 达到遍历上限时为 true；真实 provider 用它提示模型缩小范围。 */
  readonly truncated: boolean
}

/** 截图结果：bytes + mime + 尺寸。mock 的 bytes 是 1×1 PNG 占位。 */
export interface CuaScreenshot {
  readonly appId: string
  readonly windowId: number
  readonly mimeType: 'image/png'
  readonly width: number
  readonly height: number
  readonly bytes: Uint8Array
  readonly placeholder: true
}

/**
 * 一个桌面会话。
 *
 * 注意 `getState` 的授权检查发生在**读 AX 之前**：未授权的应用连树都读不到。
 * 真实 DSH 的 `application-access.ts` 正是这个顺序。
 */
export interface CuaDesktopSession {
  readonly id: string
  readonly closed: boolean
  listApps(): Promise<readonly CuaAppInfo[]>
  /** 按名称/bundleId/appId 选择应用；未找到报 APP_NOT_FOUND。 */
  getApp(selector: string): Promise<CuaAppInfo>
  getWindows(appId: string): Promise<readonly CuaWindowInfo[]>
  /** 默认选主窗口；未授权报 APP_ACCESS_REQUIRED。 */
  getState(appId: string, windowId?: number): Promise<CuaState>
  /** 截图占位；尺寸来自窗口 bounds。 */
  screenshot(appId: string, windowId: number): Promise<CuaScreenshot>
  close(): Promise<void>
}

/** 桌面后端（Cua Driver MCP / 原生 / mock）。 */
export interface ComputerUseProvider {
  readonly name: string
  open(options?: { sessionId?: string }): Promise<CuaDesktopSession>
}
