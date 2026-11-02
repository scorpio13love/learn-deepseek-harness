/**
 * 单槽位 computer-use 注册表。
 *
 * 对应真实 DSH 的 `ComputerUseRegistry`：只保存一个 provider 名字，
 * 第二次注册（包括同名）失败；dispose 先关会话再释放槽位。
 */

import { CuaError } from './types.ts'
import type { ComputerUseProvider, CuaDesktopSession } from './types.ts'

interface RegistrationState {
  readonly name: string
  readonly provider: ComputerUseProvider
  readonly token: object
  disposed: boolean
}

export interface ComputerUseRegistration {
  readonly name: string
  readonly dispose: () => Promise<void>
}

export class ComputerUseProviderRegistry {
  private registration: RegistrationState | undefined
  private readonly sessions = new Map<CuaDesktopSession, object>()

  get providerName(): string | undefined {
    return this.registration?.name
  }

  get hasProvider(): boolean {
    return this.registration !== undefined
  }

  get activeSessionCount(): number {
    let count = 0
    for (const [session, token] of this.sessions) {
      if (!session.closed && token === this.registration?.token) count += 1
    }
    return count
  }

  /** @throws CuaError PROVIDER_ALREADY_REGISTERED（含同名重复注册）。 */
  register(provider: ComputerUseProvider): ComputerUseRegistration {
    if (this.registration !== undefined) {
      throw new CuaError(
        'PROVIDER_ALREADY_REGISTERED',
        `computer use provider "${this.registration.name}" is already registered`,
      )
    }
    if (typeof provider.name !== 'string' || provider.name.length === 0) {
      throw new CuaError('INVALID_ARGUMENT', 'provider.name must be a non-empty string')
    }
    if (typeof provider.open !== 'function') {
      throw new CuaError('INVALID_ARGUMENT', `provider "${provider.name}" does not implement open()`)
    }

    const state: RegistrationState = { name: provider.name, provider, token: {}, disposed: false }
    this.registration = state
    return { name: state.name, dispose: () => this.release(state) }
  }

  /** @throws CuaError PROVIDER_NOT_REGISTERED：没有 provider，或打开期间被释放。 */
  async openSession(options?: { sessionId?: string }): Promise<CuaDesktopSession> {
    const state = this.registration
    if (state === undefined) {
      throw new CuaError('PROVIDER_NOT_REGISTERED', 'no computer use provider is registered')
    }

    const session = await state.provider.open(options)
    if (state.disposed || this.registration !== state) {
      await session.close()
      throw new CuaError('PROVIDER_NOT_REGISTERED', 'provider was disposed while a session was opening')
    }
    this.sessions.set(session, state.token)
    return session
  }

  async dispose(): Promise<void> {
    if (this.registration !== undefined) await this.release(this.registration)
  }

  private async release(state: RegistrationState): Promise<void> {
    if (state.disposed) return
    state.disposed = true
    if (this.registration === state) this.registration = undefined

    const owned: CuaDesktopSession[] = []
    for (const [session, token] of this.sessions) {
      if (token === state.token) {
        owned.push(session)
        this.sessions.delete(session)
      }
    }
    await Promise.all(owned.map(session => (session.closed ? undefined : session.close())))
  }
}
