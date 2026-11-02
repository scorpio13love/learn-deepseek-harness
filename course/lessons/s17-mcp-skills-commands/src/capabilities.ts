/**
 * s15 · MCP / skills / commands：沿用前序课程的实现（本课改动见 README）。
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { defineTool } from './schema.ts'
import type { ContentBlock, ToolDefinition } from './types.ts'
import type { ApprovalService } from './pipeline.ts'

export interface FsProvider {
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  /** 解析并校验路径；逃逸工作区时抛错。 */
  resolve(path: string): string
}

export class LocalFs implements FsProvider {
  readonly root: string

  constructor(root: string) {
    if (!isAbsolute(root)) throw new TypeError('workspace root must be absolute')
    this.root = root
  }

  resolve(path: string): string {
    const absolute = isAbsolute(path) ? path : resolve(this.root, path)
    const rel = relative(this.root, absolute)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`path "${path}" escapes workspace "${this.root}"`)
    }
    return absolute
  }

  async read(path: string): Promise<string> {
    return readFile(this.resolve(path), 'utf8')
  }

  async write(path: string, content: string): Promise<void> {
    const absolute = this.resolve(path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf8')
  }
}

export interface Sandbox {
  /** 在进程启动前包装 argv；返回实际要 spawn 的 argv。 */
  wrap(argv: readonly string[]): readonly string[]
}

export class NoSandbox implements Sandbox {
  wrap(argv: readonly string[]): readonly string[] {
    return [...argv]
  }
}

/** 测试/演示用：记录包装前后的 argv。 */
export class RecordingSandbox implements Sandbox {
  readonly calls: Array<{ before: readonly string[]; after: readonly string[] }> = []

  wrap(argv: readonly string[]): readonly string[] {
    const after = ['sandbox-exec', '-p', '(version 1)(allow default)', ...argv]
    this.calls.push({ before: [...argv], after })
    return after
  }
}

export interface ShellOptions {
  cwd?: string
  signal?: AbortSignal
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export interface ShellResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface ShellProvider {
  run(command: string, options?: ShellOptions): Promise<ShellResult>
}

export class LocalShell implements ShellProvider {
  #sandbox: Sandbox
  #shell: string
  #cwd: string | undefined

  constructor(options: { sandbox?: Sandbox; shell?: string; cwd?: string } = {}) {
    this.#sandbox = options.sandbox ?? new NoSandbox()
    this.#shell = options.shell ?? '/bin/sh'
    this.#cwd = options.cwd
  }

  run(command: string, options: ShellOptions = {}): Promise<ShellResult> {
    const argv = this.#sandbox.wrap([this.#shell, '-c', command])
    return new Promise((resolvePromise) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: options.cwd ?? this.#cwd,
        env: options.env ?? process.env,
        signal: options.signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, options.timeoutMs)

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('error', error => {
        if (timer !== undefined) clearTimeout(timer)
        resolvePromise({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut })
      })
      child.on('close', code => {
        if (timer !== undefined) clearTimeout(timer)
        resolvePromise({ exitCode: code, stdout, stderr, timedOut })
      })
    })
  }
}

export class AllowAllApproval implements ApprovalService {
  async request(): Promise<'allowed-once'> {
    return 'allowed-once'
  }
}

export class DenyAllApproval implements ApprovalService {
  async request(): Promise<'denied'> {
    return 'denied'
  }
}

export interface CapabilityToolsOptions {
  fs: FsProvider
  shell: ShellProvider
  approval: ApprovalService
  /** bash 的工作目录；默认进程 cwd。 */
  cwd?: string
}

function text(blocks: ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

export function capabilityTools(options: CapabilityToolsOptions): ToolDefinition[] {
  const read = defineTool({
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the workspace.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute or workspace-relative path.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args) => options.fs.read(args.path),
  })

  const write = defineTool({
    name: 'write_file',
    description: 'Write a UTF-8 text file inside the workspace. Requires approval.',
    parameters: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args, ctx) => {
      const approval = await options.approval.request({
        toolName: 'write_file',
        args,
        signal: ctx.signal,
      })
      if (approval !== 'allowed-once') throw new Error('write_file was not approved')
      await options.fs.write(args.path, args.content)
      return `wrote ${args.path}`
    },
  })

  const bash = defineTool({
    name: 'bash',
    description: 'Run a shell command inside the workspace. Requires approval.',
    parameters: {
      command: { type: 'string', required: true },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 60_000 },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          timedOut: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `exit=${String(value.exitCode)}\n${value.stdout}${value.stderr}`,
      }],
    },
    execute: async (args, ctx) => {
      const approval = await options.approval.request({
        toolName: 'bash',
        args,
        signal: ctx.signal,
      })
      if (approval !== 'allowed-once') throw new Error('bash was not approved')
      const result = await options.shell.run(args.command, {
        ...options.cwd === undefined ? {} : { cwd: options.cwd },
        signal: ctx.signal,
        ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
      })
      return {
        exitCode: result.exitCode ?? -1,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      }
    },
  })

  return [read, write, bash]
}

export { text as capabilityText }
