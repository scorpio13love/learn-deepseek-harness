/**
 * Redaction：按 key 和按值，两套规则同时生效。
 * 输出只包含 JSON 值；循环引用、深度、危险 key 都有边界。
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

const SENSITIVE_KEYS = new Set([
  'apikey',
  'xapikey',
  'authorization',
  'accesstoken',
  'refreshtoken',
  'token',
  'secret',
  'clientsecret',
  'password',
  'passwd',
  'cookie',
  'setcookie',
  'privatekey',
  'credential',
  'credentials',
  'sessionid',
])

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const REDACTED = '[REDACTED]'

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key))
}

export function redactText(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-[REDACTED]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}\b/g, '$1 [REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, 'ghp_[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_[REDACTED]')
}

export interface RedactOptions {
  maxDepth?: number
  /** 单个数组最多保留多少项；超出部分用字符串标记。 */
  maxItems?: number
}

export function redactValue(value: unknown, options: RedactOptions = {}): JsonValue {
  const maxDepth = options.maxDepth ?? 8
  const maxItems = options.maxItems ?? 1_000
  const seen = new WeakSet<object>()

  const walk = (input: unknown, depth: number): JsonValue => {
    if (input === null || input === undefined) return null
    if (typeof input === 'string') return redactText(input)
    if (typeof input === 'number') return Number.isFinite(input) ? input : String(input)
    if (typeof input === 'boolean') return input
    if (typeof input === 'bigint') return `${input.toString()}n`
    if (typeof input === 'function') return '[Function]'
    if (typeof input === 'symbol') return input.toString()
    if (typeof input !== 'object') return String(input)

    if (depth >= maxDepth) return '[MAX_DEPTH]'
    if (seen.has(input)) return '[CIRCULAR]'
    seen.add(input)

    if (Array.isArray(input)) {
      const items = input.slice(0, maxItems).map(item => walk(item, depth + 1))
      if (input.length > maxItems) items.push(`[${input.length - maxItems} more items]`)
      return items
    }

    const output: JsonObject = {}
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(key)) continue
      output[key] = isSensitiveKey(key) ? REDACTED : walk(item, depth + 1)
    }
    return output
  }

  return walk(value, 0)
}

export function redactError(error: unknown): JsonObject {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactText(error.message),
      code: typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : null,
      stack: error.stack === undefined ? null : redactText(error.stack),
    }
  }
  return { name: 'Error', message: redactText(String(error)), code: null, stack: null }
}

export function stringifyRedacted(value: unknown, space = 0): string {
  return JSON.stringify(redactValue(value), null, space)
}

export { REDACTED }
