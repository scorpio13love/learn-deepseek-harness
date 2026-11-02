/**
 * s16 · web：沿用前序课程的实现（本课改动见 README）。
 */

import type { Message, ToolSchema } from './types.ts'
import { createTextMessage } from './session.ts'

export interface PromptSection {
  name: string
  /** 升序拼接；同序按 name 的 code-unit 顺序。 */
  order: number
  text: string
  /** 生效的 complete section 成为唯一提示词；多个同时生效会失败。 */
  complete?: true
  /** false 时保留 {{…}} 字面量。 */
  interpolate?: false
}

export interface PromptContext {
  name: string
  order: number
  text: string
  /** 必需的运行时上下文不能被抑制；s06 只记录，不实现抑制。 */
  required?: true
  interpolate?: false
}

export interface ModelSelection {
  provider: string
  model: string
}

export interface AssembleContext {
  modelSelection: ModelSelection
  toolSet: { schemas(): ToolSchema[] }
  signal?: AbortSignal
}

export interface PromptAssembly {
  sections: PromptSection[]
  contexts: PromptContext[]
  variables: Record<string, string>
  tools: ToolSchema[]
}

export type AssembleListener = (
  assembly: PromptAssembly,
  next: () => Promise<PromptAssembly>,
) => Promise<PromptAssembly> | PromptAssembly

export interface SystemPromptOptions {
  /** 显式工具顺序；必须恰好包含一个 '<unlisted-tools>' 作为剩余项。 */
  toolOrder?: readonly string[]
}

const REST_TOOLS = '<unlisted-tools>'
const VARIABLE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g

function interpolate(text: string, variables: Record<string, string>): string {
  return text.replace(VARIABLE, (_match, name: string) => {
    const value = variables[name]
    if (value === undefined) throw new Error(`unknown prompt variable "${name}"`)
    return value
  })
}

function renderText(input: { text: string; interpolate?: false }, variables: Record<string, string>): string {
  return input.interpolate === false ? input.text : interpolate(input.text, variables)
}

/** 从 assembly 渲染最终提示词；空 section 被丢弃。 */
export function renderPrompt(assembly: PromptAssembly): string {
  const complete = assembly.sections.filter(section => section.complete === true)
  if (complete.length > 1) throw new Error('more than one complete prompt section is active')
  if (complete.length === 1) {
    return renderText(complete[0]!, assembly.variables).trim()
  }
  return assembly.sections
    .map(section => renderText(section, assembly.variables).trim())
    .filter(text => text.length > 0)
    .join('\n\n')
}

/** 渲染上下文段落；空段落被丢弃。 */
export function renderContexts(assembly: PromptAssembly): string[] {
  return assembly.contexts
    .map(context => renderText(context, assembly.variables).trim())
    .filter(text => text.length > 0)
}

/** 把运行时上下文投影成一条 user-role 快照；没有内容时返回 undefined。 */
export function renderContextMessage(assembly: PromptAssembly): Message | undefined {
  const parts = renderContexts(assembly)
  if (parts.length === 0) return undefined
  return createTextMessage('user', parts.join('\n\n'))
}

export class SystemPrompt {
  #sections = new Map<string, PromptSection>()
  #contexts = new Map<string, PromptContext>()
  #variables = new Map<string, string | (() => string)>()
  #listeners: AssembleListener[] = []
  #toolOrder: readonly string[] | undefined

  constructor(options: SystemPromptOptions = {}) {
    if (options.toolOrder !== undefined) {
      const rests = options.toolOrder.filter(name => name === REST_TOOLS).length
      if (rests !== 1) throw new Error(`toolOrder must contain exactly one "${REST_TOOLS}" entry`)
      if (new Set(options.toolOrder).size !== options.toolOrder.length) throw new Error('toolOrder contains duplicates')
      this.#toolOrder = [...options.toolOrder]
    }
  }

  section(input: PromptSection): () => void {
    if (this.#sections.has(input.name)) throw new Error(`prompt section "${input.name}" is already registered`)
    if (!Number.isFinite(input.order)) throw new TypeError(`prompt section "${input.name}" has invalid order`)
    const snapshot: PromptSection = { ...input }
    this.#sections.set(input.name, snapshot)
    return () => {
      if (this.#sections.get(input.name) === snapshot) this.#sections.delete(input.name)
    }
  }

  context(input: PromptContext): () => void {
    if (this.#contexts.has(input.name)) throw new Error(`prompt context "${input.name}" is already registered`)
    if (!Number.isFinite(input.order)) throw new TypeError(`prompt context "${input.name}" has invalid order`)
    const snapshot: PromptContext = { ...input }
    this.#contexts.set(input.name, snapshot)
    return () => {
      if (this.#contexts.get(input.name) === snapshot) this.#contexts.delete(input.name)
    }
  }

  variable(name: string, value: string | (() => string)): () => void {
    if (this.#variables.has(name)) throw new Error(`prompt variable "${name}" is already registered`)
    this.#variables.set(name, value)
    return () => {
      if (this.#variables.get(name) === value) this.#variables.delete(name)
    }
  }

  onAssemble(listener: AssembleListener): () => void {
    this.#listeners.push(listener)
    return () => {
      const index = this.#listeners.indexOf(listener)
      if (index >= 0) this.#listeners.splice(index, 1)
    }
  }

  async assemble(context: AssembleContext): Promise<PromptAssembly> {
    const variables: Record<string, string> = {
      provider: context.modelSelection.provider,
      model: context.modelSelection.model,
    }
    for (const [name, value] of this.#variables) {
      variables[name] = typeof value === 'function' ? value() : value
    }

    const sections = [...this.#sections.values()]
      .map(section => ({ ...section }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    const complete = sections.filter(section => section.complete === true)
    if (complete.length > 1) throw new Error('more than one complete prompt section is active')

    const contexts = [...this.#contexts.values()]
      .map(item => ({ ...item }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

    const tools = this.#orderTools(context.toolSet.schemas())
    let assembly: PromptAssembly = {
      sections: complete.length === 1 ? [complete[0]!] : sections,
      contexts,
      variables,
      tools,
    }

    const dispatch = async (index: number): Promise<PromptAssembly> => {
      const listener = this.#listeners[index]
      if (listener === undefined) return assembly
      return listener(assembly, () => dispatch(index + 1))
    }
    assembly = await dispatch(0)
    return assembly
  }

  #orderTools(tools: readonly ToolSchema[]): ToolSchema[] {
    if (this.#toolOrder === undefined) return tools.map(tool => ({ ...tool }))
    const available = new Map(tools.map(tool => [tool.name, tool]))
    const ordered: ToolSchema[] = []
    for (const name of this.#toolOrder) {
      if (name === REST_TOOLS) {
        ordered.push(...[...available.values()])
        available.clear()
        continue
      }
      const tool = available.get(name)
      if (tool === undefined) throw new Error(`toolOrder names unknown tool "${name}"`)
      ordered.push(tool)
      available.delete(name)
    }
    return ordered
  }
}
