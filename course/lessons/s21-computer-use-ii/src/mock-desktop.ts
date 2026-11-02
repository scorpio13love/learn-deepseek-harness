/**
 * s21 mock 桌面：在 s20 的观察之上加动作、坐标与失效检测。
 *
 * 失效模型（对应真实 CUA 的 guidance）：
 * - 每次 getState 产生新 snapshotId；只有「当前窗口的最新快照」可用于元素动作；
 * - 窗口尺寸变化会让旧快照/旧截图失效：先报 WINDOW_CHANGED，重新 getState 后可恢复；
 * - 绝对坐标必须基于该窗口最近一次截图，否则 SCREENSHOT_REQUIRED；
 * - 所有动作只记录 dispatched，verified 恒为 false，且不可撤销。
 */

import { toNativePoint } from './coordinates.ts'
import { ApplicationAccess } from './access.ts'
import { CuaError } from './types.ts'
import type {
  ComputerUseProvider,
  CuaActionMethod,
  CuaActionReceipt,
  CuaAppInfo,
  CuaAxNode,
  CuaCancelResult,
  CuaDispatch,
  CuaPointTarget,
  CuaScreenshot,
  CuaSession,
  CuaState,
  CuaTarget,
  CuaWindowBounds,
  CuaWindowInfo,
} from './types.ts'

/** mock 的嵌套 AX 节点；`value` 可变，用来演示 type 的可见效果。 */
export interface MockAxNode {
  readonly role: string
  readonly title?: string
  value?: string
  readonly actions?: readonly string[]
  readonly children?: readonly MockAxNode[]
}

export interface MockWindow {
  readonly windowId: number
  readonly title: string
  readonly bounds: CuaWindowBounds
  readonly main?: boolean
  /** 截图缩放比：Retina 为 2。绝对坐标以截图像素为准。 */
  readonly scale?: number
  readonly ax: readonly MockAxNode[]
}

export interface MockApp {
  readonly info: CuaAppInfo
  readonly windows: readonly MockWindow[]
}

/** 1×1 透明 PNG；证明结果是 bytes + mime + 尺寸，而不是画面。 */
const PLACEHOLDER_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** 默认 mock 桌面：Notes（Retina 2×，两个窗口）、Finder（1×）、未运行的 Calendar。 */
export const DEFAULT_MOCK_APPS: readonly MockApp[] = [
  {
    info: { appId: 'notes', name: 'Notes', bundleId: 'com.apple.Notes', pid: 501, running: true },
    windows: [
      {
        windowId: 1,
        title: 'Untitled — Notes',
        bounds: { x: 120, y: 80, width: 900, height: 640 },
        main: true,
        scale: 2,
        ax: [
          {
            role: 'AXWindow',
            title: 'Untitled — Notes',
            children: [
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
        scale: 2,
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
        scale: 1,
        ax: [
          {
            role: 'AXWindow',
            title: 'Recents',
            children: [
              { role: 'AXOutline', title: 'Sidebar', children: [{ role: 'AXRow', title: 'Desktop' }] },
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
    const entry: CuaAxNode = {
      index: flat.length,
      role: node.role,
      ...(node.title === undefined ? {} : { title: node.title }),
      ...(node.value === undefined ? {} : { value: node.value }),
      ...(node.actions === undefined ? {} : { actions: node.actions }),
    }
    flat.push(entry)
    for (const child of node.children ?? []) walk(child)
  }
  for (const node of nodes) walk(node)
  return flat
}

/** 在嵌套树里找第一个满足条件的节点（可变引用）。 */
function findNode(nodes: readonly MockAxNode[], predicate: (node: MockAxNode) => boolean): MockAxNode | undefined {
  for (const node of nodes) {
    if (predicate(node)) return node
    const child = findNode(node.children ?? [], predicate)
    if (child !== undefined) return child
  }
  return undefined
}

interface WindowState {
  windowId: number
  title: string
  bounds: CuaWindowBounds
  main: boolean
  scale: number
  ax: MockAxNode[]
  /** 尺寸每变一次 +1；用于检测「快照/截图之后窗口变了」。 */
  generation: number
}

interface AppState {
  info: CuaAppInfo
  windows: WindowState[]
}

interface SnapshotRecord {
  readonly appId: string
  readonly windowId: number
  readonly generation: number
  readonly elementCount: number
}

interface ScreenshotRecord {
  readonly pixelWidth: number
  readonly pixelHeight: number
  readonly generation: number
}

export class MockDesktopSession implements CuaSession {
  readonly id: string
  private readonly apps: AppState[]
  private readonly access: ApplicationAccess
  private isClosed = false

  private snapshotCounter = 0
  private dispatchCounter = 0

  private readonly snapshots = new Map<string, SnapshotRecord>()
  private readonly latestSnapshot = new Map<string, string>()
  private readonly screenshots = new Map<string, ScreenshotRecord>()
  /** 最近一次观测（getState 或 screenshot）时的窗口代际。 */
  private readonly observedGeneration = new Map<string, number>()
  private readonly dispatches: CuaDispatch[] = []

  constructor(id: string, apps: AppState[], access: ApplicationAccess) {
    this.id = id
    this.apps = apps
    this.access = access
  }

  get closed(): boolean {
    return this.isClosed
  }

  get dispatched(): readonly CuaDispatch[] {
    return this.dispatches
  }

  async listApps(): Promise<readonly CuaAppInfo[]> {
    this.assertOpen()
    return this.apps.map(app => app.info)
  }

  async getApp(selector: string): Promise<CuaAppInfo> {
    this.assertOpen()
    const app = this.findApp(selector)
    if (!app.info.running) {
      throw new CuaError('APP_NOT_RUNNING', `application "${app.info.name}" is not running (mock cannot launch apps)`)
    }
    return app.info
  }

  async getWindows(appId: string): Promise<readonly CuaWindowInfo[]> {
    this.assertOpen()
    const app = this.requireApp(appId)
    this.access.check(appId, this.id)
    return app.windows.map(window => this.windowInfo(app.info.appId, window))
  }

  async getState(appId: string, windowId?: number): Promise<CuaState> {
    this.assertOpen()
    const { app, window } = this.requireWindow(appId, windowId)
    this.access.check(appId, this.id)

    this.snapshotCounter += 1
    const snapshotId = `snap-${this.snapshotCounter}`
    const key = this.key(appId, window.windowId)
    const elements = flattenAx(window.ax)

    this.snapshots.set(snapshotId, {
      appId,
      windowId: window.windowId,
      generation: window.generation,
      elementCount: elements.length,
    })
    this.latestSnapshot.set(key, snapshotId)
    this.observedGeneration.set(key, window.generation)

    return {
      appId,
      windowId: window.windowId,
      snapshotId,
      capturedAt: Date.now(),
      window: this.windowInfo(app.info.appId, window),
      elements,
      truncated: false,
    }
  }

  async screenshot(appId: string, windowId: number): Promise<CuaScreenshot> {
    this.assertOpen()
    const { window } = this.requireWindow(appId, windowId)
    this.access.check(appId, this.id)

    const key = this.key(appId, windowId)
    const pixelWidth = Math.max(1, Math.round(window.bounds.width * window.scale))
    const pixelHeight = Math.max(1, Math.round(window.bounds.height * window.scale))
    this.screenshots.set(key, { pixelWidth, pixelHeight, generation: window.generation })
    this.observedGeneration.set(key, window.generation)

    return {
      appId,
      windowId,
      mimeType: 'image/png',
      width: window.bounds.width,
      height: window.bounds.height,
      pixelWidth,
      pixelHeight,
      scale: window.scale,
      bytes: Uint8Array.from(Buffer.from(PLACEHOLDER_PNG, 'base64')),
      placeholder: true,
    }
  }

  async click(input: { appId: string; windowId: number; target: CuaTarget }): Promise<CuaActionReceipt> {
    this.assertOpen()
    const { window } = this.requireWindow(input.appId, input.windowId)
    this.access.check(input.appId, this.id)

    if (input.target.kind === 'element') {
      this.assertElementTarget(input.appId, window, input.target.snapshotId, input.target.elementIndex)
      return this.record('click', input.appId, window.windowId, { elementIndex: input.target.elementIndex })
    }
    const point = this.resolvePoint(input.appId, window, input.target)
    return this.record('click', input.appId, window.windowId, { nativePoint: point })
  }

  async type(input: { appId: string; windowId: number; text: string }): Promise<CuaActionReceipt> {
    this.assertOpen()
    const { window } = this.requireWindow(input.appId, input.windowId)
    this.access.check(input.appId, this.id)
    if (typeof input.text !== 'string' || input.text.length === 0) {
      throw new CuaError('INVALID_ARGUMENT', '"text" must be a non-empty string')
    }

    // mock 的可见效果：追加到窗口里第一个文本框，便于下一步 getState 验证。
    const textArea = findNode(window.ax, node => node.role === 'AXTextArea')
    if (textArea !== undefined) textArea.value = `${textArea.value ?? ''}${input.text}`

    return this.record('type', input.appId, window.windowId, { text: input.text })
  }

  async press(input: {
    appId: string
    windowId: number
    key: string
    modifiers?: readonly string[]
  }): Promise<CuaActionReceipt> {
    this.assertOpen()
    const { window } = this.requireWindow(input.appId, input.windowId)
    this.access.check(input.appId, this.id)
    if (typeof input.key !== 'string' || input.key.length === 0) {
      throw new CuaError('INVALID_ARGUMENT', '"key" must be a non-empty string')
    }
    const modifiers = input.modifiers ?? []
    if (!Array.isArray(modifiers) || modifiers.some(modifier => typeof modifier !== 'string')) {
      throw new CuaError('INVALID_ARGUMENT', '"modifiers" must be an array of strings')
    }
    return this.record('press', input.appId, window.windowId, {
      key: input.key,
      ...(modifiers.length === 0 ? {} : { modifiers: [...modifiers] }),
    })
  }

  async scroll(input: {
    appId: string
    windowId: number
    target: CuaPointTarget
    deltaLinesX: number
    deltaLinesY: number
  }): Promise<CuaActionReceipt> {
    this.assertOpen()
    const { window } = this.requireWindow(input.appId, input.windowId)
    this.access.check(input.appId, this.id)
    for (const [name, value] of [['deltaLinesX', input.deltaLinesX], ['deltaLinesY', input.deltaLinesY]] as const) {
      if (!Number.isInteger(value) || value < -10 || value > 10) {
        throw new CuaError('INVALID_ARGUMENT', `"${name}" must be an integer from -10 to 10`)
      }
    }
    const point = this.resolvePoint(input.appId, window, input.target)
    return this.record('scroll', input.appId, window.windowId, {
      nativePoint: point,
      deltaLinesX: input.deltaLinesX,
      deltaLinesY: input.deltaLinesY,
    })
  }

  async cancel(): Promise<CuaCancelResult> {
    this.assertOpen()
    return {
      cancelled: true,
      undone: false,
      dispatchCount: this.dispatches.length,
      note: 'Dispatched desktop input cannot be undone; observe fresh state before deciding what to do next.',
    }
  }

  async close(): Promise<void> {
    this.isClosed = true
  }

  /**
   * mock-only：模拟外部窗口尺寸变化。
   * 真实桌面的 resize 由系统发生，provider 只能通过 AX/截图观察到。
   */
  resizeWindow(appId: string, windowId: number, size: { width: number; height: number }): void {
    const { window } = this.requireWindow(appId, windowId)
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
      throw new CuaError('INVALID_ARGUMENT', 'window size must be positive')
    }
    window.bounds = { ...window.bounds, width: size.width, height: size.height }
    window.generation += 1
    // 旧截图保留但代际不符：任何基于它的绝对坐标都会被拒绝。
  }

  private key(appId: string, windowId: number): string {
    return `${appId}:${windowId}`
  }

  private findApp(selector: string): AppState {
    if (typeof selector !== 'string' || selector.trim().length === 0) {
      throw new CuaError('INVALID_ARGUMENT', 'selector must be a non-empty string')
    }
    const wanted = selector.trim().toLowerCase()
    const app = this.apps.find(candidate =>
      candidate.info.appId.toLowerCase() === wanted ||
      candidate.info.bundleId.toLowerCase() === wanted ||
      candidate.info.name.toLowerCase() === wanted)
    if (app === undefined) throw new CuaError('APP_NOT_FOUND', `no application matches "${selector}"`)
    return app
  }

  private requireApp(appId: string): AppState {
    const app = this.apps.find(candidate => candidate.info.appId === appId)
    if (app === undefined) throw new CuaError('APP_NOT_FOUND', `no application with appId "${appId}"`)
    if (!app.info.running) throw new CuaError('APP_NOT_RUNNING', `application "${app.info.name}" is not running`)
    return app
  }

  private requireWindow(appId: string, windowId?: number): { app: AppState; window: WindowState } {
    const app = this.requireApp(appId)
    if (windowId === undefined) {
      const main = app.windows.find(window => window.main) ?? app.windows[0]
      if (main === undefined) throw new CuaError('WINDOW_NOT_FOUND', `application "${app.info.name}" has no windows`)
      return { app, window: main }
    }
    if (!Number.isInteger(windowId)) throw new CuaError('INVALID_ARGUMENT', 'windowId must be an integer')
    const window = app.windows.find(candidate => candidate.windowId === windowId)
    if (window === undefined) {
      throw new CuaError('WINDOW_NOT_FOUND', `application "${app.info.name}" has no window ${windowId}`)
    }
    return { app, window }
  }

  private assertElementTarget(
    appId: string,
    window: WindowState,
    snapshotId: string,
    elementIndex: number,
  ): void {
    const key = this.key(appId, window.windowId)
    const snapshot = this.snapshots.get(snapshotId)
    if (
      snapshot === undefined ||
      snapshot.appId !== appId ||
      snapshot.windowId !== window.windowId ||
      this.latestSnapshot.get(key) !== snapshotId
    ) {
      throw new CuaError('STALE_SNAPSHOT', 'read fresh window state with getState before using this snapshot')
    }
    if (snapshot.generation !== window.generation) {
      throw new CuaError('WINDOW_CHANGED', 'window changed size since the snapshot; read fresh state before input')
    }
    if (!Number.isInteger(elementIndex) || elementIndex < 0 || elementIndex >= snapshot.elementCount) {
      throw new CuaError(
        'INVALID_ARGUMENT',
        `elementIndex ${String(elementIndex)} is outside snapshot "${snapshotId}"`,
      )
    }
  }

  private resolvePoint(appId: string, window: WindowState, target: CuaPointTarget): { x: number; y: number } {
    const key = this.key(appId, window.windowId)
    const observed = this.observedGeneration.get(key)
    if (observed === undefined) {
      throw new CuaError('STALE_SNAPSHOT', 'read fresh window state before coordinate input')
    }
    if (observed !== window.generation) {
      throw new CuaError('WINDOW_CHANGED', 'window changed size since the last observation; observe again')
    }
    const screenshot = this.screenshots.get(key)
    const fresh = screenshot !== undefined && screenshot.generation === window.generation ? screenshot : undefined
    return toNativePoint(target, { width: window.bounds.width, height: window.bounds.height, scale: window.scale }, fresh)
  }

  private record(
    method: CuaActionMethod,
    appId: string,
    windowId: number,
    extra: {
      elementIndex?: number
      nativePoint?: { x: number; y: number }
      text?: string
      key?: string
      modifiers?: readonly string[]
      deltaLinesX?: number
      deltaLinesY?: number
    },
  ): CuaActionReceipt {
    this.dispatchCounter += 1
    const dispatchId = `dispatch-${this.dispatchCounter}`
    const dispatch: CuaDispatch = {
      id: dispatchId,
      method,
      appId,
      windowId,
      dispatchedAt: Date.now(),
      verified: false,
      irreversible: true,
      ...(extra.elementIndex === undefined ? {} : { elementIndex: extra.elementIndex }),
      ...(extra.nativePoint === undefined ? {} : { nativePoint: extra.nativePoint }),
      ...(extra.text === undefined ? {} : { text: extra.text }),
      ...(extra.key === undefined ? {} : { key: extra.key }),
      ...(extra.modifiers === undefined ? {} : { modifiers: extra.modifiers }),
      ...(extra.deltaLinesX === undefined ? {} : { deltaLinesX: extra.deltaLinesX }),
      ...(extra.deltaLinesY === undefined ? {} : { deltaLinesY: extra.deltaLinesY }),
    }
    this.dispatches.push(dispatch)

    return {
      status: 'dispatched',
      verified: false,
      irreversible: true,
      dispatchId,
      method,
      appId,
      windowId,
      ...(extra.elementIndex === undefined ? {} : { elementIndex: extra.elementIndex }),
      ...(extra.nativePoint === undefined ? {} : { nativePoint: extra.nativePoint }),
      note: 'Input was dispatched, not verified. It cannot be undone; read fresh state to verify the effect.',
    }
  }

  private windowInfo(appId: string, window: WindowState): CuaWindowInfo {
    return {
      windowId: window.windowId,
      appId,
      title: window.title,
      bounds: window.bounds,
      main: window.main,
    }
  }

  private assertOpen(): void {
    if (this.isClosed) throw new CuaError('SESSION_CLOSED', `desktop session "${this.id}" is closed`)
  }
}

/** 创建 mock 桌面 provider。默认授权表为空：所有应用都需要先授权。 */
export function createMockDesktopProvider(options: {
  readonly apps?: readonly MockApp[]
  readonly access?: ApplicationAccess
} = {}): ComputerUseProvider {
  const source = options.apps ?? DEFAULT_MOCK_APPS
  const apps: AppState[] = source.map(app => ({
    info: app.info,
    windows: app.windows.map(window => ({
      windowId: window.windowId,
      title: window.title,
      bounds: { ...window.bounds },
      main: window.main === true,
      scale: window.scale ?? 1,
      ax: cloneAx(window.ax),
      generation: 0,
    })),
  }))
  const access = options.access ?? new ApplicationAccess()
  let nextId = 1

  return {
    name: 'mock',
    async open(openOptions?: { sessionId?: string }): Promise<CuaSession> {
      const id = openOptions?.sessionId ?? `mock-desktop-${nextId++}`
      return new MockDesktopSession(id, apps, access)
    },
  }
}

/** 深拷贝 AX 树，保证不同 provider 实例互不影响。 */
function cloneAx(nodes: readonly MockAxNode[]): MockAxNode[] {
  return nodes.map(node => ({
    role: node.role,
    ...(node.title === undefined ? {} : { title: node.title }),
    ...(node.value === undefined ? {} : { value: node.value }),
    ...(node.actions === undefined ? {} : { actions: node.actions }),
    ...(node.children === undefined ? {} : { children: cloneAx(node.children) }),
  }))
}

/**
 * mock-only：模拟窗口尺寸变化。
 * @throws CuaError INVALID_ARGUMENT 当会话不是 mock 桌面。
 */
export function resizeMockWindow(
  session: CuaSession,
  appId: string,
  windowId: number,
  size: { width: number; height: number },
): void {
  if (!(session instanceof MockDesktopSession)) {
    throw new CuaError('INVALID_ARGUMENT', 'resizeMockWindow only works with the mock desktop session')
  }
  session.resizeWindow(appId, windowId, size)
}
