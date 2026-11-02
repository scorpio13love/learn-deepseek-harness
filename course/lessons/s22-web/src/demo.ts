/**
 * s16 · web：沿用前序课程的实现（本课改动见 README）。
 */

import { createMessage, createTextMessage, Session, SessionProjection, SessionWebServer } from './index.ts'

async function main(): Promise<void> {
  const session = new Session('web-demo')
  const projection = new SessionProjection(session)
  const server = new SessionWebServer(session, projection)
  const { url } = await server.start(0)
  console.log('open:', url)
  console.log('snapshot:', projection.snapshot)

  let turn = 1
  const timer = setInterval(() => {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', { message: createTextMessage('user', `question ${turn}`) }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }] }),
      stream: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    turn += 1
    if (turn > 3) clearInterval(timer)
  }, 1_000)

  await new Promise(resolve => setTimeout(resolve, 4_500))
  clearInterval(timer)
  console.log('final snapshot:', projection.snapshot)
  await server.close()
  projection.dispose()
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
