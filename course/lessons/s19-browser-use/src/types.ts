/**
 * s19 · browser-use 的公开契约。
 *
 * 这一层刻意与具体浏览器后端无关：Playwright、Chrome DevTools、Stagehand
 * 都只需要实现 `BrowserProvider`，模型工具只依赖 `BrowserSession`。
 */

/** 本课用到的错误码；真实 DSH 里由各 provider 自己的错误类型承载。 */
export type BrowserErrorCode =
  | 'PROVIDER_ALREADY_REGISTERED'
  | 'PROVIDER_NOT_REGISTERED'
  | 'SESSION_CLOSED'
  | 'PAGE_NOT_FOUND'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_DISABLED'
  | 'INVALID_ARGUMENT'

/** 带稳定错误码的浏览器错误；工具层把它转成模型可见的 `Error: ...`。 */
export class BrowserError extends Error {
  readonly code: BrowserErrorCode

  constructor(code: BrowserErrorCode, message: string) {
    super(message)
    this.name = 'BrowserError'
    this.code = code
  }
}

/** 页面上可被模型引用的一个元素；`ref` 只在当前快照内有效。 */
export interface BrowserElement {
  /** 形如 `e1` 的引用，模型点击时回传。 */
  readonly ref: string
  /** ARIA role，例如 `link` / `button` / `textbox`。 */
  readonly role: string
  /** 可读名字，空格归一化。 */
  readonly name: string
  /** 原始标签名，便于排查。 */
  readonly tag: string
  /** 链接目标；非链接没有该字段。 */
  readonly href?: string
  /** 是否被禁用；禁用元素不可点击。 */
  readonly disabled?: boolean
}

/** 一次 DOM/文本读取的结果，也是所有浏览器操作返回的统一观测。 */
export interface BrowserPageSnapshot {
  readonly url: string
  readonly title: string
  /** 页面正文（mock 里是固定文本）。 */
  readonly text: string
  /** 当前快照里的元素引用表。 */
  readonly elements: readonly BrowserElement[]
  /** 捕获时间（毫秒时间戳）。 */
  readonly capturedAt: number
  /** 刚执行过的动作，便于模型确认；未执行动作时省略。 */
  readonly lastAction?: string
}

/** 截图占位结果。mock 返回 1×1 PNG 字节 + 声明的视口尺寸，不是真实画面。 */
export interface BrowserScreenshot {
  readonly mimeType: 'image/png'
  readonly width: number
  readonly height: number
  readonly bytes: Uint8Array
  /** mock provider 恒为 true：提醒读者这不能当作真实像素。 */
  readonly placeholder: boolean
}

/** 一个实时浏览器会话：跨轮次复用，关闭后所有操作都失败。 */
export interface BrowserSession {
  readonly id: string
  readonly closed: boolean
  /** 打开 URL，返回新页面快照。 */
  navigate(url: string): Promise<BrowserPageSnapshot>
  /** 读取当前页面；可选的 selector 只用于限制读取区域。 */
  read(options?: { selector?: string }): Promise<BrowserPageSnapshot>
  /** 点击快照中的元素引用。 */
  click(ref: string): Promise<BrowserPageSnapshot>
  /** 截图占位。 */
  screenshot(): Promise<BrowserScreenshot>
  /** 幂等关闭；关闭后释放会话资源。 */
  close(): Promise<void>
}

/** 浏览器后端（Playwright / Chrome DevTools / Stagehand / mock）。 */
export interface BrowserProvider {
  /** 注册时使用的唯一名字，例如 `playwright`。 */
  readonly name: string
  /** 打开一个会话；真实 provider 在这里连接浏览器或 MCP server。 */
  open(options?: { sessionId?: string }): Promise<BrowserSession>
}
