/**
 * s13 · capability seams：沿用前序课程的实现（本课改动见 README）。
 */

import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionEvent, SessionHeader } from './types.ts'
import { Session } from './session.ts'
import { deepFreeze } from './types.ts'

const HEADER_TYPE = 'session/header'
const FILE = 'session.jsonl'

interface StoredHeaderLine extends SessionHeader {
  type: typeof HEADER_TYPE
}

export interface StoredSessionHandle {
  readonly header: SessionHeader
  readonly session: Session
  readonly path: string
  /** 开始把 session 的新事件写入缓冲。 */
  attach(): () => void
  /** 把缓冲写入磁盘并 fsync；这是持久性屏障。 */
  flush(): Promise<void>
  close(): Promise<void>
}

class FileHandleSession implements StoredSessionHandle {
  readonly header: SessionHeader
  readonly session: Session
  readonly path: string
  #fh: FileHandle
  #buffer: string[] = []
  #detach: (() => void) | undefined
  #closed = false

  constructor(header: SessionHeader, session: Session, path: string, fh: FileHandle) {
    this.header = header
    this.session = session
    this.path = path
    this.#fh = fh
  }

  attach(): () => void {
    if (this.#detach !== undefined) return this.#detach
    const detach = this.session.onAppend((event) => {
      this.#buffer.push(`${JSON.stringify(event)}\n`)
    })
    this.#detach = () => {
      detach()
      this.#detach = undefined
    }
    return this.#detach
  }

  async flush(): Promise<void> {
    if (this.#closed) throw new Error(`session "${this.session.id}" is closed`)
    if (this.#buffer.length === 0) return
    const payload = this.#buffer.join('')
    this.#buffer = []
    await this.#fh.write(payload)
    await this.#fh.sync()
  }

  async close(): Promise<void> {
    if (this.#closed) return
    await this.flush()
    this.#detach?.()
    this.#closed = true
    await this.#fh.close()
  }
}

function headerLine(header: SessionHeader): string {
  return `${JSON.stringify({ type: HEADER_TYPE, ...header })}\n`
}

function sessionPath(root: string, id: string): string {
  return join(root, id, FILE)
}

export class SessionStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  async create(id: string, meta: Omit<SessionHeader, 'version' | 'id' | 'createdAt'> = {}): Promise<StoredSessionHandle> {
    const dir = join(this.root, id)
    await mkdir(dir, { recursive: true })
    const header: SessionHeader = {
      version: 1,
      id,
      createdAt: Date.now(),
      ...meta,
    }
    const path = sessionPath(this.root, id)
    await writeFile(path, headerLine(header), { flag: 'wx' })
    const fh = await open(path, 'a')
    return new FileHandleSession(header, new Session(id), path, fh)
  }

  async open(id: string, options: { repair?: boolean } = {}): Promise<StoredSessionHandle> {
    const repair = options.repair ?? true
    const path = sessionPath(this.root, id)
    const text = await readFile(path, 'utf8')
    const lines = text.split('\n').filter(line => line.length > 0)
    if (lines.length === 0) throw new Error(`session "${id}" has no header`)

    let header: SessionHeader
    try {
      const raw = JSON.parse(lines[0]!) as StoredHeaderLine
      if (raw.type !== HEADER_TYPE || raw.version !== 1 || raw.id !== id) throw new Error('invalid header')
      header = {
        version: 1,
        id: raw.id,
        createdAt: raw.createdAt,
        ...raw.cwd === undefined ? {} : { cwd: raw.cwd },
        ...raw.parentSession === undefined ? {} : { parentSession: raw.parentSession },
        ...raw.isSeeded === undefined ? {} : { isSeeded: raw.isSeeded },
      }
    } catch (error) {
      throw new Error(`session "${id}" has an invalid header: ${error instanceof Error ? error.message : String(error)}`)
    }

    const events: SessionEvent[] = []
    let truncated = false
    for (let index = 1; index < lines.length; index += 1) {
      let event: SessionEvent
      try {
        event = JSON.parse(lines[index]!) as SessionEvent
      } catch {
        truncated = true
        break
      }
      if (event.seq !== events.length) {
        truncated = true
        break
      }
      events.push(deepFreeze(event))
    }

    const session = Session.restore(id, events)
    const openTurn = repair ? this.#openTurn(session) : undefined
    if (openTurn !== undefined) {
      session.append('turn/end', {
        turn: openTurn,
        reason: { kind: 'interrupted' },
      })
    }

    // 截断或修复后把当前有效前缀写成新文件，避免下次继续读到坏尾。
    if (truncated || openTurn !== undefined) {
      const valid = [headerLine(header), ...session.events.map(event => `${JSON.stringify(event)}\n`)].join('')
      const temp = `${path}.tmp`
      await writeFile(temp, valid)
      await rename(temp, path)
    }

    const fh = await open(path, 'a')
    return new FileHandleSession(header, session, path, fh)
  }

  async list(): Promise<SessionHeader[]> {
    const dirs = await readdir(this.root, { withFileTypes: true })
    const headers: SessionHeader[] = []
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue
      try {
        const handle = await this.open(entry.name)
        headers.push(handle.header)
        await handle.close()
      } catch {
        // 坏会话不阻塞列表。
      }
    }
    return headers.sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * 从源会话复制前缀生成子会话。
   * 若前缀末尾有未闭合 turn，追加 `forked` closer；再追加继承标记。
   */
  async fork(sourceId: string, childId: string, atSeq?: number): Promise<StoredSessionHandle> {
    const source = await this.open(sourceId, { repair: false })
    await source.close()
    const all = source.session.events
    const cut = atSeq ?? all.length - 1
    if (!Number.isSafeInteger(cut) || cut < -1 || cut >= all.length) {
      throw new RangeError(`fork boundary ${String(atSeq)} is outside the source log`)
    }

    const seed: SessionEvent[] = all.filter(event => event.seq <= cut).map(event => deepFreeze(structuredClone(event)))
    const lastTurnStart = [...seed].reverse().find(event => event.type === 'turn/start')
    if (lastTurnStart !== undefined) {
      const hasEnd = seed.some(event => event.type === 'turn/end' && event.data.turn === lastTurnStart.data.turn)
      if (!hasEnd) {
        seed.push(deepFreeze({
          type: 'turn/end',
          seq: seed.length,
          time: Date.now(),
          data: { turn: lastTurnStart.data.turn, reason: { kind: 'forked' } },
        }) as SessionEvent)
      }
    }
    seed.push(deepFreeze({
      type: 'session/end-seed',
      seq: seed.length,
      time: Date.now(),
      data: { inherited: true },
    }) as SessionEvent)

    const dir = join(this.root, childId)
    await mkdir(dir, { recursive: true })
    const header: SessionHeader = {
      version: 1,
      id: childId,
      createdAt: Date.now(),
      parentSession: sourceId,
      isSeeded: true,
    }
    const path = sessionPath(this.root, childId)
    await writeFile(path, [headerLine(header), ...seed.map(event => `${JSON.stringify(event)}\n`)].join(''), { flag: 'wx' })
    const fh = await open(path, 'a')
    return new FileHandleSession(header, Session.restore(childId, seed), path, fh)
  }

  #openTurn(session: Session): number | undefined {
    const lastStart = [...session.events].reverse().find(event => event.type === 'turn/start')
    if (lastStart === undefined) return undefined
    const ended = session.events.some(
      event => event.type === 'turn/end' && event.data.turn === lastStart.data.turn,
    )
    return ended ? undefined : lastStart.data.turn
  }
}
