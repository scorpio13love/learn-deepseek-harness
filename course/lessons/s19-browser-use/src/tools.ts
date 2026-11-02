/**
 * 把 browser 操作投影成模型工具。
 *
 * 只有三个工具（navigate / read / click），但它们覆盖了 provider 的完整闭环：
 * 观测 → 决策 → 动作 → 再观测。工具不直接 import 任何 provider 实现，
 * 只持有 `BrowserSession`，所以换成真实浏览器时工具代码不变。
 */

import { BrowserError } from './types.ts'
import type { BrowserPageSnapshot, BrowserSession } from './types.ts'

/** 模型可见的工具结果内容。 */
export interface ToolContent {
  readonly type: 'text'
  readonly text: string
}

/** 工具执行结果；错误以 `isError: true` 返回给模型，而不是抛给 loop。 */
export interface ToolResult {
  readonly content: readonly ToolContent[]
  readonly isError: boolean
}

/** 本课的工具定义；真实 DSH 里由 `defineTool` + schema 承担。 */
export interface BrowserTool {
  readonly name: string
  readonly description: string
  /** 简化版 JSON Schema，直接投影给模型。 */
  readonly inputSchema: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<ToolResult>
}

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }], isError: false }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new BrowserError('INVALID_ARGUMENT', `"${key}" must be a non-empty string`)
  }
  return value
}

/** 渲染快照：先给页眉，再逐行列出 ref 表。模型点击时使用这里的 ref。 */
export function renderSnapshot(snapshot: BrowserPageSnapshot): string {
  const lines = [
    `url: ${snapshot.url}`,
    `title: ${snapshot.title}`,
    `text: ${snapshot.text}`,
    snapshot.lastAction === undefined ? '' : `lastAction: ${snapshot.lastAction}`,
    'elements:',
    ...snapshot.elements.map(element => {
      const target = element.href === undefined ? '' : ` -> ${element.href}`
      const disabled = element.disabled === true ? ' (disabled)' : ''
      return `  [${element.ref}] ${element.role} "${element.name}"${target}${disabled}`
    }),
  ]
  return lines.filter(line => line !== '').join('\n')
}

/**
 * 为某个会话创建工具集。
 * 会话关闭后，所有工具都会返回 `SESSION_CLOSED` 错误 —— 这正是真实 provider
 * 关闭时「先停止接收工具调用」的简化版。
 */
export function createBrowserTools(session: BrowserSession): readonly BrowserTool[] {
  const navigate: BrowserTool = {
    name: 'browser_navigate',
    description: 'Open an absolute URL in the browser session and return the page snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to open.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(args) {
      const url = requireString(args, 'url')
      return text(renderSnapshot(await session.navigate(url)))
    },
  }

  const read: BrowserTool = {
    name: 'browser_read',
    description: 'Read the current page: URL, title, text and the element reference table.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'Optional region selector; mock supports body, main and #content.',
        },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const selector = args.selector
      if (selector !== undefined && typeof selector !== 'string') {
        throw new BrowserError('INVALID_ARGUMENT', '"selector" must be a string when provided')
      }
      return text(renderSnapshot(await session.read(selector === undefined ? undefined : { selector })))
    },
  }

  const click: BrowserTool = {
    name: 'browser_click',
    description: 'Click an element reference from the latest snapshot (for example "e1").',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element reference from the latest browser_read.' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    async execute(args) {
      const ref = requireString(args, 'ref')
      return text(renderSnapshot(await session.click(ref)))
    },
  }

  return [navigate, read, click]
}

/** 工具运行时的最小版本：找不到工具、参数错误、provider 错误都变成模型可见结果。 */
export async function runTool(
  tools: readonly BrowserTool[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) {
    return { content: [{ type: 'text', text: `Error: TOOL_UNKNOWN: no tool named "${name}"` }], isError: true }
  }
  try {
    return await tool.execute(args)
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${formatError(error)}` }], isError: true }
  }
}

/** 把错误渲染成稳定的 `CODE: message`，模型和测试都能匹配。 */
export function formatError(error: unknown): string {
  if (error instanceof BrowserError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}
