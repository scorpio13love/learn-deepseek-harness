/**
 * s04 的工具注册表：scoped 注册、步骤级条件、全局掩码、解析后的 ToolSet。
 *
 * 与 s03 的差别：
 * - 工具参数/输出通过 schema.ts 的 DSL 编译与校验；
 * - 注册支持 `scope` 与 `when`；
 * - `resolve()` 产生一个步骤级 `ResolvedToolSet`，prompt 与执行共用同一份视图；
 * - `execute()` 只返回规范值，渲染交给 `output.render`。
 *
 * 真实实现见 `packages/core/tools/src/index.ts` 与 `pipeline.ts`（s05）。
 */

import type {
  ContentBlock,
  JsonObject,
  JsonValue,
  ResolvedToolSet,
  ToolActivationContext,
  ToolCallBlock,
  ToolContext,
  ToolDefinition,
  ToolRegistrationOptions,
  ToolRestriction,
  ToolResult,
  ToolSchema,
} from './types.ts'
import { assertJsonValue, isAbortError } from './types.ts'

export class ToolActivationError extends Error {
  readonly code = 'TOOL_ACTIVATION_FAILED'

  constructor(toolName: string, cause: unknown) {
    super(`cannot resolve availability of tool "${toolName}"`, { cause })
    this.name = 'ToolActivationError'
  }
}

export function textResult(text: string, meta?: JsonValue): ToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: false,
    ...meta === undefined ? {} : { meta },
  }
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true }
}

function normalizeContent(content: ContentBlock[], isError: boolean): ContentBlock[] {
  if (content.length > 0) return content
  return [{ type: 'text', text: isError ? 'Error: tool returned no content' : '(no output)' }]
}

function parseArguments(raw: string): unknown {
  if (raw.trim().length === 0) return {}
  return JSON.parse(raw)
}

interface Entry {
  definition: ToolDefinition
  scope: string | undefined
  when: ToolRegistrationOptions['when']
}

class ResolvedToolSetImpl implements ResolvedToolSet {
  #definitions: Map<string, ToolDefinition>
  #disposed = false

  constructor(definitions: Map<string, ToolDefinition>) {
    this.#definitions = definitions
  }

  get names(): readonly string[] {
    return this.#disposed ? [] : [...this.#definitions.keys()]
  }

  get(name: string): ToolDefinition | undefined {
    return this.#disposed ? undefined : this.#definitions.get(name)
  }

  schemas(): ToolSchema[] {
    if (this.#disposed) return []
    return [...this.#definitions.values()].map(definition => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }))
  }

  dispose(): void {
    this.#disposed = true
    this.#definitions.clear()
  }
}

function keyOf(name: string, scope: string | undefined): string {
  return `${scope ?? ''}\u0000${name}`
}

export class ToolRegistry {
  #entries = new Map<string, Entry>()
  #restrictions: ToolRestriction[] = []

  register(definition: ToolDefinition, options: ToolRegistrationOptions = {}): () => void {
    if (definition.name.length === 0) throw new TypeError('tool name must not be empty')
    const key = keyOf(definition.name, options.scope)
    if (this.#entries.has(key)) {
      throw new Error(`tool "${definition.name}" is already registered${options.scope === undefined ? '' : ` in scope "${options.scope}"`}`)
    }
    const entry: Entry = {
      definition,
      scope: options.scope,
      when: options.when,
    }
    this.#entries.set(key, entry)
    return () => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key)
    }
  }

  /** 静态查询：scoped 同名工具遮蔽 global；不评估 `when` / 掩码。 */
  get(name: string, scope?: string): ToolDefinition | undefined {
    if (scope !== undefined) {
      const scoped = this.#entries.get(keyOf(name, scope))
      if (scoped !== undefined) return scoped.definition
    }
    return this.#entries.get(keyOf(name, undefined))?.definition
  }

  /** 静态可见工具；scoped 覆盖 global。 */
  list(scope?: string): ToolDefinition[] {
    const visible = new Map<string, ToolDefinition>()
    for (const entry of this.#entries.values()) {
      if (entry.scope === undefined) visible.set(entry.definition.name, entry.definition)
    }
    if (scope !== undefined) {
      for (const entry of this.#entries.values()) {
        if (entry.scope === scope) visible.set(entry.definition.name, entry.definition)
      }
    }
    return [...visible.values()]
  }

  schemas(scope?: string): ToolSchema[] {
    return this.list(scope).map(definition => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }))
  }

  /** 对全局工具应用 allow/deny 掩码；scoped 工具不受影响。 */
  restrict(filter: ToolRestriction): () => void {
    const snapshot: ToolRestriction = {
      ...filter.allow === undefined ? {} : { allow: [...filter.allow] },
      ...filter.deny === undefined ? {} : { deny: [...filter.deny] },
    }
    this.#restrictions.push(snapshot)
    return () => {
      const index = this.#restrictions.indexOf(snapshot)
      if (index >= 0) this.#restrictions.splice(index, 1)
    }
  }

  /**
   * 解析一个步骤的可见工具集。
   * scoped 先覆盖 global，再评估条件；条件抛错使步骤准备失败。
   */
  async resolve(context: ToolActivationContext): Promise<ResolvedToolSet> {
    const visibleGlobals = this.#visibleGlobalNames()
    const candidates = new Map<string, Entry>()

    for (const entry of this.#entries.values()) {
      if (entry.scope !== undefined) continue
      if (visibleGlobals.has(entry.definition.name)) candidates.set(entry.definition.name, entry)
    }
    if (context.scope !== undefined) {
      for (const entry of this.#entries.values()) {
        if (entry.scope === context.scope) candidates.set(entry.definition.name, entry)
      }
    }

    const active = new Map<string, ToolDefinition>()
    for (const [name, entry] of candidates) {
      if (entry.when !== undefined) {
        let available: boolean
        try {
          available = await entry.when(context)
        } catch (error) {
          throw new ToolActivationError(name, error)
        }
        if (!available) continue
      }
      active.set(name, entry.definition)
    }
    return new ResolvedToolSetImpl(active)
  }

  /** 执行一次调用；参数/输出校验失败都规范化为 isError 结果。 */
  async execute(
    call: ToolCallBlock,
    ctx: ToolContext,
    toolSet?: ResolvedToolSet,
  ): Promise<ToolResult> {
    if (ctx.signal.aborted) throw ctx.signal.reason
    const tool = toolSet === undefined
      ? this.get(call.name, ctx.scope)
      : toolSet.get(call.name)
    if (tool === undefined) return errorResult(`unknown tool "${call.name}"`)

    let args: unknown
    try {
      args = parseArguments(call.arguments)
    } catch {
      return errorResult(`invalid JSON arguments for tool "${call.name}"`)
    }

    const argumentErrors = tool.parameterValidator?.(args) ?? []
    if (argumentErrors.length > 0) {
      return errorResult(`invalid arguments for tool "${call.name}": ${argumentErrors.join('; ')}`)
    }

    let value: unknown
    try {
      value = await tool.execute(args, ctx)
      if (ctx.signal.aborted) throw ctx.signal.reason
    } catch (error) {
      if (isAbortError(error) || ctx.signal.aborted) throw error
      return errorResult(error instanceof Error ? error.message : String(error))
    }

    try {
      assertJsonValue(value, `tool "${call.name}" output`)
    } catch (error) {
      return errorResult(`tool "${call.name}" returned non-JSON value: ${error instanceof Error ? error.message : String(error)}`)
    }

    const outputErrors = tool.outputValidator?.(value as JsonValue) ?? []
    if (outputErrors.length > 0) {
      return errorResult(`tool "${call.name}" returned invalid output: ${outputErrors.join('; ')}`)
    }

    let content: ContentBlock[]
    try {
      content = tool.output.render(args, value as JsonValue)
    } catch (error) {
      return errorResult(`tool "${call.name}" render failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    let meta: JsonValue | undefined
    if (tool.output.presentationMeta !== undefined) {
      try {
        meta = tool.output.presentationMeta(args, value as JsonValue)
        assertJsonValue(meta, `tool "${call.name}" presentation meta`)
      } catch (error) {
        return errorResult(`tool "${call.name}" presentation meta failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return {
      content: normalizeContent(content, false),
      isError: false,
      ...meta === undefined ? {} : { meta },
    }
  }

  #visibleGlobalNames(): Set<string> {
    const names = new Set<string>()
    for (const entry of this.#entries.values()) {
      if (entry.scope === undefined) names.add(entry.definition.name)
    }
    for (const filter of this.#restrictions) {
      if (filter.allow !== undefined) {
        const allowed = new Set(filter.allow)
        for (const name of [...names]) if (!allowed.has(name)) names.delete(name)
      }
      if (filter.deny !== undefined) {
        for (const name of filter.deny) names.delete(name)
      }
    }
    return names
  }
}

/** 便捷构造：从 schema DSL 之外手写 raw JSON Schema 时使用。 */
export function rawTool(input: {
  name: string
  description: string
  parameters: JsonObject
  outputSchema: JsonObject
  execute(args: unknown, ctx: ToolContext): Promise<JsonValue> | JsonValue
  render(args: unknown, value: JsonValue): ContentBlock[]
}): ToolDefinition {
  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    output: { schema: input.outputSchema, render: input.render },
    execute: input.execute,
  }
}

/** 供 demo / 测试读取消息中的文本。 */
export function toolResultText(message: { content: ContentBlock[] }): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}
