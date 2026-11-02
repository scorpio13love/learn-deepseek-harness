/** 把五条边界组合成最小工具：read_file / write_file + 审计日志。 */

import type { ApprovalService } from './approval.ts'
import type { JsonValue } from './redact.ts'
import { redactValue } from './redact.ts'
import type { TruncatedText } from './truncate.ts'
import { truncateText } from './truncate.ts'
import { Workspace } from './workspace.ts'

export type AuditPhase = 'request' | 'result' | 'error' | 'denied'

export interface AuditEntry {
  at: number
  tool: string
  phase: AuditPhase
  data: JsonValue
}

export class AuditLog {
  #entries: AuditEntry[] = []
  #now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.#now = now
  }

  append(tool: string, phase: AuditPhase, data: unknown): void {
    // 审计日志只写 redact 后的值；原始参数不落盘。
    this.#entries.push({
      at: this.#now(),
      tool,
      phase,
      data: redactValue(data),
    })
  }

  get entries(): readonly AuditEntry[] {
    return this.#entries.map(entry => ({ ...entry }))
  }

  toJSON(): AuditEntry[] {
    return [...this.#entries]
  }
}

export interface ToolError {
  code: string
  message: string
}

export interface ToolOutcome {
  ok: boolean
  output?: JsonValue
  truncated?: boolean
  omitted?: number
  error?: ToolError
}

export interface SecureToolsOptions {
  workspace: Workspace
  approval: ApprovalService
  maxOutputChars?: number
  log?: AuditLog
  now?: () => number
}

export class SecureTools {
  #workspace: Workspace
  #approval: ApprovalService
  #maxOutputChars: number
  #log: AuditLog
  #counter = 0

  constructor(options: SecureToolsOptions) {
    this.#workspace = options.workspace
    this.#approval = options.approval
    this.#maxOutputChars = Math.max(16, options.maxOutputChars ?? 2_000)
    this.#log = options.log ?? new AuditLog(options.now)
  }

  get log(): AuditLog {
    return this.#log
  }

  get workspace(): Workspace {
    return this.#workspace
  }

  async readFile(path: string): Promise<ToolOutcome> {
    this.#log.append('read_file', 'request', { path })
    try {
      const content = await this.#workspace.readText(path)
      const truncated: TruncatedText = truncateText(content, this.#maxOutputChars)
      const output: JsonValue = {
        path,
        content: truncated.text,
        truncated: truncated.truncated,
        omitted: truncated.omitted,
      }
      this.#log.append('read_file', 'result', {
        path,
        chars: truncated.returnedLength,
        truncated: truncated.truncated,
      })
      return {
        ok: true,
        output,
        truncated: truncated.truncated,
        omitted: truncated.omitted,
      }
    } catch (error) {
      return this.#fail('read_file', path, error)
    }
  }

  async writeFile(path: string, content: string): Promise<ToolOutcome> {
    const bytes = Buffer.byteLength(content, 'utf8')
    this.#log.append('write_file', 'request', { path, bytes })

    // 先做路径校验，再弹审批：用户不应该为一次必然逃逸的写入做决定。
    try {
      await this.#workspace.resolve(path)
    } catch (error) {
      return this.#fail('write_file', path, error)
    }

    this.#counter += 1
    const decision = await this.#approval.request({
      id: `approval-${this.#counter}`,
      toolName: 'write_file',
      summary: `写入 ${path}（${bytes} 字节）`,
      args: { path, bytes },
    })

    if (decision !== 'allowed-once') {
      this.#log.append('write_file', 'denied', { path, decision })
      return {
        ok: false,
        error: { code: 'APPROVAL_DENIED', message: `write_file "${path}" was not approved` },
      }
    }

    try {
      await this.#workspace.writeText(path, content)
      this.#log.append('write_file', 'result', { path, bytes })
      return { ok: true, output: { path, bytes } }
    } catch (error) {
      return this.#fail('write_file', path, error)
    }
  }

  #fail(tool: string, path: string, error: unknown): ToolOutcome {
    const code = typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'TOOL_ERROR'
    const message = error instanceof Error ? error.message : String(error)
    this.#log.append(tool, 'error', { path, code, message })
    return { ok: false, error: { code, message } }
  }
}
