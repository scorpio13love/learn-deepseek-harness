/** s17 的 SDK client：spawn server，读写 JSON-RPC。 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { JsonRpcPeer } from './jsonrpc.ts'

export interface SdkClient {
  peer: JsonRpcPeer
  close(): void
}

export function startSdkClient(): SdkClient {
  const server = fileURLToPath(new URL('./sdk-server.ts', import.meta.url))
  const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'inherit'] })
  const peer = new JsonRpcPeer(child.stdout, child.stdin)
  return {
    peer,
    close: () => {
      child.kill()
      peer.close()
    },
  }
}
