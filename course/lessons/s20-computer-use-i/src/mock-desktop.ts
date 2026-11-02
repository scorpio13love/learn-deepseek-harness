/**
 * 离线 mock 桌面：应用列表、窗口、AX 树、截图占位。
 *
 * 它模拟的是 macOS CUA 的**结构**，不是真实桌面：
 * - app 有 bundleId / pid / running；
 * - window 有 windowId / bounds / main；
 * - AX 树按窗口给出，读取前必须通过应用授权；
 * - 截图是 1×1 PNG + 窗口尺寸声明。
 */

import { CuaError } from './types.ts'
import type {
  ComputerUseProvider,
  CuaAppInfo,
  CuaAxNode,
  CuaDesktopSession,
  CuaScreenshot,
  CuaState,
  CuaWindowBounds,
  CuaWindowInfo,
} from './types.ts'

/** mock 的嵌套 AX 节点。 */
export interface MockAxNode {
  readonly role: string
  readonly title?: string
  readonly value?: string
  readonly actions?: readonly string[]
  readonly children?: readonly MockAxNode[]
}

export interface MockWindow {
  readonly windowId: number
  readonly title: string
  readonly bounds: CuaWindowBounds
  readonly main?: boolean
  readonly ax: readonly MockAxNode[]
}

export interface MockApp {
  readonly info: CuaAppInfo
  readonly windows: readonly MockWindow[]
}

/** 1×1 透明 PNG；证明截图结果是 bytes + mime + 尺寸，而不是画面。 */
const PLACEHOLDER_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** 默认 mock 桌面：Notes（两个窗口）、Finder、未运行的 Calendar。 */
export const DEFAULT_MOCK_APPS: readonly MockApp[] = [
  {
    info: { appId: 'notes', name: 'Notes', bundleId: 'com.apple.Notes', pid: 501, running: true },
    windows: [
      {
        windowId: 1,
        title: 'Untitled — Notes',
        bounds: { x: 120, y: 80, width: 900, height: 640 },
        main: true,
        ax: [
          {
            role: 'AXWindow',
            title: 'Untitled — Notes',
            children: [
              { role: 'AXMenuBar', children: [{ role: 'AXMenuBarItem', title: 'File' }, { role: 'AXMenuBarItem', title: 'Edit' }] },
              {
                role: 'AXToolbar',
                children: [
                  { role: 'AXButton', title: 'New Note', actions: ['AXPress'] },
                  { role: 'AXButton', title: 'Delete', actions: ['AXPress'] },
                ],
              },
              { role: 'AXTextArea', title: 'Note body', value: 'Shopping list', actions: ['AXPress', 'AXConfirm'] },
            ],
          },
        ],
      },
      {
        windowId: 2,
        title: 'Shopping list — Notes',
        bounds: { x: 220, y: 140, width: 760, height: 600 },
        ax: [
          {
            role: 'AXWindow',
            title: 'Shopping list — Notes',
            children: [{ role: 'AXTextArea', title: 'Note body', value: 'milk, eggs, coffee' }],
          },
        ],
      },
    ],
  },
  {
    info: { appId: 'finder', name: 'Finder', bundleId: 'com.apple.finder', pid: 502, running: true },
    windows: [
      {
        windowId: 3,
        title: 'Recents',
        bounds: { x: 40, y: 40, width: 1000, height: 700 },
        main: true,
        ax: [
          {
            role: 'AXWindow',
            title: 'Recents',
            children: [
              { role: 'AXOutline', title: 'Sidebar', children: [{ role: 'AXRow', title: 'Desktop' }, { role: 'AXRow', title: 'Documents' }] },
              { role: 'AXTable', title: 'Files', value: '3 items' },
            ],
          },
        ],
      },
    ],
  },
  {
    info: { appId: 'calendar', name: 'Calendar', bundleId: 'com.apple.iCal', pid: 503, running: false },
    windows: [],
  },
]

/** 扁平化嵌套 AX 树，给每个节点分配快照内下标。 */
export function flattenAx(nodes: readonly MockAxNode[]): CuaAxNode[] {
  const flat: CuaAxNode[] = []
  const walk = (node: MockAxNode): void => {
    flat.push({
      index: flat.length,
      role: node.role,
      ...(node.title === undefined ? {} : { title: node.title }),
      ...(node.value === undefined ? {} : { value: node.value }),
      ...(node.actions === undefined ? {} : { actions: node.actions }),
    })
    for (const child of node.children ?? []) walk(child)
  }
  for (const node of nodes) walk(node)
  return flat
}

interface AppRecord {
  readonly info: CuaAppInfo
  readonly windows: readonly MockWindow[]
}

class MockDesktopSession implements CuaDesktopSession {
  readonly id: string
  private readonly apps: readonly AppRecord[]
  private readonly access: { require(appId: string): void; isGranted(appId: string): boolean }
  private isClosed = false
  private snapshotCounter = 0

  constructor(
    id: string,
    apps: readonly AppRecord[],
    access: { require(appId: string): void; isGranted(appId: string): boolean },
  ) {
    this.id = id
    this.apps = apps
    this.access = access
  }

  get closed(): boolean {
    return this.isClosed
  }

  async listApps(): Promise<readonly CuaAppInfo[]> {
    this.assertOpen()
    return this.apps.map(app => app.info)
  }

  async getApp(selector: string): Promise<CuaAppInfo> {
    this.assertOpen()
    const record = this.findApp(selector)
    if (!record.info.running) {
      throw new CuaError('APP_NOT_RUNNING', `application "${record.info.name}" is not running (mock cannot launch apps)`)
    }
    return record.info
  }

  async getWindows(appId: string): Promise<readonly CuaWindowInfo[]> {
    this.assertOpen()
    const record = this.requireApp(appId)
    this.access.require(appId)
    return record.windows.map(window => this.windowInfo(record.info.appId, window))
  }

  async getState(appId: string, windowId?: number): Promise<CuaState> {
    this.assertOpen()
    const record = this.requireApp(appId)
    // 授权检查必须在读取 AX 之前：未授权时连树都不存在。
    this.access.require(appId)
    const window = this.pickWindow(record, windowId)
    this.snapshotCounter += 1
    return {
      appId: record.info.appId,
      windowId: window.windowId,
      snapshotId: `snap-${this.snapshotCounter}`,
      capturedAt: Date.now(),
      window: this.windowInfo(record.info.appId, window),
      elements: flattenAx(window.ax),
      truncated: false,
    }
  }

  async screenshot(appId: string, windowId: number): Promise<CuaScreenshot> {
    this.assertOpen()
    const record = this.requireApp(appId)
    this.access.require(appId)
    const window = this.pickWindow(record, windowId)
    return {
      appId: record.info.appId,
      windowId: window.windowId,
      mimeType: 'image/png',
      width: window.bounds.width,
      height: window.bounds.height,
      bytes: Uint8Array.from(Buffer.from(PLACEHOLDER_PNG, 'base64')),
      placeholder: true,
    }
  }

  async close(): Promise<void> {
    this.isClosed = true
  }

  private findApp(selector: string): AppRecord {
    if (typeof selector !== 'string' || selector.trim().length === 0) {
      throw new CuaError('INVALID_ARGUMENT', 'selector must be a non-empty string')
    }
    const wanted = selector.trim().toLowerCase()
    const record = this.apps.find(app =>
      app.info.appId.toLowerCase() === wanted ||
      app.info.bundleId.toLowerCase() === wanted ||
      app.info.name.toLowerCase() === wanted)
    if (record === undefined) {
      throw new CuaError('APP_NOT_FOUND', `no application matches "${selector}"`)
    }
    return record
  }

  private requireApp(appId: string): AppRecord {
    const record = this.apps.find(app => app.info.appId === appId)
    if (record === undefined) throw new CuaError('APP_NOT_FOUND', `no application with appId "${appId}"`)
    if (!record.info.running) {
      throw new CuaError('APP_NOT_RUNNING', `application "${record.info.name}" is not running`)
    }
    return record
  }

  private pickWindow(record: AppRecord, windowId?: number): MockWindow {
    if (windowId !== undefined) {
      if (!Number.isInteger(windowId)) {
        throw new CuaError('INVALID_ARGUMENT', 'windowId must be an integer')
      }
      const window = record.windows.find(candidate => candidate.windowId === windowId)
      if (window === undefined) {
        throw new CuaError('WINDOW_NOT_FOUND', `application "${record.info.name}" has no window ${windowId}`)
      }
      return window
    }
    const main = record.windows.find(window => window.main === true) ?? record.windows[0]
    if (main === undefined) {
      throw new CuaError('WINDOW_NOT_FOUND', `application "${record.info.name}" has no windows`)
    }
    return main
  }

  private windowInfo(appId: string, window: MockWindow): CuaWindowInfo {
    return {
      windowId: window.windowId,
      appId,
      title: window.title,
      bounds: window.bounds,
      main: window.main === true,
    }
  }

  private assertOpen(): void {
    if (this.isClosed) throw new CuaError('SESSION_CLOSED', `desktop session "${this.id}" is closed`)
  }
}

export interface MockDesktopProviderOptions {
  readonly apps?: readonly MockApp[]
  readonly access?: { require(appId: string): void; isGranted(appId: string): boolean }
}

/** 创建 mock 桌面 provider。access 由调用方注入，便于测试未授权路径。 */
export function createMockDesktopProvider(options: MockDesktopProviderOptions = {}): ComputerUseProvider {
  const apps = (options.apps ?? DEFAULT_MOCK_APPS).map(app => ({ info: app.info, windows: app.windows }))
  const access = options.access ?? denyAllAccess()
  let nextId = 1
  return {
    name: 'mock',
    async open(openOptions?: { sessionId?: string }): Promise<CuaDesktopSession> {
      const id = openOptions?.sessionId ?? `mock-desktop-${nextId++}`
      return new MockDesktopSession(id, apps, access)
    },
  }
}

/** 默认拒绝所有应用；demo/测试先显式授权。 */
export function denyAllAccess(): { require(appId: string): void; isGranted(appId: string): boolean } {
  return {
    require(appId: string): void {
      throw new CuaError('APP_ACCESS_REQUIRED', `application "${appId}" is not authorized`)
    },
    isGranted(): boolean {
      return false
    },
  }
}
