/** capstone 的四个工具：list_files / read_file / search_text / write_file。 */

import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { ApprovalDeniedError } from './approval.ts'
import type { ApprovalService } from './approval.ts'
import type { JsonObject, JsonValue, ToolSpec } from './types.ts'
import { Workspace } from './workspace.ts'

const MAX_LIST = 200
const MAX_READ_CHARS = 20_000
const MAX_MATCHES = 100
const MAX_SEARCH_FILES = 200
const MAX_WRITE_BYTES = 256_000
const SKIP_DIRS = new Set(['.git', 'node_modules', '.runs', 'runs', 'dist', 'coverage'])
const SKIP_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.zip', '.lock', '.sqlite']

export interface ToolContext {
  workspace: Workspace
  approval: ApprovalService
  signal?: AbortSignal
}

export interface ToolDefinition extends ToolSpec {
  run(args: JsonObject, ctx: ToolContext): Promise<JsonValue>
}

function stringArg(args: JsonObject, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`tool argument "${key}" must be a non-empty string`)
  }
  return value
}

function truncate(input: string, maxChars: number): { text: string; truncated: boolean; chars: number } {
  const chars = Array.from(input)
  if (chars.length <= maxChars) return { text: input, truncated: false, chars: chars.length }

  let omitted = chars.length - maxChars
  let marker = `\n…[truncated ${omitted} chars]`
  let keep = maxChars - Array.from(marker).length
  omitted = chars.length - keep
  marker = `\n…[truncated ${omitted} chars]`
  keep = maxChars - Array.from(marker).length

  return {
    text: chars.slice(0, keep).join('') + marker,
    truncated: true,
    chars: chars.length,
  }
}

export async function listWorkspaceFiles(workspace: Workspace, limit = MAX_LIST): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  const walk = async (relativeDir: string): Promise<void> => {
    if (files.length >= limit) return
    let entries
    try {
      entries = await readdir(join(workspace.root, relativeDir), { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (files.length >= limit) return
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`)
        continue
      }
      if (!entry.isFile()) continue
      files.push(relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`)
    }
  }
  await walk('')
  return { files, truncated: files.length >= limit }
}

const listFiles: ToolDefinition = {
  name: 'list_files',
  description: 'List text/source files in the workspace. Skips .git, node_modules and hidden build output.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async run(_args, ctx) {
    const { files, truncated } = await listWorkspaceFiles(ctx.workspace)
    return { files, truncated }
  },
}

const readFile: ToolDefinition = {
  name: 'read_file',
  description: 'Read a UTF-8 text file inside the workspace. Output is truncated at 20k characters.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Workspace-relative path.' } },
    required: ['path'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const path = stringArg(args, 'path')
    const content = await ctx.workspace.readText(path)
    const result = truncate(content, MAX_READ_CHARS)
    return {
      path,
      content: result.text,
      truncated: result.truncated,
      chars: result.chars,
    }
  },
}

const searchText: ToolDefinition = {
  name: 'search_text',
  description: 'Search workspace text files for a literal string or regular expression. Returns file, line and text.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Literal or regex query.' },
      regex: { type: 'boolean', description: 'Treat query as a case-insensitive regular expression.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const query = stringArg(args, 'query')
    let matcher: (line: string) => boolean
    if (args.regex === true) {
      const regex = new RegExp(query, 'i')
      matcher = line => regex.test(line)
    } else {
      const needle = query.toLowerCase()
      matcher = line => line.toLowerCase().includes(needle)
    }

    const { files } = await listWorkspaceFiles(ctx.workspace, MAX_SEARCH_FILES)
    const matches: Array<{ file: string; line: number; text: string }> = []
    for (const file of files) {
      if (matches.length >= MAX_MATCHES) break
      if (SKIP_EXTENSIONS.some(extension => file.toLowerCase().endsWith(extension))) continue
      let content: string
      try {
        content = await ctx.workspace.readText(file)
      } catch {
        continue
      }
      const lines = content.split('\n')
      for (const [index, line] of lines.entries()) {
        if (!matcher(line)) continue
        matches.push({ file, line: index + 1, text: line.trim().slice(0, 240) })
        if (matches.length >= MAX_MATCHES) break
      }
    }

    return { query, matches, scannedFiles: files.length }
  },
}

const writeFile: ToolDefinition = {
  name: 'write_file',
  description: 'Write a UTF-8 file inside the workspace. Requires approval; the default policy only allows audit.md.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      content: { type: 'string', description: 'Full file content.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const path = stringArg(args, 'path')
    const content = stringArg(args, 'content')
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_WRITE_BYTES) throw new Error(`write_file exceeds ${MAX_WRITE_BYTES} bytes`)

    // 先解析路径（逃逸在审批之前就失败），审批通过后才写。
    const absolute = await ctx.workspace.resolve(path)
    const relativePath = ctx.workspace.relative(absolute).replaceAll('\\', '/')
    const decision = await ctx.approval.request({
      id: `approval-${randomUUID()}`,
      toolName: 'write_file',
      summary: `write ${relativePath} (${bytes} bytes)`,
      path: relativePath,
      args: { path: relativePath, bytes },
      ...ctx.signal === undefined ? {} : { signal: ctx.signal },
    })
    if (decision !== 'allowed-once') throw new ApprovalDeniedError(relativePath)

    await ctx.workspace.writeText(relativePath, content)
    return { path: relativePath, bytes }
  },
}

export function capstoneTools(): ToolDefinition[] {
  return [listFiles, readFile, searchText, writeFile]
}

export function compactToolArgs(name: string, args: JsonObject): JsonObject {
  if (name === 'write_file') {
    const content = typeof args.content === 'string' ? args.content : ''
    return {
      path: typeof args.path === 'string' ? args.path : '',
      bytes: Buffer.byteLength(content, 'utf8'),
    }
  }
  if (name === 'search_text') {
    return {
      query: typeof args.query === 'string' ? args.query : '',
      regex: args.regex === true,
    }
  }
  if (name === 'read_file') {
    return { path: typeof args.path === 'string' ? args.path : '' }
  }
  return {}
}
