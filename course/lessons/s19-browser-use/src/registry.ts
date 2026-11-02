/**
 * 单槽位 provider 注册表。
 *
 * 真实 DSH 的 `BrowserUseRegistry` 只保存一个 provider 名字，并拒绝第二次注册
 * （包括同名重复注册）。它不包含任何浏览器操作 —— 操作属于 provider。
 * 这里补上「注册表拥有会话」的部分：dispose 时先关会话再释放槽位。
 */

import { BrowserError } from './types.ts'
import type { BrowserProvider, BrowserSession } from './types.ts'

interface RegistrationState {
  readonly name: string
  readonly provider: BrowserProvider
  /** 身份令牌：防止旧 disposer 误清掉后来注册的 provider。 */
  readonly token: object
  disposed: boolean
}

/** 注册成功后返回的句柄；dispose 幂等。 */
export interface BrowserProviderRegistration {
  readonly name: string
  /** 关闭该注册拥有的全部会话，然后释放槽位。可重复调用。 */
  readonly dispose: () => Promise<void>
}

export class BrowserProviderRegistry {
  private registration: RegistrationState | undefined
  private readonly sessions = new Map<BrowserSession, object>()

  /** 当前注册的 provider 名字；未注册时为 undefined。 */
  get providerName(): string | undefined {
    return this.registration?.name
  }

  /** 槽位是否被占用。 */
  get hasProvider(): boolean {
    return this.registration !== undefined
  }

  /** 该注册名下仍未关闭的会话数（用于验证 dispose 的清理行为）。 */
  get activeSessionCount(): number {
    let count = 0
    for (const [session, token] of this.sessions) {
      if (!session.closed && token === this.registration?.token) count += 1
    }
    return count
  }

  /**
   * 占用唯一槽位。
   * @throws BrowserError `PROVIDER_ALREADY_REGISTERED`：已有 provider（含同名）。
   */
  register(provider: BrowserProvider): BrowserProviderRegistration {
    if (this.registration !== undefined) {
      throw new BrowserError(
        'PROVIDER_ALREADY_REGISTERED',
        `browser provider "${this.registration.name}" is already registered`,
      )
    }
    if (typeof provider.name !== 'string' || provider.name.length === 0) {
      throw new BrowserError('INVALID_ARGUMENT', 'provider.name must be a non-empty string')
    }
    if (typeof provider.open !== 'function') {
      throw new BrowserError('INVALID_ARGUMENT', `provider "${provider.name}" does not implement open()`)
    }

    const state: RegistrationState = { name: provider.name, provider, token: {}, disposed: false }
    this.registration = state

    return {
      name: state.name,
      dispose: () => this.release(state),
    }
  }

  /**
   * 用已注册的 provider 打开会话，并把它登记为注册表所有。
   * @throws BrowserError `PROVIDER_NOT_REGISTERED`：没有 provider，或打开期间被释放。
   */
  async openSession(options?: { sessionId?: string }): Promise<BrowserSession> {
    const state = this.registration
    if (state === undefined) {
      throw new BrowserError('PROVIDER_NOT_REGISTERED', 'no browser provider is registered')
    }

    const session = await state.provider.open(options)
    if (state.disposed || this.registration !== state) {
      // 打开过程中 provider 被释放：不要留下孤儿浏览器。
      await session.close()
      throw new BrowserError('PROVIDER_NOT_REGISTERED', 'provider was disposed while a session was opening')
    }
    this.sessions.set(session, state.token)
    return session
  }

  /** 释放当前注册（如果有）；先关会话，再腾出槽位。 */
  async dispose(): Promise<void> {
    if (this.registration !== undefined) await this.release(this.registration)
  }

  private async release(state: RegistrationState): Promise<void> {
    if (state.disposed) return
    state.disposed = true

    // 只有仍是当前注册时才清空槽位；旧 token 的 disposer 不能踢掉新 provider。
    if (this.registration === state) this.registration = undefined

    const owned: BrowserSession[] = []
    for (const [session, token] of this.sessions) {
      if (token === state.token) {
        owned.push(session)
        this.sessions.delete(session)
      }
    }
    await Promise.all(owned.map(session => (session.closed ? undefined : session.close())))
  }
}
