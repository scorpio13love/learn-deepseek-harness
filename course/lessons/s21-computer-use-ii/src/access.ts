/**
 * 授权存储：持久授权与会话授权分开。
 *
 * 真实 DSH 的 `CuaPermissionStore` 把「始终允许」写进 profile 域存储，
 * 会话授权只留在内存；撤销会让后续分派立即失败，但已经派发的输入不会回滚。
 * 本课把这两级显式建模，并允许注入一个 `AccessStorage` 模拟 profile 持久化。
 */

import { CuaError } from './types.ts'
import type { AccessScope } from './types.ts'

/** 持久授权的存储 seam；真实实现是 profile 下的 domain storage。 */
export interface AccessStorage {
  load(): readonly string[]
  save(appIds: readonly string[]): void
}

/** 内存存储；测试用它模拟「重启后仍然存在」。 */
export function createMemoryStorage(initial: readonly string[] = []): AccessStorage {
  let state = [...initial]
  return {
    load: () => [...state],
    save: appIds => {
      state = [...appIds]
    },
  }
}

export interface GrantOptions {
  readonly scope: AccessScope
  /** scope 为 session 时必填；persistent 时忽略。 */
  readonly sessionId?: string
}

export class ApplicationAccess {
  private readonly persistent = new Set<string>()
  private readonly sessions = new Map<string, Set<string>>()
  private readonly storage: AccessStorage | undefined

  constructor(options: { readonly storage?: AccessStorage } = {}) {
    this.storage = options.storage
    if (this.storage !== undefined) {
      for (const appId of this.storage.load()) this.persistent.add(appId)
    }
  }

  /** 有 profile 存储才能持久授权。 */
  get persistentAvailable(): boolean {
    return this.storage !== undefined
  }

  get persistentGrants(): readonly string[] {
    return [...this.persistent].sort()
  }

  grantsFor(sessionId: string): readonly string[] {
    return [...(this.sessions.get(sessionId) ?? [])].sort()
  }

  /** 授权一个应用。persistent 需要存储；session 需要 sessionId。 */
  grant(appId: string, options: GrantOptions): void {
    this.requireAppId(appId)
    if (options.scope === 'persistent') {
      if (this.storage === undefined) {
        throw new CuaError(
          'PERSISTENCE_UNAVAILABLE',
          'persistent grants require profile storage; ask again for this session instead',
        )
      }
      this.persistent.add(appId)
      this.storage.save([...this.persistent].sort())
      return
    }
    if (options.scope !== 'session') {
      throw new CuaError('INVALID_ARGUMENT', `unknown grant scope "${String(options.scope)}"`)
    }
    const sessionId = options.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new CuaError('INVALID_ARGUMENT', 'session grants require a non-empty sessionId')
    }
    let grants = this.sessions.get(sessionId)
    if (grants === undefined) {
      grants = new Set()
      this.sessions.set(sessionId, grants)
    }
    grants.add(appId)
  }

  /**
   * 撤销。
   * - 传 sessionId：只撤该会话的 session 授权；
   * - 不传：同时撤持久授权与所有会话授权。
   * @returns 是否真的撤销了某项授权。
   */
  revoke(appId: string, options: { readonly sessionId?: string } = {}): boolean {
    if (options.sessionId !== undefined) {
      const grants = this.sessions.get(options.sessionId)
      if (grants === undefined) return false
      const removed = grants.delete(appId)
      if (grants.size === 0) this.sessions.delete(options.sessionId)
      return removed
    }
    let removed = this.persistent.delete(appId)
    if (removed) this.storage?.save([...this.persistent].sort())
    for (const [sessionId, grants] of this.sessions) {
      if (grants.delete(appId)) removed = true
      if (grants.size === 0) this.sessions.delete(sessionId)
    }
    return removed
  }

  /** 持久授权对所有会话有效；会话授权只对授权时的 session 有效。 */
  isAllowed(appId: string, sessionId: string): boolean {
    return this.persistent.has(appId) || (this.sessions.get(sessionId)?.has(appId) ?? false)
  }

  /** 在读取 AX、截图或派发输入前调用；拒绝时 fail closed。 */
  check(appId: string, sessionId: string): void {
    if (!this.isAllowed(appId, sessionId)) {
      throw new CuaError(
        'APP_ACCESS_REQUIRED',
        `application "${appId}" is not authorized for session "${sessionId}"`,
      )
    }
  }

  /** 当前授权状态快照，便于展示与断言。 */
  snapshot(): { persistent: readonly string[]; sessions: Record<string, readonly string[]> } {
    const sessions: Record<string, readonly string[]> = {}
    for (const [sessionId, grants] of this.sessions) sessions[sessionId] = [...grants].sort()
    return { persistent: this.persistentGrants, sessions }
  }

  private requireAppId(appId: string): void {
    if (typeof appId !== 'string' || appId.length === 0) {
      throw new CuaError('INVALID_ARGUMENT', 'appId must be a non-empty string')
    }
  }
}
