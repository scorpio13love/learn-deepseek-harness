/**
 * s18 · observability / eval：沿用前序课程的实现（本课改动见 README）。
 */

import { JsonRpcPeer } from './jsonrpc.ts'
import { SdkServer } from './sdk.ts'
import { createDeepSeekProvider, LlmRuntime } from './index.ts'

const runtime = new LlmRuntime()
runtime.register(createDeepSeekProvider())
const peer = new JsonRpcPeer(process.stdin, process.stdout)
new SdkServer(peer, () => runtime.createModel('deepseek', 'deepseek-flash'))
process.stderr.write('sdk-server ready\n')
