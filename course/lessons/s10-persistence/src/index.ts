/**
 * s09 的公共入口。
 *
 * 本课在 s08 的 provider seam 上增加 JSONL 持久化：create/open/flush、
 * 崩溃尾部截断、未闭合 turn 修复、fork 前缀。
 */

export * from './types.ts'
export * from './session.ts'
export * from './schema.ts'
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
