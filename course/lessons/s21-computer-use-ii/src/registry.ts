/**
 * 单槽位 computer-use 注册表（与 s20 相同）。
 *
 * 之所以复制而不是 import s20，是为了让每一课都能单独拷贝、单独运行；
 * 代价是两处实现要保持同步。README 里把这点写成了显式取舍。
 */

import { CuaError } from './types.ts'
import type { ComputerUseProvider, CuaSession } from './types.ts'

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
  private readonly sessions = new Map<CuaSession, object>()

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
  async openSession(options?: { sessionId?: string }): Promise<CuaSession> {
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

    const owned: CuaSession[] = []
    for (const [session, token] of this.sessions) {
      if (token === state.token) {
        owned.push(session)
        this.sessions.delete(session)
      }
    }
    await Promise.all(owned.map(session => (session.closed ? undefined : session.close())))
  }
}
