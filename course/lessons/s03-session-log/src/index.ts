/**
 * s02 的公共入口。
 *
 * 本课从 s01 复制而来，增加了事件信封、surface append/replace、
 * request/header/context 和重放校验；全部代码都在本文件夹内。
 */

export * from './types.ts'
export * from './session.ts'
export * from './tools.ts'
export * from './agent.ts'
export * from './deepseek.ts'
export * from './env.ts'

import { DeepSeekModel } from './deepseek.ts'
import { readDeepSeekConfig } from './env.ts'

/** 从 .env / 进程环境创建真实 DeepSeek 模型。 */
export function createDeepSeekModel(): DeepSeekModel {
  return new DeepSeekModel(readDeepSeekConfig())
}
