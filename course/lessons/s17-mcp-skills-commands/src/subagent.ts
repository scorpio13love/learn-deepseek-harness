/**
 * s15 · MCP / skills / commands：沿用前序课程的实现（本课改动见 README）。
 */

import type { Model, ToolDefinition } from './types.ts'
import { Agent } from './agent.ts'
import { createTextMessage, Session } from './session.ts'
import { SystemPrompt } from './prompt.ts'
import { defineTool } from './schema.ts'
import { ToolRegistry } from './tools.ts'

export interface AgentPreset {
  name: string
  /** 追加到子 agent 的 persona。 */
  prompt?: string
  /** 只允许这些工具；省略表示继承全部。 */
  toolNames?: readonly string[]
}

export interface SubagentRequest {
  task: string
  parentSessionId: string
  /** 父 agent 的委派深度；子 agent 是 depth + 1。 */
  depth: number
  preset?: AgentPreset
  signal?: AbortSignal
}

export interface SubagentResult {
  childId: string
  answer: string
  depth: number
}

export interface SubagentBackend {
  run(request: SubagentRequest): Promise<SubagentResult>
}

export interface LocalSubagentOptions {
  model: Model
  tools: ToolRegistry
  maxSteps?: number
}

export class LocalSubagentBackend implements SubagentBackend {
  #model: Model
  #tools: ToolRegistry
  #maxSteps: number

  constructor(options: LocalSubagentOptions) {
    this.#model = options.model
    this.#tools = options.tools
    this.#maxSteps = options.maxSteps ?? 6
  }

  async run(request: SubagentRequest): Promise<SubagentResult> {
    const childId = `${request.parentSessionId}:child:${Date.now().toString(36)}`
    const session = new Session(childId)
    const tools = new ToolRegistry()
    const allowed = request.preset?.toolNames === undefined
      ? undefined
      : new Set(request.preset.toolNames)
    for (const tool of this.#tools.list()) {
      if (allowed === undefined || allowed.has(tool.name)) tools.register(tool)
    }

    let prompt: SystemPrompt | undefined
    if (request.preset?.prompt !== undefined) {
      prompt = new SystemPrompt()
      prompt.section({ name: 'subagent', order: 0, text: request.preset.prompt })
    }

    const agent = new Agent(session, this.#model, tools, {
      maxSteps: this.#maxSteps,
      ...prompt === undefined ? {} : { prompt },
    })
    const result = await agent.run(request.task, {
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
    if (result.reason.kind !== 'completed') {
      throw new Error(`subagent failed: ${result.reason.kind}`)
    }
    return {
      childId,
      answer: session.lastAssistantText() ?? '',
      depth: request.depth + 1,
    }
  }
}

export interface SubagentManagerOptions {
  backend: SubagentBackend
  /** 0 表示禁止委派；1 表示只允许直接子 agent。 */
  maxDepth: number
  maxActive: number
}

export class SubagentManager {
  #backend: SubagentBackend
  #maxDepth: number
  #maxActive: number
  #active = 0

  constructor(options: SubagentManagerOptions) {
    this.#backend = options.backend
    this.#maxDepth = options.maxDepth
    this.#maxActive = options.maxActive
  }

  get active(): number {
    return this.#active
  }

  async spawn(request: SubagentRequest): Promise<SubagentResult> {
    if (request.depth >= this.#maxDepth) {
      throw new Error(`subagent depth limit reached (maxDepth=${this.#maxDepth})`)
    }
    if (this.#active >= this.#maxActive) {
      throw new Error(`subagent concurrency limit reached (maxActive=${this.#maxActive})`)
    }
    this.#active += 1
    try {
      return await this.#backend.run(request)
    } finally {
      this.#active -= 1
    }
  }
}

export interface SubagentToolOptions {
  manager: SubagentManager
  parentSessionId: string
  depthPrefix?: number
}

/** 面向模型的委托工具；真实实现还会返回可继续的 child session id。 */
export function subagentTool(options: SubagentToolOptions): ToolDefinition {
  return defineTool({
    name: 'subagent',
    description: 'Delegate a self-contained task to a child agent and return its answer.',
    parameters: {
      task: { type: 'string', required: true, minLength: 1 },
      preset: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          childId: { type: 'string' },
          answer: { type: 'string' },
          depth: { type: 'integer' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `child ${value.childId}: ${value.answer}`,
      }],
    },
    execute: async (args, ctx) => {
      const result = await options.manager.spawn({
        task: args.task,
        parentSessionId: options.parentSessionId,
        depth: options.depthPrefix ?? 0,
        ...args.preset === undefined ? {} : { preset: { name: args.preset } },
        signal: ctx.signal,
      })
      return { childId: result.childId, answer: result.answer, depth: result.depth }
    },
  })
}

export { createTextMessage }
