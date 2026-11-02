/**
 * `cua` 工具（s21）：观察 + 动作。
 *
 * 工具只做参数整形与错误收敛；授权、坐标换算、快照失效全部在会话里。
 * 这样换 provider 时，工具层不需要知道「窗口是不是变了」这类平台细节。
 */

import { CuaError } from './types.ts'
import type { CuaPointTarget, CuaSession, CuaTarget } from './types.ts'

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

export const CUA_METHODS = [
  'getApp',
  'getWindows',
  'getState',
  'screenshot',
  'click',
  'type',
  'press',
  'scroll',
] as const

export type CuaMethod = (typeof CUA_METHODS)[number]

function paramsOf(args: Record<string, unknown>): Record<string, unknown> {
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

function requireInteger(params: Record<string, unknown>, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CuaError('INVALID_ARGUMENT', `"${key}" must be an integer`)
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

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new CuaError('INVALID_ARGUMENT', `"${key}" must be a boolean when provided`)
  }
  return value
}

/** 解析 click/scroll 的目标：元素下标优先，否则按坐标。 */
function targetOf(params: Record<string, unknown>): { target: CuaTarget; point?: CuaPointTarget } {
  const elementIndex = optionalInteger(params, 'elementIndex')
  if (elementIndex !== undefined) {
    const snapshotId = requireString(params, 'snapshotId')
    return { target: { kind: 'element', snapshotId, elementIndex } }
  }
  if (params.x === undefined && params.y === undefined) {
    throw new CuaError(
      'INVALID_ARGUMENT',
      'target requires either elementIndex + snapshotId, or x + y coordinates',
    )
  }
  if (typeof params.x !== 'number' || typeof params.y !== 'number') {
    throw new CuaError('INVALID_ARGUMENT', 'both "x" and "y" are required for coordinate targets')
  }
  const relative = optionalBoolean(params, 'relative')
  const target: CuaPointTarget = {
    kind: 'point',
    x: params.x,
    y: params.y,
    ...(relative === undefined ? {} : { relative }),
  }
  return { target, point: target }
}

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }], isError: false }
}

export function createCuaTool(session: CuaSession): CuaTool {
  return {
    name: 'cua',
    description:
      'Observe and control an authorized desktop application. Actions report "dispatched", never "verified"; ' +
      'input cannot be undone, so read fresh state before and after every action.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: [...CUA_METHODS] },
        params: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Application name, bundle id or appId (getApp).' },
            appId: { type: 'string' },
            windowId: { type: 'integer' },
            snapshotId: { type: 'string', description: 'snapshotId from the latest getState.' },
            elementIndex: { type: 'integer', description: 'AX element index from that snapshot.' },
            x: { type: 'number', description: 'Screenshot pixel, or 0-999 when relative.' },
            y: { type: 'number', description: 'Screenshot pixel, or 0-999 when relative.' },
            relative: { type: 'boolean', description: 'Use thousandths (0-999) of the window size.' },
            text: { type: 'string', description: 'Text to type (type).' },
            key: { type: 'string', description: 'Key to press, for example "Return" (press).' },
            modifiers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Modifiers such as command, shift, option (press).',
            },
            deltaLinesX: { type: 'integer', minimum: -10, maximum: 10 },
            deltaLinesY: { type: 'integer', minimum: -10, maximum: 10 },
          },
          additionalProperties: false,
        },
      },
      required: ['method'],
      additionalProperties: false,
    },
    async execute(args) {
      const method = args.method
      if (typeof method !== 'string') throw new CuaError('INVALID_ARGUMENT', '"method" must be a string')
      const params = paramsOf(args)

      switch (method) {
        case 'getApp':
          return text(JSON.stringify(await session.getApp(requireString(params, 'selector')), null, 2))

        case 'getWindows':
          return text(JSON.stringify(await session.getWindows(requireString(params, 'appId')), null, 2))

        case 'getState':
          return text(JSON.stringify(
            await session.getState(requireString(params, 'appId'), optionalInteger(params, 'windowId')),
            null,
            2,
          ))

        case 'screenshot': {
          const windowId = optionalInteger(params, 'windowId')
          if (windowId === undefined) throw new CuaError('INVALID_ARGUMENT', '"windowId" is required for screenshot')
          const shot = await session.screenshot(requireString(params, 'appId'), windowId)
          return text(JSON.stringify({
            appId: shot.appId,
            windowId: shot.windowId,
            mimeType: shot.mimeType,
            width: shot.width,
            height: shot.height,
            pixelWidth: shot.pixelWidth,
            pixelHeight: shot.pixelHeight,
            scale: shot.scale,
            byteLength: shot.bytes.byteLength,
            placeholder: shot.placeholder,
          }, null, 2))
        }

        case 'click': {
          const appId = requireString(params, 'appId')
          const windowId = requireInteger(params, 'windowId')
          const { target } = targetOf(params)
          return text(JSON.stringify(await session.click({ appId, windowId, target }), null, 2))
        }

        case 'type': {
          const appId = requireString(params, 'appId')
          const windowId = requireInteger(params, 'windowId')
          const value = requireString(params, 'text')
          return text(JSON.stringify(await session.type({ appId, windowId, text: value }), null, 2))
        }

        case 'press': {
          const appId = requireString(params, 'appId')
          const windowId = requireInteger(params, 'windowId')
          const key = requireString(params, 'key')
          const modifiers = params.modifiers
          if (modifiers !== undefined) {
            if (!Array.isArray(modifiers) || modifiers.some(modifier => typeof modifier !== 'string')) {
              throw new CuaError('INVALID_ARGUMENT', '"modifiers" must be an array of strings')
            }
          }
          return text(JSON.stringify(
            await session.press({
              appId,
              windowId,
              key,
              ...(modifiers === undefined ? {} : { modifiers: modifiers as string[] }),
            }),
            null,
            2,
          ))
        }

        case 'scroll': {
          const appId = requireString(params, 'appId')
          const windowId = requireInteger(params, 'windowId')
          const { point } = targetOf(params)
          if (point === undefined) throw new CuaError('INVALID_ARGUMENT', 'scroll requires a coordinate target')
          return text(JSON.stringify(
            await session.scroll({
              appId,
              windowId,
              target: point,
              deltaLinesX: requireInteger(params, 'deltaLinesX'),
              deltaLinesY: requireInteger(params, 'deltaLinesY'),
            }),
            null,
            2,
          ))
        }

        default:
          throw new CuaError('INVALID_ARGUMENT', `unknown cua method "${method}"`)
      }
    },
  }
}

/** 工具调用运行时：把错误收敛成 `isError` 结果。 */
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
