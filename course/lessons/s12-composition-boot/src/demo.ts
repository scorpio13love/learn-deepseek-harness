/**
 * s12 · composition / boot：沿用前序课程的实现（本课改动见 README）。
 */

import { Boot, composeProfile } from './boot.ts'
import type { Bundle, ConfigPatch, Profile } from './boot.ts'
import { Service } from './index.ts'
import type { Context } from './index.ts'

class SessionService extends Service {
  readonly events: string[] = []
  constructor(ctx: Context) { super(ctx, 'sessions') }
}

class ToolsService extends Service {
  constructor(ctx: Context) { super(ctx, 'tools') }
}

const base: Bundle = {
  name: 'base',
  patches: [{
    insert: [
      { id: 'session', name: 'session' },
      { id: 'tools', name: 'tools' },
      { id: 'loop', name: 'loop', config: { label: 'base', maxSteps: 8 } },
    ],
  }],
}

const mode: Bundle = {
  name: 'headless',
  patches: [{
    replace: [{ id: 'loop', config: { label: 'headless', maxSteps: 4 } }],
    insert: [{ id: 'metrics', name: 'metrics', config: { enabled: true } }],
  }],
}

const profilePatch: ConfigPatch = {
  disable: ['tools'],
  insert: [{ id: 'extra', name: 'loop', config: { label: 'extra' } }],
}

const profile: Profile = {
  name: 'demo',
  bundles: [base, mode],
  patch: profilePatch,
}

async function main(): Promise<void> {
  const entries = composeProfile(profile)
  console.log('=== composed entries ===')
  console.log(JSON.stringify(entries, null, 2))

  const boot = new Boot()
    .register('session', SessionService)
    .register('tools', ToolsService)
    .register('loop', (ctx: Context) => {
      console.log('[loop] config:', ctx.config)
      ctx.on('loop/step', step => {
        ctx.require<SessionService>('sessions').events.push(`step:${String(step)}`)
      })
    })
    .register('metrics', (ctx: Context) => {
      console.log('[metrics] config:', ctx.config)
    })

  const ctx = await boot.start(entries, { required: ['loop'] })
  ctx.emit('loop/step', 1)
  console.log('sessions:', ctx.require<SessionService>('sessions').events)
  console.log('dump:', JSON.stringify(boot.dumpConfig(entries)))
  boot.dispose()

  console.log('\n=== required failure ===')
  const broken = new Boot().register('loop', () => {})
  try {
    await broken.start([{ id: 'loop', name: 'loop', disabled: true }], { required: ['loop'] })
  } catch (error) {
    console.log('expected:', error instanceof Error ? error.message : String(error))
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
