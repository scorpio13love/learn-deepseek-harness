/**
 * s04 的公共入口。
 *
 * 本课在 s03 的流式层上增加 typed tool schema、输出契约、
 * scoped 注册、步骤级条件和全局工具掩码。
 */

export * from './types.ts'
export * from './session.ts'
export * from './schema.ts'
export * from './tools.ts'
export * from './stream.ts'
export * from './agent.ts'
export * from './deepseek.ts'
export * from './env.ts'

import { DeepSeekModel } from './deepseek.ts'
import { readDeepSeekConfig } from './env.ts'

/** 从 .env / 进程环境创建真实 DeepSeek 模型。 */
export function createDeepSeekModel(): DeepSeekModel {
  return new DeepSeekModel(readDeepSeekConfig())
}
