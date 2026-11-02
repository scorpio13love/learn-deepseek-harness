/** CUA 应用授权：显式 allowlist，拒绝发生在 executor 之前。 */

export type CuaActionKind = 'read-screen' | 'click' | 'type' | 'launch'

const ACTION_KINDS: readonly CuaActionKind[] = ['read-screen', 'click', 'type', 'launch']

export interface CuaAction {
  appId: string
  action: CuaActionKind
  /** 可选：macOS bundle id / Windows executable 等更强标识。 */
  bundleId?: string
  target?: string
}

export interface CuaGrant {
  appId: string
  bundleId?: string
  actions: CuaActionKind[]
}

export type CuaDenialCode =
  | 'UNKNOWN_APP'
  | 'INVALID_ACTION'
  | 'ACTION_NOT_GRANTED'
  | 'BUNDLE_MISMATCH'

export type CuaDecision =
  | { allowed: true }
  | { allowed: false; code: CuaDenialCode; reason: string }

export class CuaDeniedError extends Error {
  readonly code: CuaDenialCode

  constructor(code: CuaDenialCode, reason: string) {
    super(reason)
    this.name = 'CuaDeniedError'
    this.code = code
  }
}

export class CuaAccess {
  #grants = new Map<string, CuaGrant>()

  grant(grant: CuaGrant): void {
    if (grant.appId.trim() === '') throw new TypeError('appId must not be empty')
    this.#grants.set(grant.appId, {
      ...grant,
      actions: [...new Set(grant.actions)],
    })
  }

  check(action: CuaAction): CuaDecision {
    if (!ACTION_KINDS.includes(action.action)) {
      return { allowed: false, code: 'INVALID_ACTION', reason: `unknown action "${String(action.action)}"` }
    }
    const grant = this.#grants.get(action.appId)
    if (grant === undefined) {
      return { allowed: false, code: 'UNKNOWN_APP', reason: `app "${action.appId}" is not registered` }
    }
    if (grant.bundleId !== undefined && grant.bundleId !== action.bundleId) {
      return {
        allowed: false,
        code: 'BUNDLE_MISMATCH',
        reason: `app "${action.appId}" requires bundle "${grant.bundleId}"`,
      }
    }
    if (!grant.actions.includes(action.action)) {
      return {
        allowed: false,
        code: 'ACTION_NOT_GRANTED',
        reason: `app "${action.appId}" is not allowed to ${action.action}`,
      }
    }
    return { allowed: true }
  }

  /** 授权失败时抛错，保证 executor 不会被调用。 */
  async authorize<T>(action: CuaAction, executor: () => Promise<T> | T): Promise<T> {
    const decision = this.check(action)
    if (!decision.allowed) throw new CuaDeniedError(decision.code, decision.reason)
    return executor()
  }
}
