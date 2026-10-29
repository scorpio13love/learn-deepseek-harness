/**
 * s07 的公共入口。
 *
 * 本课在 s06 的提示词/工具层上增加 inbox：next-turn / next-step、
 * followup / steer / inject、claim 和取消保留。
 */

export * from './types.ts'
export * from './session.ts'
export * from './schema.ts'
export * from './inbox.ts'
export * from './prompt.ts'
export * from './pipeline.ts'
export * from './batch.ts'
export * from './recovery.ts'
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
