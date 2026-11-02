/**
 * s14 · subagents / presets：沿用前序课程的实现（本课改动见 README）。
 */

import { Context } from './kernel.ts'
import type { Fiber, Plugin } from './kernel.ts'

export interface ConfigEntry {
  id: string
  name: string
  config?: unknown
  disabled?: boolean
}

export interface ConfigPatch {
  insert?: ConfigEntry[]
  /** 按 id 替换整个 config；不是 merge。 */
  replace?: Array<{ id: string; config: unknown }>
  disable?: string[]
  remove?: string[]
}

export interface Bundle {
  name: string
  patches: ConfigPatch[]
}

export interface Profile {
  name: string
  bundles: Bundle[]
  patch?: ConfigPatch
}

function cloneEntry(entry: ConfigEntry): ConfigEntry {
  return structuredClone(entry)
}

export function applyPatch(entries: readonly ConfigEntry[], patch: ConfigPatch, source = 'patch'): ConfigEntry[] {
  const next = entries.map(cloneEntry)

  for (const inserted of patch.insert ?? []) {
    if (next.some(entry => entry.id === inserted.id)) {
      throw new Error(`${source}: insert id "${inserted.id}" already exists`)
    }
    next.push(cloneEntry(inserted))
  }

  for (const change of patch.replace ?? []) {
    const entry = next.find(candidate => candidate.id === change.id)
    if (entry === undefined) throw new Error(`${source}: replace id "${change.id}" does not exist`)
    entry.config = structuredClone(change.config)
  }

  for (const id of patch.disable ?? []) {
    const entry = next.find(candidate => candidate.id === id)
    if (entry === undefined) throw new Error(`${source}: disable id "${id}" does not exist`)
    entry.disabled = true
  }

  for (const id of patch.remove ?? []) {
    const index = next.findIndex(candidate => candidate.id === id)
    if (index < 0) throw new Error(`${source}: remove id "${id}" does not exist`)
    next.splice(index, 1)
  }

  return next
}

/** 按 bundle 顺序、profile patch 顺序叠加；后者覆盖前者。 */
export function composeProfile(profile: Profile): ConfigEntry[] {
  let entries: ConfigEntry[] = []
  for (const bundle of profile.bundles) {
    for (const [index, patch] of bundle.patches.entries()) {
      entries = applyPatch(entries, patch, `bundle ${bundle.name}#${index}`)
    }
  }
  if (profile.patch !== undefined) entries = applyPatch(entries, profile.patch, `profile ${profile.name}`)
  return entries
}

export class Boot {
  #ctx = new Context()
  #plugins = new Map<string, Plugin>()
  #fibers = new Map<string, Fiber>()

  register(name: string, plugin: Plugin): this {
    if (this.#plugins.has(name)) throw new Error(`plugin "${name}" is already registered`)
    this.#plugins.set(name, plugin)
    return this
  }

  async start(entries: readonly ConfigEntry[], options: { required?: readonly string[] } = {}): Promise<Context> {
    try {
      for (const entry of entries) {
        if (entry.disabled === true) continue
        const plugin = this.#plugins.get(entry.name)
        if (plugin === undefined) throw new Error(`entry "${entry.id}" names unregistered plugin "${entry.name}"`)
        const fiber = await this.#ctx.plugin(plugin, { config: entry.config })
        this.#fibers.set(entry.id, fiber)
      }

      for (const id of options.required ?? []) {
        const entry = entries.find(candidate => candidate.id === id)
        if (entry === undefined || entry.disabled === true || !this.#fibers.has(id)) {
          throw new Error(`required entry "${id}" is missing or disabled`)
        }
      }
      return this.#ctx
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  dumpConfig(entries: readonly ConfigEntry[]): ConfigEntry[] {
    return entries.map(cloneEntry)
  }

  dispose(): void {
    for (const fiber of this.#fibers.values()) fiber.dispose()
    this.#fibers.clear()
    this.#ctx.dispose()
  }
}
