/**
 * s18 的最小工具注册表。
 *
 * 本课只需要一个模型可见工具 `load_skill(name)`，但保留与真实 DSH 相同的形状：
 * 工具声明 name/description/JSON Schema，执行结果规范化为 `ToolResult`，
 * 未知工具、非法 JSON、工具异常都变成模型可见的 error 结果。
 */

export type JsonObject = Record<string, unknown>

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolResult {
  content: TextBlock[]
  isError: boolean
}

export interface ToolContext {
  readonly signal: AbortSignal
  readonly callId: string
  readonly sessionId?: string
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: JsonObject
  run(args: unknown, ctx: ToolContext): ToolResult | Promise<ToolResult>
}

/** 模型发起的一次调用；arguments 仍是原始 JSON 字符串。 */
export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ToolSchema {
  name: string
  description: string
  parameters: JsonObject
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: false }
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true }
}

export function toolResultText(result: ToolResult): string {
  return result.content.map(block => block.text).join('')
}

export function defineTool(input: {
  name: string
  description: string
  parameters: JsonObject
  run(args: unknown, ctx: ToolContext): ToolResult | Promise<ToolResult>
}): ToolDefinition {
  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    run: input.run,
  }
}

function missingRequired(schema: JsonObject, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return 'arguments must be a JSON object'
  }
  const required = schema.required
  if (!Array.isArray(required)) return undefined
  const object = args as Record<string, unknown>
  for (const key of required) {
    if (typeof key === 'string' && !(key in object)) return `"${key}" is required`
  }
  return undefined
}

export class ToolRegistry {
  #tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): () => void {
    if (this.#tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`)
    this.#tools.set(tool.name, tool)
    return () => {
      if (this.#tools.get(tool.name) === tool) this.#tools.delete(tool.name)
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name)
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()]
  }

  /** 模型可见的工具声明。 */
  schemas(): ToolSchema[] {
    return this.list().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    if (ctx.signal.aborted) throw ctx.signal.reason
    const tool = this.#tools.get(call.name)
    if (tool === undefined) return errorResult(`unknown tool "${call.name}"`)

    let args: unknown
    try {
      args = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments)
    } catch {
      return errorResult(`invalid JSON arguments for tool "${call.name}"`)
    }

    const missing = missingRequired(tool.parameters, args)
    if (missing !== undefined) return errorResult(missing)

    try {
      return await tool.run(args, ctx)
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }
  }
}
