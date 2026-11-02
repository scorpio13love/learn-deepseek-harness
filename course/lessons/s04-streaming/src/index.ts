/**
 * s03 的公共入口。
 *
 * 本课在 s02 的日志/surface 上增加流式层：StreamAssembler、
 * AssistantStreamAttempt、持久 stream 记录和 live 帧。
 */

export * from './types.ts'
export * from './session.ts'
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
