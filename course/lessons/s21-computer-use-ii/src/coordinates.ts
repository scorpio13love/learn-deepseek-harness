/**
 * 坐标换算：截图像素 / 千分比 → 原生 point。
 *
 * 真实 DSH 的 `CuaCoordinates.parameters()` 做同样的事，并且：
 * - 绝对坐标必须在最近一次截图范围内；
 * - 相对坐标是 0-999 的整数千分比；
 * - 换算发生在上游调用之前，只做一次。
 *
 * 本文件是纯函数，不碰会话状态，方便单独测试边界。
 */

import { CuaError } from './types.ts'
import type { CuaPointTarget } from './types.ts'

/** 窗口几何：point 尺寸 + 截图缩放比。 */
export interface FrameGeometry {
  readonly width: number
  readonly height: number
  readonly scale: number
}

/** 最近一次截图的像素尺寸；没有截图时传 undefined。 */
export interface ScreenshotGeometry {
  readonly pixelWidth: number
  readonly pixelHeight: number
}

function requireFinite(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CuaError('INVALID_ARGUMENT', `"${name}" must be a finite number`)
  }
}

function requireRelative(value: number, axis: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 999) {
    throw new CuaError(
      'INVALID_ARGUMENT',
      `relative ${axis} must be an integer from 0 to 999, got ${String(value)}`,
    )
  }
}

function clampPoint(value: number, size: number): number {
  return Math.min(value, Math.max(0, size - 1))
}

/**
 * 把一个坐标目标换算成原生 point。
 *
 * @param target - 模型给出的相对/绝对坐标。
 * @param frame - 窗口 point 尺寸与截图缩放比。
 * @param screenshot - 最近一次截图；绝对坐标必需。
 * @returns 原生 point，已 clamp 到窗口内。
 */
export function toNativePoint(
  target: CuaPointTarget,
  frame: FrameGeometry,
  screenshot: ScreenshotGeometry | undefined,
): { x: number; y: number } {
  requireFinite(target.x, 'x')
  requireFinite(target.y, 'y')
  if (frame.width <= 0 || frame.height <= 0) {
    throw new CuaError('INVALID_ARGUMENT', 'window has no usable geometry')
  }

  if (target.relative === true) {
    requireRelative(target.x, 'x')
    requireRelative(target.y, 'y')
    return {
      x: Math.round(clampPoint((target.x / 1000) * frame.width, frame.width)),
      y: Math.round(clampPoint((target.y / 1000) * frame.height, frame.height)),
    }
  }

  if (screenshot === undefined) {
    throw new CuaError('SCREENSHOT_REQUIRED', 'take a fresh screenshot before using absolute pixel coordinates')
  }
  const { pixelWidth, pixelHeight } = screenshot
  if (pixelWidth <= 0 || pixelHeight <= 0 || frame.scale <= 0) {
    throw new CuaError('INVALID_ARGUMENT', 'screenshot has no usable dimensions')
  }
  if (target.x < 0 || target.y < 0 || target.x >= pixelWidth || target.y >= pixelHeight) {
    throw new CuaError(
      'INVALID_ARGUMENT',
      `coordinate (${target.x}, ${target.y}) is outside the latest screenshot ${pixelWidth}x${pixelHeight}`,
    )
  }
  return {
    x: target.x / frame.scale,
    y: target.y / frame.scale,
  }
}
