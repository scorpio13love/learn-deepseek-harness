/**
 * s16 的最小工具注册表。
 *
 * PTC 需要给模型一个稳定的工具命名空间（`tools.<name>(args)`），
 * 因此注册表只承担三件事：
 *   1. 保存 name / description / JSON Schema；
 *   2. 按名字执行工具，把参数原样交给工具实现；
 *   3. 让 runtime 能拿到所有工具，生成 `tools` 绑定。
 *
 * 工具抛出的错误不在这里吞掉：runtime 会把它包装成结构化结果，
 * 模型代码可以选择 try/catch 或让整个 program 失败。
 */

export type JsonObject = Record<string, unknown>

export interface PtcToolContext {
  /** 本次 run 的取消信号；工具应观察它。 */
  readonly signal: AbortSignal
  /** 同一次 run 内唯一的调用 id。 */
  readonly callId: string
}

export interface PtcToolDefinition<T = unknown> {
  readonly name: string
  readonly description: string
  /** 模型可见的 JSON Schema；本课不做完整校验。 */
  readonly parameters: JsonObject
  run(args: unknown, ctx: PtcToolContext): T | Promise<T>
}

export function defineTool<T>(input: {
  name: string
  description: string
  parameters: JsonObject
  run(args: unknown, ctx: PtcToolContext): T | Promise<T>
}): PtcToolDefinition<T> {
  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    run: input.run,
  }
}

export interface PtcToolSchema {
  name: string
  description: string
  parameters: JsonObject
}

export class ToolRegistry {
  #tools = new Map<string, PtcToolDefinition>()

  register(tool: PtcToolDefinition): () => void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`)
    }
    this.#tools.set(tool.name, tool)
    return () => {
      if (this.#tools.get(tool.name) === tool) this.#tools.delete(tool.name)
    }
  }

  get(name: string): PtcToolDefinition | undefined {
    return this.#tools.get(name)
  }

  list(): PtcToolDefinition[] {
    return [...this.#tools.values()]
  }

  schemas(): PtcToolSchema[] {
    return this.list().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }

  /** 执行一次工具；未知工具和工具异常都向上抛，由 runtime 归一化。 */
  async execute(name: string, args: unknown, ctx: PtcToolContext): Promise<unknown> {
    const tool = this.#tools.get(name)
    if (tool === undefined) throw new Error(`unknown tool "${name}"`)
    return await tool.run(args, ctx)
  }
}

// ---------------------------------------------------------------------------
// 一个安全的算术求值器（demo / 测试共用，不依赖 eval）
// ---------------------------------------------------------------------------

export function evaluateArithmetic(expression: string): number {
  let index = 0
  const input = expression

  function skip(): void {
    while (input[index] === ' ') index += 1
  }

  function parseNumber(): number {
    skip()
    const start = index
    while (index < input.length && /[0-9.]/.test(input[index] ?? '')) index += 1
    if (start === index) throw new Error(`expected number at ${index}`)
    const value = Number(input.slice(start, index))
    if (!Number.isFinite(value)) throw new Error(`invalid number "${input.slice(start, index)}"`)
    return value
  }

  function parseFactor(): number {
    skip()
    if (input[index] === '(') {
      index += 1
      const value = parseExpr()
      skip()
      if (input[index] !== ')') throw new Error(`expected ")" at ${index}`)
      index += 1
      return value
    }
    if (input[index] === '-') {
      index += 1
      return -parseFactor()
    }
    return parseNumber()
  }

  function parseTerm(): number {
    let value = parseFactor()
    while (true) {
      skip()
      const op = input[index]
      if (op !== '*' && op !== '/') return value
      index += 1
      const right = parseFactor()
      value = op === '*' ? value * right : value / right
    }
  }

  function parseExpr(): number {
    let value = parseTerm()
    while (true) {
      skip()
      const op = input[index]
      if (op !== '+' && op !== '-') return value
      index += 1
      const right = parseTerm()
      value = op === '+' ? value + right : value - right
    }
  }

  const value = parseExpr()
  skip()
  if (index !== input.length) throw new Error(`unexpected character "${input[index]}"`)
  return value
}

export function createCalcTool(): PtcToolDefinition<number> {
  return defineTool<number>({
    name: 'calc',
    description: 'Evaluate an arithmetic expression with + - * / and parentheses.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'The expression to evaluate.' },
      },
      required: ['expression'],
    },
    run(args) {
      const { expression } = args as { expression?: unknown }
      if (typeof expression !== 'string') throw new Error('calc expects { expression: string }')
      return evaluateArithmetic(expression)
    },
  })
}
