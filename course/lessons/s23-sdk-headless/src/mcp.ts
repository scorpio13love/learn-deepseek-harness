/**
 * s17 · SDK / headless：沿用前序课程的实现（本课改动见 README）。
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { rawTool } from './tools.ts'
import type { JsonObject, ToolDefinition } from './types.ts'

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export class McpClient {
  #child: ChildProcessWithoutNullStreams
  #pending = new Map<number, Pending>()
  #nextId = 1
  #stderr = ''

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      if (line.trim().length === 0) return
      let message: { id?: number; result?: unknown; error?: { message?: string; code?: number } }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        return
      }
      if (message.id === undefined) return
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message ?? `MCP error ${String(message.error.code)}`))
      } else {
        pending.resolve(message.result)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.#stderr += chunk })
  }

  static async connect(command: string, args: readonly string[] = [], timeoutMs = 10_000): Promise<McpClient> {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    const client = new McpClient(child)
    await client.#request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-course-s15', version: '0.0.0' },
    }, timeoutMs)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    return client
  }

  get stderr(): string {
    return this.#stderr
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.#request('tools/list', {}) as { tools?: McpTool[] }
    return result.tools ?? []
  }

  async callTool(name: string, args: unknown): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
    return this.#request('tools/call', { name, arguments: args }) as Promise<{
      content: Array<{ type: string; text?: string }>
      isError?: boolean
    }>
  }

  close(): void {
    this.#child.kill()
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('MCP client closed'))
    }
    this.#pending.clear()
  }

  #request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`MCP request "${method}" timed out`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
}

/** 把 MCP 工具投影成原生工具；名字加 server 前缀避免冲突。 */
export function mcpTools(client: McpClient, server: string, tools: readonly McpTool[]): ToolDefinition[] {
  return tools.map(tool => rawTool({
    name: `mcp__${server}__${tool.name}`,
    description: tool.description ?? `MCP tool ${tool.name}`,
    parameters: (tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true }) as JsonObject,
    outputSchema: { type: 'string' },
    execute: async (args) => {
      const result = await client.callTool(tool.name, args)
      const text = result.content
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('\n')
      if (result.isError === true) throw new Error(text || 'MCP tool failed')
      return text
    },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  }))
}
