/**
 * s14 · subagents / presets：沿用前序课程的实现（本课改动见 README）。
 */

export * from './types.ts'
export * from './session.ts'
export * from './schema.ts'
export * from './subagent.ts'
export * from './capabilities.ts'
export * from './kernel.ts'
export * from './boot.ts'
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
