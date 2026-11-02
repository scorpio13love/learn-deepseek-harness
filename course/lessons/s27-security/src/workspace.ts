/**
 * 工作区容器：所有路径先 realpath，再 relative 判断。
 *
 * 关键点：目标可能不存在，所以对“最近的已存在祖先”取 realpath，
 * 再把剩余后缀拼回去；这样既挡 symlink，也允许创建新文件。
 */

import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

export class PathEscapeError extends Error {
  readonly code = 'PATH_ESCAPE'
  readonly path: string
  readonly root: string

  constructor(path: string, root: string) {
    super(`path "${path}" escapes workspace "${root}"`)
    this.name = 'PathEscapeError'
    this.path = path
    this.root = root
  }
}

export class SensitiveFileError extends Error {
  readonly code = 'SENSITIVE_FILE'

  constructor(path: string) {
    super(`refusing to access sensitive path "${path}"`)
    this.name = 'SensitiveFileError'
  }
}

const SENSITIVE_BASENAMES = new Set(['.env', 'id_rsa', 'id_ed25519', 'credentials.json'])
const SENSITIVE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx']

export class Workspace {
  readonly root: string

  private constructor(root: string) {
    this.root = root
  }

  static async open(root: string): Promise<Workspace> {
    if (!isAbsolute(root)) throw new TypeError('workspace root must be absolute')
    const real = await realpath(root)
    const info = await stat(real)
    if (!info.isDirectory()) throw new TypeError(`workspace root is not a directory: ${root}`)
    return new Workspace(real)
  }

  /** 解析并校验；逃逸、NUL、无法判定的路径都抛错。 */
  async resolve(input: string): Promise<string> {
    if (input.includes('\0')) throw new PathEscapeError(input, this.root)
    const absolute = isAbsolute(input) ? resolve(input) : resolve(this.root, input)
    const real = await this.#realpathNearest(absolute)
    const rel = relative(this.root, real)

    if (rel === '') return this.root
    if (rel.startsWith('..') || isAbsolute(rel)) throw new PathEscapeError(input, this.root)
    return real
  }

  async readText(input: string): Promise<string> {
    const absolute = await this.resolve(input)
    this.#assertNotSensitive(absolute)
    return readFile(absolute, 'utf8')
  }

  async writeText(input: string, content: string): Promise<void> {
    const absolute = await this.resolve(input)
    this.#assertNotSensitive(absolute)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf8')
  }

  async exists(input: string): Promise<boolean> {
    try {
      await stat(await this.resolve(input))
      return true
    } catch {
      return false
    }
  }

  #assertNotSensitive(absolute: string): void {
    const rel = relative(this.root, absolute)
    const parts = rel.split(/[\\/]+/)
    if (parts.includes('.git')) throw new SensitiveFileError(relative(this.root, absolute))
    const base = parts.at(-1) ?? ''
    if (SENSITIVE_BASENAMES.has(base) || base.startsWith('.env.')) {
      throw new SensitiveFileError(relative(this.root, absolute))
    }
    if (SENSITIVE_SUFFIXES.some(suffix => base.toLowerCase().endsWith(suffix))) {
      throw new SensitiveFileError(relative(this.root, absolute))
    }
  }

  async #realpathNearest(target: string): Promise<string> {
    let current = target
    const suffix: string[] = []

    for (;;) {
      try {
        const real = await realpath(current)
        return suffix.length === 0 ? real : resolve(real, ...suffix.reverse())
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') throw error
        const parent = dirname(current)
        if (parent === current) throw error
        suffix.push(current.slice(parent.length + 1))
        current = parent
      }
    }
  }
}
