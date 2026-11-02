/**
 * 把桌面观测投影成模型工具 `cua`。
 *
 * 本课只暴露观察类方法：
 *   getApp / getWindows / getState / screenshot
 *
 * 动作（click/type/press/scroll）在 s21。真实 DSH 的 `tools.cua` 是
 * `{ method, params }` 的判别联合；这里用同样的形状，便于后续扩展。
 */

import { CuaError } from './types.ts'
import type { CuaDesktopSession } from './types.ts'

export interface ToolContent {
  readonly type: 'text'
  readonly text: string
}

export interface ToolResult {
  readonly content: readonly ToolContent[]
  readonly isError: boolean
}

export interface CuaTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<ToolResult>
}

/** 模型可调用的方法集合。s21 会在这里加上动作方法。 */
export const CUA_METHODS = ['getApp', 'getWindows', 'getState', 'screenshot'] as const

export type CuaMethod = (typeof CUA_METHODS)[number]

function requireParams(args: Record<string, unknown>): Record<string, unknown> {
  const params = args.params
  if (params === undefined) return {}
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new CuaError('INVALID_ARGUMENT', '"params" must be an object')
  }
  return params as Record<string, unknown>
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new CuaError('INVALID_ARGUMENT', `"${key}" must be a non-empty string`)
  }
  return value
}

function optionalInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CuaError('INVALID_ARGUMENT', `"${key}" must be an integer when provided`)
  }
  return value
}

export function createCuaTool(session: CuaDesktopSession): CuaTool {
  return {
    name: 'cua',
    description:
      'Observe the desktop through an authorized application: list apps, windows, read the accessibility tree, or take a screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: [...CUA_METHODS] },
        params: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Application name, bundle id or appId (getApp).' },
            appId: { type: 'string', description: 'Application id returned by getApp.' },
            windowId: { type: 'integer', description: 'Window id; omitted selects the main window.' },
          },
          additionalProperties: false,
        },
      },
      required: ['method'],
      additionalProperties: false,
    },
    async execute(args) {
      const method = args.method
      if (typeof method !== 'string') {
        throw new CuaError('INVALID_ARGUMENT', '"method" must be a string')
      }
      const params = requireParams(args)

      switch (method) {
        case 'getApp': {
          const app = await session.getApp(requireString(params, 'selector'))
          return text(JSON.stringify(app, null, 2))
        }
        case 'getWindows': {
          const windows = await session.getWindows(requireString(params, 'appId'))
          return text(JSON.stringify(windows, null, 2))
        }
        case 'getState': {
          const state = await session.getState(requireString(params, 'appId'), optionalInteger(params, 'windowId'))
          return text(JSON.stringify(state, null, 2))
        }
        case 'screenshot': {
          const appId = requireString(params, 'appId')
          const windowId = optionalInteger(params, 'windowId')
          if (windowId === undefined) {
            throw new CuaError('INVALID_ARGUMENT', '"windowId" is required for screenshot')
          }
          const shot = await session.screenshot(appId, windowId)
          // 不把 base64 塞进文本：真实 DSH 把图像作为 attachment 交给多模态模型。
          return text(JSON.stringify({
            appId: shot.appId,
            windowId: shot.windowId,
            mimeType: shot.mimeType,
            width: shot.width,
            height: shot.height,
            byteLength: shot.bytes.byteLength,
            placeholder: shot.placeholder,
          }, null, 2))
        }
        default: {
          throw new CuaError('INVALID_ARGUMENT', `unknown cua method "${method}"`)
        }
      }
    },
  }
}

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }], isError: false }
}

/** 模型工具调用的最小运行时：错误收敛成 isError 结果。 */
export async function runCua(
  tool: CuaTool,
  call: { method: string; params?: Record<string, unknown> },
): Promise<ToolResult> {
  try {
    return await tool.execute({
      method: call.method,
      ...(call.params === undefined ? {} : { params: call.params }),
    })
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${formatError(error)}` }], isError: true }
  }
}

export function formatError(error: unknown): string {
  if (error instanceof CuaError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}
