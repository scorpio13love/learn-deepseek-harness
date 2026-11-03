/**
 * s16 的环境配置。离线测试 / 离线 demo 不需要 key。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface DeepSeekConfig {
  apiKey: string
  baseUrl: string
  model: string
  maxTokens?: number
  timeoutMs?: number
}

/** 加载本课目录下的 .env（不存在则继续读进程环境变量）。 */
export function loadEnv(): void {
  const file = resolve(import.meta.dirname, '..', '.env')
  if (existsSync(file)) process.loadEnvFile(file)
}

function positiveInteger(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`)
  }
  return value
}

/** 读取配置；没有 key 时返回 undefined。 */
export function tryReadDeepSeekConfig(): DeepSeekConfig | undefined {
  loadEnv()
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (apiKey === undefined || apiKey.length === 0) return undefined
  return buildConfig(apiKey)
}

/** 读取并校验配置；缺少 key 时给出可直接照做的错误。 */
export function readDeepSeekConfig(): DeepSeekConfig {
  const config = tryReadDeepSeekConfig()
  if (config === undefined) {
    throw new Error(
      'DEEPSEEK_API_KEY is not set. Run `cp env.example .env` in this lesson and fill in your key.',
    )
  }
  return config
}

function buildConfig(apiKey: string): DeepSeekConfig {
  const baseUrl = process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com/anthropic'
  const model = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash'
  const maxTokens = positiveInteger('DEEPSEEK_MAX_TOKENS', process.env.DEEPSEEK_MAX_TOKENS)
  const timeoutMs = positiveInteger('DEEPSEEK_TIMEOUT_MS', process.env.DEEPSEEK_TIMEOUT_MS)
  return {
    apiKey,
    baseUrl,
    model,
    ...maxTokens === undefined ? {} : { maxTokens },
    ...timeoutMs === undefined ? {} : { timeoutMs },
  }
}
