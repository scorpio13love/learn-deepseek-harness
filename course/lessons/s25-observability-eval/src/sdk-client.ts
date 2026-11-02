/**
 * s18 · observability / eval：沿用前序课程的实现（本课改动见 README）。
 */

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
