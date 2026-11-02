/** s16 的公共入口。本课零运行时依赖，所有代码都在本目录内。 */

export * from './tools.ts'
export * from './ptc.ts'
export * from './env.ts'
export * from './deepseek.ts'

import { DeepSeekClient } from './deepseek.ts'
import { readDeepSeekConfig, tryReadDeepSeekConfig } from './env.ts'

/** 有 key 时返回真实客户端，否则返回 undefined（用于离线 demo）。 */
export function tryCreateDeepSeekClient(): DeepSeekClient | undefined {
  const config = tryReadDeepSeekConfig()
  return config === undefined ? undefined : new DeepSeekClient(config)
}

/** 没有 key 时抛出可直接照做的错误。 */
export function createDeepSeekClient(): DeepSeekClient {
  return new DeepSeekClient(readDeepSeekConfig())
}
