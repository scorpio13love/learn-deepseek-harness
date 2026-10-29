/**
 * s13 · capability seams：沿用前序课程的实现（本课改动见 README）。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface DeepSeekEnvConfig {
  apiKey: string
  baseUrl: string
  model: string
  maxTokens?: number
  timeoutMs?: number
}

/** 加载本课目录下的 .env（不存在则忽略，继续读进程环境变量）。 */
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

/** 读取并校验环境变量；缺少 API key 时给出可直接照做的错误。 */
export function readDeepSeekConfig(): DeepSeekEnvConfig {
  loadEnv()
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      'DEEPSEEK_API_KEY is not set. Run `cp env.example .env` in this lesson and fill in your key.',
    )
  }
  const baseUrl = process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com'
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
