/**
 * s06 的公共入口。
 *
 * 本课在 s05 的工具执行之上增加系统提示词组装：sections、variables、
 * contexts、toolOrder、waterfall，以及 surface head 的准入/替换。
 */

export * from './types.ts'
export * from './session.ts'
export * from './schema.ts'
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
