/**
 * s10 的公共入口。
 *
 * 本课在 s09 的持久化之上增加上下文压缩：token 估算、工具结果裁剪、
 * 摘要、surface replace、overflow 恢复。
 */

export * from './types.ts'
export * from './session.ts'
export * from './schema.ts'
export * from './compaction.ts'
export * from './storage.ts'
export * from './llm.ts'
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

import { DeepSeekModel, DeepSeekProvider } from './deepseek.ts'
import { readDeepSeekConfig } from './env.ts'

/** 从 .env / 进程环境创建真实 DeepSeek 模型。 */
export function createDeepSeekModel(): DeepSeekModel {
  return new DeepSeekModel(readDeepSeekConfig())
}

/** 从 .env / 进程环境创建 DeepSeek provider。 */
export function createDeepSeekProvider(): DeepSeekProvider {
  return new DeepSeekProvider(readDeepSeekConfig())
}
