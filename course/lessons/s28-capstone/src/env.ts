/** 零依赖 .env 读取与配置解析。 */

import { readFile } from 'node:fs/promises'

export interface CapstoneConfig {
  apiKey?: string
  baseUrl: string
  model: string
  maxTokens: number
  timeoutMs: number
}

export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

/** 读取 .env，但不覆盖已经存在的 process.env。 */
export async function loadEnvFile(path = '.env'): Promise<boolean> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (process.env[key] === undefined) process.env[key] = value
  }
  return true
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): CapstoneConfig {
  return {
    ...env.DEEPSEEK_API_KEY === undefined ? {} : { apiKey: env.DEEPSEEK_API_KEY },
    baseUrl: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic',
    model: env.DEEPSEEK_MODEL ?? 'deepseek-flash',
    maxTokens: positiveInt(env.DEEPSEEK_MAX_TOKENS, 4_096),
    timeoutMs: positiveInt(env.DEEPSEEK_TIMEOUT_MS, 120_000),
  }
}
