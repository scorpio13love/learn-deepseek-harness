/**
 * s17 · SDK / headless：沿用前序课程的实现（本课改动见 README）。
 */

import { startSdkClient } from './sdk-client.ts'

async function main(): Promise<void> {
  const client = startSdkClient()
  try {
    client.peer.onNotification('session/event', (params) => {
      const data = params as { event: { type: string } }
      console.log('event:', data.event.type)
    })
    console.log('create:', await client.peer.request('session/create', { id: 'demo' }))
    const result = await client.peer.request('prompt', { sessionId: 'demo', text: '用一句话说明 SDK 的作用。' })
    console.log('result:', result)
    await client.peer.request('shutdown')
  } finally {
    client.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
