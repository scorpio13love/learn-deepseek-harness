/**
 * 离线 mock 浏览器：一个内存中的小站点。
 *
 * 它不是 Playwright 的替身，而是把「浏览器 provider 的职责边界」显式化：
 * 打开页面、读 DOM/文本、点击、截图、关闭。换成真实 provider 时，
 * 只需要让 `open()` 返回一个实现 `BrowserSession` 的对象。
 */

import { BrowserError } from './types.ts'
import type { BrowserElement, BrowserPageSnapshot, BrowserProvider, BrowserSession, BrowserScreenshot } from './types.ts'

/** 页面定义：文本 + 可交互元素。 */
export interface MockPage {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly elements: readonly MockElement[]
}

/** mock 元素定义；`navigateTo` 模拟链接跳转。 */
export interface MockElement {
  readonly role: string
  readonly name: string
  readonly tag: string
  readonly href?: string
  readonly disabled?: boolean
}

/** 1×1 透明 PNG，仅用于证明「截图结果是 bytes + mime + 尺寸」。 */
const PLACEHOLDER_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** 允许 read(selector) 限制的区域；超出范围会报 ELEMENT_NOT_FOUND。 */
const READABLE_REGIONS = new Set(['body', 'main', '#content'])

/** 默认 mock 站点。所有 URL 都是 `https://mock.example/...`，不会发网络请求。 */
export const DEFAULT_MOCK_PAGES: readonly MockPage[] = [
  {
    url: 'https://mock.example/',
    title: 'Mock Shop',
    text: 'Welcome to the offline mock shop. Use the links below to browse.',
    elements: [
      { role: 'link', name: 'Products', tag: 'a', href: 'https://mock.example/products' },
      { role: 'link', name: 'About', tag: 'a', href: 'https://mock.example/about' },
      { role: 'button', name: 'Search', tag: 'button' },
      { role: 'textbox', name: 'Query', tag: 'input' },
      { role: 'button', name: 'Disabled promo', tag: 'button', disabled: true },
    ],
  },
  {
    url: 'https://mock.example/products',
    title: 'Products — Mock Shop',
    text: 'Two widgets in stock: the standard widget and the deluxe widget.',
    elements: [
      { role: 'link', name: 'Back home', tag: 'a', href: 'https://mock.example/' },
      { role: 'button', name: 'Add to cart', tag: 'button' },
      { role: 'text', name: '#1 Widget — $19', tag: 'span' },
    ],
  },
  {
    url: 'https://mock.example/about',
    title: 'About — Mock Shop',
    text: 'This site exists only inside the lesson tests. Nothing is fetched from the network.',
    elements: [{ role: 'link', name: 'Back home', tag: 'a', href: 'https://mock.example/' }],
  },
]

/** 归一化 URL：去掉 fragment，补全末尾斜杠规则。 */
function normalizeUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new BrowserError('INVALID_ARGUMENT', `not an absolute URL: ${input}`)
  }
  url.hash = ''
  return url.toString()
}

class MockBrowserSession implements BrowserSession {
  readonly id: string
  private readonly pages: Map<string, MockPage>
  private readonly viewport: { readonly width: number; readonly height: number }
  private page: MockPage
  private isClosed = false
  /** 已分派的动作日志；真实 provider 对应浏览器侧的执行记录。 */
  readonly actions: string[] = []

  constructor(
    id: string,
    pages: Map<string, MockPage>,
    viewport: { width: number; height: number },
  ) {
    this.id = id
    this.pages = pages
    this.viewport = viewport
    const first = pages.get('https://mock.example/')
    if (first === undefined) throw new BrowserError('INVALID_ARGUMENT', 'mock site needs a home page')
    this.page = first
  }

  get closed(): boolean {
    return this.isClosed
  }

  async navigate(url: string): Promise<BrowserPageSnapshot> {
    this.assertOpen()
    const normalized = normalizeUrl(url)
    const page = this.pages.get(normalized)
    if (page === undefined) {
      throw new BrowserError('PAGE_NOT_FOUND', `mock site has no page at ${normalized}`)
    }
    this.page = page
    this.actions.push(`navigate ${normalized}`)
    return this.snapshot()
  }

  async read(options?: { selector?: string }): Promise<BrowserPageSnapshot> {
    this.assertOpen()
    if (options?.selector !== undefined && !READABLE_REGIONS.has(options.selector)) {
      throw new BrowserError('ELEMENT_NOT_FOUND', `no readable region matches selector "${options.selector}"`)
    }
    this.actions.push('read')
    return this.snapshot(options?.selector === undefined ? undefined : `read ${options.selector}`)
  }

  async click(ref: string): Promise<BrowserPageSnapshot> {
    this.assertOpen()
    const elements = this.elements()
    const index = elements.findIndex(element => element.ref === ref)
    if (index < 0) throw new BrowserError('ELEMENT_NOT_FOUND', `no element with ref "${ref}" in the current snapshot`)
    const element = elements[index] as BrowserElement
    if (element.disabled === true) {
      throw new BrowserError('ELEMENT_DISABLED', `element ${ref} ("${element.name}") is disabled`)
    }
    this.actions.push(`click ${ref} ${element.name}`)
    if (element.href !== undefined) {
      this.page = this.pages.get(element.href) ?? this.page
      return this.snapshot(`click ${ref} → ${this.page.url}`)
    }
    return this.snapshot(`click ${ref} (${element.name})`)
  }

  async screenshot(): Promise<BrowserScreenshot> {
    this.assertOpen()
    this.actions.push('screenshot')
    return {
      mimeType: 'image/png',
      width: this.viewport.width,
      height: this.viewport.height,
      bytes: Uint8Array.from(Buffer.from(PLACEHOLDER_PNG, 'base64')),
      placeholder: true,
    }
  }

  async close(): Promise<void> {
    this.isClosed = true
  }

  private elements(): BrowserElement[] {
    return this.page.elements.map((element, index) => ({
      ref: `e${index + 1}`,
      role: element.role,
      name: element.name,
      tag: element.tag,
      ...(element.href === undefined ? {} : { href: element.href }),
      ...(element.disabled === undefined ? {} : { disabled: element.disabled }),
    }))
  }

  private snapshot(lastAction?: string): BrowserPageSnapshot {
    return {
      url: this.page.url,
      title: this.page.title,
      text: this.page.text,
      elements: this.elements(),
      capturedAt: Date.now(),
      ...(lastAction === undefined ? {} : { lastAction }),
    }
  }

  private assertOpen(): void {
    if (this.isClosed) throw new BrowserError('SESSION_CLOSED', `browser session "${this.id}" is closed`)
  }
}

export interface MockBrowserProviderOptions {
  /** 自定义站点；URL 必须包含首页 `https://mock.example/`。 */
  readonly pages?: readonly MockPage[]
  /** 截图声明的视口尺寸。 */
  readonly viewport?: { readonly width: number; readonly height: number }
}

/** 创建 mock provider；每次 open() 得到一个全新会话（互不共享状态）。 */
export function createMockBrowserProvider(options: MockBrowserProviderOptions = {}): BrowserProvider {
  const pageList = options.pages ?? DEFAULT_MOCK_PAGES
  const pages = new Map(pageList.map(page => [normalizeUrl(page.url), page]))
  const viewport = options.viewport ?? { width: 1280, height: 720 }
  let nextId = 1

  return {
    name: 'mock',
    async open(openOptions?: { sessionId?: string }): Promise<BrowserSession> {
      const id = openOptions?.sessionId ?? `mock-session-${nextId++}`
      return new MockBrowserSession(id, pages, viewport)
    },
  }
}

/** 便于测试断言「动作确实到达了浏览器侧」。 */
export function sessionActions(session: BrowserSession): readonly string[] {
  return session instanceof MockBrowserSession ? session.actions : []
}
