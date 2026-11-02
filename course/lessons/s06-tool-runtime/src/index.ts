/**
 * s05 的公共入口。
 *
 * 本课在 s04 的工具契约上增加调用流水线、审批、单调守卫、
 * 并发批次、超时和失败步骤的工具结果恢复。
 */

export * from './types.ts'
export * from './session.ts'
export * from './schema.ts'
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
