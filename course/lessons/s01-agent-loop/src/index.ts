/**
 * s01 的公共入口。
 *
 * 这一课的全部代码都在本文件夹内，后续课程会复制一份并增量修改，
 * 因此每课都可以独立运行、独立阅读。
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
