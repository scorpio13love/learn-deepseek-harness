/**
 * s02 沿用 s01 的工具注册表：名字 → 声明 + 执行函数。
 *
 * 本课不改变工具执行语义，只要求工具结果以 `surfaceOp: 'append'`
 * 写进日志；解析参数、最小 required/type 校验和错误规范化保持不变。
 * s04 会把这里升级成 typed schema DSL；s05 会加上策略与并发。
 */

import type {
  ContentBlock,
  JsonObject,
  Message,
  ToolCallBlock,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolSchema,
} from './types.ts'
import { isAbortError } from './types.ts'

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: false }
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true }
}

function schemaTypeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validateValue(schema: JsonObject, value: unknown, path: string): string | undefined {
  const expected = schema.type
  if (typeof expected === 'string') {
    const actual = schemaTypeOf(value)
    const matches = expected === 'integer'
      ? actual === 'number' && Number.isInteger(value)
      : expected === 'number'
        ? actual === 'number'
        : expected === 'object'
          ? actual === 'object' && !Array.isArray(value) && value !== null
          : actual === expected
    if (!matches) return `${path} must be ${expected}, got ${actual}`
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => {
      return typeof branch === 'object' && branch !== null && !Array.isArray(branch)
        && validateValue(branch as JsonObject, value, path) === undefined
    })
    if (matches.length !== 1) {
      return `${path} must match exactly one oneOf branch, matched ${matches.length}`
    }
  }

  if (expected === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    const properties = schema.properties
    if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
      for (const [key, child] of Object.entries(properties)) {
        if (typeof child !== 'object' || child === null || Array.isArray(child)) continue
        if (!(key in object)) continue
        const error = validateValue(child as JsonObject, object[key], `${path}.${key}`)
        if (error !== undefined) return error
      }
    }
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in object)) {
          return `${path}.${key} is required`
        }
      }
    }
  }

  return undefined
}

function parseArguments(raw: string): unknown {
  if (raw.trim().length === 0) return {}
  return JSON.parse(raw)
}

export class ToolRegistry {
  #tools = new Map<string, ToolDefinition>()

  register(definition: ToolDefinition): () => void {
    if (this.#tools.has(definition.name)) {
      throw new Error(`tool "${definition.name}" is already registered`)
    }
    this.#tools.set(definition.name, definition)
    return () => {
      if (this.#tools.get(definition.name) === definition) {
        this.#tools.delete(definition.name)
      }
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name)
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()]
  }

  /** 模型可见的声明；只投影 name/description/parameters。 */
  schemas(): ToolSchema[] {
    return this.list().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }

  /** 执行一次调用；任何失败都规范化为 `isError` 结果，取消除外。 */
  async execute(call: ToolCallBlock, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.signal.aborted) throw ctx.signal.reason
    const tool = this.#tools.get(call.name)
    if (tool === undefined) {
      return errorResult(`unknown tool "${call.name}"`)
    }

    let args: unknown
    try {
      args = parseArguments(call.arguments)
    } catch {
      return errorResult(`invalid JSON arguments for tool "${call.name}"`)
    }

    const validationError = validateValue(tool.parameters, args, call.name)
    if (validationError !== undefined) {
      return errorResult(validationError)
    }

    try {
      const result = await tool.execute(args, ctx)
      if (ctx.signal.aborted) throw ctx.signal.reason
      return normalizeResult(result)
    } catch (error) {
      if (isAbortError(error) || ctx.signal.aborted) throw error
      return errorResult(error instanceof Error ? error.message : String(error))
    }
  }
}

function normalizeResult(result: ToolResult): ToolResult {
  const content: ContentBlock[] = result.content.length > 0
    ? result.content
    : [{ type: 'text', text: result.isError ? 'Error: tool returned no content' : '(no output)' }]
  return { content, isError: result.isError }
}

/** 便捷构造：从一个同步函数生成工具定义。 */
export function defineTool(input: {
  name: string
  description: string
  parameters: JsonObject
  run(args: unknown, ctx: ToolContext): Promise<ToolResult> | ToolResult
}): ToolDefinition {
  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    execute: (args, ctx) => input.run(args, ctx),
  }
}

/** 供 demo / 测试读取消息中的文本。 */
export function toolResultText(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}
