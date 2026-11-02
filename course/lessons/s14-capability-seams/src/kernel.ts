/**
 * s13 · capability seams：沿用前序课程的实现（本课改动见 README）。
 */

export type Disposer = () => void
export type Listener = (...args: unknown[]) => unknown

export interface PluginFunction {
  (ctx: Context): void | Promise<void>
  readonly name?: string
  readonly inject?: readonly string[]
}

export type PluginClass = new (ctx: Context) => object

export type Plugin = PluginFunction | PluginClass

interface Registration {
  listener: Listener
  scope: unknown
}

export type EventMode = 'emit' | 'waterfall' | 'serial' | 'bail'

export class Fiber {
  #disposers: Disposer[] = []
  #disposed = false

  add(disposer: Disposer): void {
    if (this.#disposed) {
      disposer()
      return
    }
    this.#disposers.push(disposer)
  }

  get disposed(): boolean {
    return this.#disposed
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const disposer of this.#disposers.reverse()) {
      try {
        disposer()
      } catch {
        // 卸载失败不能阻止其他资源释放。
      }
    }
    this.#disposers = []
  }
}

export class Context {
  readonly fiber = new Fiber()
  readonly parent: Context | undefined
  readonly scope: unknown
  readonly config: unknown
  #services = new Map<string, unknown>()
  #events = new Map<string, Registration[]>()
  #children = new Set<Context>()

  constructor(parent?: Context, scope?: unknown, config?: unknown) {
    this.parent = parent
    this.scope = scope
    this.config = config
    if (parent !== undefined) parent.#children.add(this)
  }

  get<T = unknown>(key: string): T | undefined {
    const own = this.#services.get(key)
    if (own !== undefined) return own as T
    return this.parent?.get<T>(key)
  }

  require<T = unknown>(key: string): T {
    const service = this.get<T>(key)
    if (service === undefined) throw new Error(`missing service "${key}"`)
    return service
  }

  provide<T>(key: string, service: T): Disposer {
    if (this.#services.has(key)) throw new Error(`service "${key}" is already provided`)
    this.#services.set(key, service)
    return () => {
      if (this.#services.get(key) === service) this.#services.delete(key)
    }
  }

  /** 挂载一个函数插件或 Service 类；apply 完成前插件已绑定 fiber。 */
  async plugin(plugin: Plugin, options: { config?: unknown } = {}): Promise<Fiber> {
    const child = new Context(this, this.scope, options.config)
    const fiber = child.fiber
    const finish = (): void => {
      this.fiber.add(() => fiber.dispose())
    }

    const isClass = typeof plugin === 'function' && /^class\s/.test(Function.prototype.toString.call(plugin))
    if (typeof plugin === 'function' && !isClass) {
      const fn = plugin as PluginFunction
      for (const key of fn.inject ?? []) {
        if (this.get(key) === undefined) {
          fiber.dispose()
          throw new Error(`plugin "${fn.name ?? '<anonymous>'}" requires service "${key}"`)
        }
      }
      try {
        await fn(child)
      } catch (error) {
        fiber.dispose()
        throw error
      }
      finish()
      return fiber
    }

    try {
      // 课程简化：Service 注册在挂载它的上下文（通常是 root），
      // 而不是每次 plugin 调用产生的子 context；这样兄弟插件能按 key 找到它。
      const instance = new (plugin as PluginClass)(this)
      // Service 子类在构造函数中调用 ctx.provide；其他类可能用 apply 模式。
      const apply = (instance as { apply?: (ctx: Context) => void | Promise<void> }).apply
      if (apply !== undefined) await apply.call(instance, child)
    } catch (error) {
      fiber.dispose()
      throw error
    }
    finish()
    return fiber
  }

  /** 注册一个可逆副作用；fiber dispose 时逆序撤销。 */
  effect(effect: () => Disposer | void): Disposer {
    const disposer = effect()
    if (disposer === undefined) return () => {}
    let done = false
    const dispose = (): void => {
      if (done) return
      done = true
      disposer()
    }
    this.fiber.add(dispose)
    return dispose
  }

  on(event: string, listener: Listener, options: { scope?: unknown } = {}): Disposer {
    const registrations = this.#events.get(event) ?? []
    const registration: Registration = { listener, scope: options.scope }
    registrations.push(registration)
    this.#events.set(event, registrations)
    const dispose = (): void => {
      const index = registrations.indexOf(registration)
      if (index >= 0) registrations.splice(index, 1)
    }
    this.fiber.add(dispose)
    return dispose
  }

  /** 创建一个带 scope 的子上下文；scoped listener 只接收同 scope 的事件。 */
  createScope(scope: unknown): Context {
    return new Context(this, scope)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const registration of this.#listeners(event)) {
      if (!this.#matches(registration)) continue
      registration.listener(...args)
    }
  }

  async waterfall<T>(event: string, args: readonly unknown[], fallback: () => Promise<T> | T): Promise<T> {
    const listeners = this.#listeners(event).filter(registration => this.#matches(registration))
    const dispatch = async (index: number): Promise<T> => {
      const registration = listeners[index]
      if (registration === undefined) return fallback()
      return registration.listener(...args, () => dispatch(index + 1)) as T
    }
    return dispatch(0)
  }

  async serial<T>(event: string, ...args: unknown[]): Promise<T | undefined> {
    let last: T | undefined
    for (const registration of this.#listeners(event)) {
      if (!this.#matches(registration)) continue
      const value = await registration.listener(...args) as T | undefined
      if (value !== undefined) last = value
    }
    return last
  }

  bail<T>(event: string, ...args: unknown[]): T | undefined {
    for (const registration of this.#listeners(event)) {
      if (!this.#matches(registration)) continue
      const value = registration.listener(...args) as T | undefined
      if (value !== undefined) return value
    }
    return undefined
  }

  dispose(): void {
    for (const child of [...this.#children]) child.dispose()
    this.#children.clear()
    if (this.parent !== undefined) this.parent.#children.delete(this)
    this.fiber.dispose()
    this.#events.clear()
    this.#services.clear()
  }

  #listeners(event: string): Registration[] {
    const root = this.#root()
    return root.#collect(event)
  }

  #root(): Context {
    let current: Context = this
    while (current.parent !== undefined) current = current.parent
    return current
  }

  #collect(event: string, out: Registration[] = []): Registration[] {
    out.push(...(this.#events.get(event) ?? []))
    for (const child of this.#children) child.#collect(event, out)
    return out
  }

  #matches(registration: Registration): boolean {
    return registration.scope === undefined || registration.scope === this.scope
  }
}

export abstract class Service {
  protected constructor(ctx: Context, key: string) {
    ctx.provide(key, this)
  }
}
