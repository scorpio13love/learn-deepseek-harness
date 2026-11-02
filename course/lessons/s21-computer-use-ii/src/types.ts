/**
 * s21 · computer-use II：动作、坐标、快照失效与授权撤销。
 *
 * 在 s20 的「观察」之上补三件事：
 *   1. 输入动作 click / type / press / scroll —— 返回 dispatched，但 verified=false；
 *   2. 坐标换算 —— 绝对坐标是截图像素，相对坐标是 0-999 的千分比；
 *   3. 状态失效 —— STALE_SNAPSHOT（旧快照）、WINDOW_CHANGED（窗口几何变了）、
 *      SCREENSHOT_REQUIRED（绝对坐标前没截图）。
 *
 * 这一课把 macOS CUA 里最容易被忽略的事实摆到台面上：
 * **输入一旦派发就不可撤销；成功只代表 dispatched，不代表 verified。**
 */

export type CuaErrorCode =
  | 'PROVIDER_ALREADY_REGISTERED'
  | 'PROVIDER_NOT_REGISTERED'
  | 'SESSION_CLOSED'
  | 'APP_NOT_FOUND'
  | 'APP_NOT_RUNNING'
  | 'APP_ACCESS_REQUIRED'
  | 'WINDOW_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'STALE_SNAPSHOT'
  | 'WINDOW_CHANGED'
  | 'SCREENSHOT_REQUIRED'
  | 'PERSISTENCE_UNAVAILABLE'

export class CuaError extends Error {
  readonly code: CuaErrorCode

  constructor(code: CuaErrorCode, message: string) {
    super(message)
    this.name = 'CuaError'
    this.code = code
  }
}

/** 授权范围：session 只在本会话有效；persistent 可跨会话/重启。 */
export type AccessScope = 'session' | 'persistent'

/** 动作方法；与真实 `tools.cua` 的 method 名称对齐。 */
export type CuaActionMethod = 'click' | 'type' | 'press' | 'scroll'

export interface CuaAppInfo {
  readonly appId: string
  readonly name: string
  readonly bundleId: string
  readonly pid: number
  readonly running: boolean
}

/** 窗口在屏幕坐标系中的位置与大小（point）。 */
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
  readonly main: boolean
}

export interface CuaAxNode {
  readonly index: number
  readonly role: string
  readonly title?: string
  readonly value?: string
  readonly actions?: readonly string[]
}

/** 一次 AX 观测；`snapshotId` 是该观测的代际。 */
export interface CuaState {
  readonly appId: string
  readonly windowId: number
  readonly snapshotId: string
  readonly capturedAt: number
  readonly window: CuaWindowInfo
  readonly elements: readonly CuaAxNode[]
  readonly truncated: boolean
}

/**
 * 截图。
 * 窗口几何用 point，截图用 pixel；`scale` 是两者之比（Retina 通常为 2）。
 */
export interface CuaScreenshot {
  readonly appId: string
  readonly windowId: number
  readonly mimeType: 'image/png'
  /** 窗口宽高（point）。 */
  readonly width: number
  readonly height: number
  /** 截图宽高（pixel）；绝对坐标以它为准。 */
  readonly pixelWidth: number
  readonly pixelHeight: number
  readonly scale: number
  readonly bytes: Uint8Array
  readonly placeholder: true
}

/** 元素目标：必须回传产生它的快照 id。 */
export interface CuaElementTarget {
  readonly kind: 'element'
  readonly snapshotId: string
  readonly elementIndex: number
}

/**
 * 坐标目标。
 * - `relative: true`：x/y 是 0-999 的千分比，窗口尺寸变化后仍可用；
 * - 省略或 false：x/y 是「最近一次截图」的像素坐标。
 */
export interface CuaPointTarget {
  readonly kind: 'point'
  readonly x: number
  readonly y: number
  readonly relative?: boolean
}

export type CuaTarget = CuaElementTarget | CuaPointTarget

/** 一次已派发的输入。mock 记录它，真实 CUA 也只能观测到「已发出」。 */
export interface CuaDispatch {
  readonly id: string
  readonly method: CuaActionMethod
  readonly appId: string
  readonly windowId: number
  readonly dispatchedAt: number
  /** 永远为 false：派发成功 ≠ 界面已生效。 */
  readonly verified: false
  /** 永远为 true：桌面已收到的输入不能撤销。 */
  readonly irreversible: true
  readonly elementIndex?: number
  readonly nativePoint?: { readonly x: number; readonly y: number }
  readonly text?: string
  readonly key?: string
  readonly modifiers?: readonly string[]
  readonly deltaLinesX?: number
  readonly deltaLinesY?: number
}

/** 动作回执：告诉模型「已经发出，去重新观察」。 */
export interface CuaActionReceipt {
  readonly status: 'dispatched'
  readonly verified: false
  readonly irreversible: true
  readonly dispatchId: string
  readonly method: CuaActionMethod
  readonly appId: string
  readonly windowId: number
  readonly elementIndex?: number
  readonly nativePoint?: { readonly x: number; readonly y: number }
  readonly note: string
}

export interface CuaCancelResult {
  readonly cancelled: true
  readonly undone: false
  readonly dispatchCount: number
  readonly note: string
}

/** 一个桌面会话（观察 + 动作 + 撤销）。 */
export interface CuaSession {
  readonly id: string
  readonly closed: boolean
  /** 已派发的输入；用于演示「不可撤销」。 */
  readonly dispatched: readonly CuaDispatch[]

  listApps(): Promise<readonly CuaAppInfo[]>
  getApp(selector: string): Promise<CuaAppInfo>
  getWindows(appId: string): Promise<readonly CuaWindowInfo[]>
  getState(appId: string, windowId?: number): Promise<CuaState>
  screenshot(appId: string, windowId: number): Promise<CuaScreenshot>

  click(input: { appId: string; windowId: number; target: CuaTarget }): Promise<CuaActionReceipt>
  type(input: { appId: string; windowId: number; text: string }): Promise<CuaActionReceipt>
  press(input: {
    appId: string
    windowId: number
    key: string
    modifiers?: readonly string[]
  }): Promise<CuaActionReceipt>
  scroll(input: {
    appId: string
    windowId: number
    target: CuaPointTarget
    deltaLinesX: number
    deltaLinesY: number
  }): Promise<CuaActionReceipt>

  /** 取消等待中的工作；已派发的输入不会回滚。 */
  cancel(): Promise<CuaCancelResult>
  close(): Promise<void>
}

/** 桌面后端（Cua Driver MCP / 原生 / mock）。 */
export interface ComputerUseProvider {
  readonly name: string
  open(options?: { sessionId?: string }): Promise<CuaSession>
}
