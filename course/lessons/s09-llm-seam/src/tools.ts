/**
 * s08 沿用 s07 的工具注册表：scope/condition + pipeline + batch。
 *
 * s05 新增：
 * - `execute()` 委托 `ToolPipeline`（pre/guard/approval/execute/post/result）；
 * - `executeBatch()` 委托 `executeToolBatch`（独占屏障 + 滚动池）；
 * - `executionMode()` 读取 `isConcurrencySafe`。
 *
 * 真实实现见 `packages/core/tools/src/{index,pipeline,batch}.ts`。
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
import { executeToolBatch } from './batch.ts'
import type { ToolBatchResult } from './batch.ts'
import { ToolPipeline } from './pipeline.ts'
import type { ToolPipelineOptions } from './pipeline.ts'

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
  readonly pipeline: ToolPipeline
  #entries = new Map<string, Entry>()
  #restrictions: ToolRestriction[] = []

  constructor(options: ToolPipelineOptions = {}) {
    this.pipeline = new ToolPipeline(options)
  }

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

  /** 执行一次调用；策略/校验/渲染由 pipeline 负责。 */
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
    return this.pipeline.run(tool, call, ctx)
  }

  /** 按模型顺序执行一批调用，返回对齐的结果与附加上下文。 */
  async executeBatch(
    calls: readonly ToolCallBlock[],
    ctx: ToolContext,
    toolSet: ResolvedToolSet | undefined,
    maxParallel = 10,
  ): Promise<ToolBatchResult> {
    return executeToolBatch(
      calls,
      call => this.execute(call, ctx, toolSet),
      call => this.executionMode(call, toolSet) === 'parallel',
      maxParallel,
      ctx.signal,
    )
  }

  /** 并发安全工具返回 parallel，其余（含未知/非法参数）形成独占屏障。 */
  executionMode(call: ToolCallBlock, toolSet?: ResolvedToolSet): 'parallel' | 'exclusive' {
    const tool = toolSet === undefined
      ? this.get(call.name)
      : toolSet.get(call.name)
    if (tool === undefined) return 'exclusive'
    let args: unknown
    try {
      args = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments)
    } catch {
      return 'exclusive'
    }
    return tool.isConcurrencySafe?.(args) === true ? 'parallel' : 'exclusive'
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
