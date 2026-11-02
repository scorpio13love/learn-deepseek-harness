/**
 * s11 demo：用 mini Cordis 组装 session/tools/loop 三个插件。
 *
 * 不调用模型；本课关注插件生命周期、依赖注入、事件分发与 scope。
 */

import { Context, Service } from './index.ts'
import type { Disposer } from './index.ts'

class SessionService extends Service {
  readonly events: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  append(event: string): void {
    this.events.push(event)
  }
}

class ToolsService extends Service {
  readonly names = ['calc', 'read']

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
}

async function main(): Promise<void> {
  const root = new Context()

  await root.plugin(SessionService)
  await root.plugin(ToolsService)

  const loopPlugin = async (ctx: Context) => {
    const sessions = ctx.require<SessionService>('sessions')
    const tools = ctx.require<ToolsService>('tools')
    ctx.effect(() => {
      console.log('[loop] mounted with tools:', tools.names)
      return () => console.log('[loop] unmounted')
    })
    ctx.on('loop/step', (step) => {
      sessions.append(`step:${String(step)}`)
      console.log('[loop] step', step)
    })
    ctx.on('prompt', async (text, next) => {
      return `${String(await (next as () => Promise<string>)())}\n[policy] tools=${tools.names.join(',')}`
    })
    // waterfall listener 通过闭包访问 service。
    console.log('[loop] ready, sessions:', sessions.events.length)
  }
  Object.defineProperty(loopPlugin, 'name', { value: 'loop' })
  ;(loopPlugin as typeof loopPlugin & { inject: string[] }).inject = ['sessions', 'tools']

  const fiber = await root.plugin(loopPlugin)

  root.emit('loop/step', 1)
  const prompt = await root.waterfall('prompt', ['hello'], () => 'base prompt')
  console.log('waterfall result:\n' + prompt)

  const agentScope = root.createScope('agent-1')
  const seen: string[] = []
  root.on('tool/call', name => seen.push(`global:${String(name)}`))
  agentScope.on('tool/call', name => seen.push(`scoped:${String(name)}`), { scope: 'agent-1' })
  root.emit('tool/call', 'calc')
  agentScope.emit('tool/call', 'read')
  console.log('scope seen:', seen)

  fiber.dispose()
  console.log('after fiber dispose, sessions events:', root.require<SessionService>('sessions').events)
  console.log('loop service still there?', root.get('loop'))

  root.dispose()
  console.log('after root dispose, sessions?', root.get('sessions'))

  // 事件监听器可逆副作用。
  const root2 = new Context()
  const log: Disposer = root2.on('ping', () => console.log('ping!'))
  root2.emit('ping')
  log()
  root2.emit('ping')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
