/** s17 的 headless SDK server：stdout 只输出 JSON-RPC 帧。 */

import { JsonRpcPeer } from './jsonrpc.ts'
import { SdkServer } from './sdk.ts'
import { createDeepSeekProvider, LlmRuntime } from './index.ts'

const runtime = new LlmRuntime()
runtime.register(createDeepSeekProvider())
const peer = new JsonRpcPeer(process.stdin, process.stdout)
new SdkServer(peer, () => runtime.createModel('deepseek', 'deepseek-flash'))
process.stderr.write('sdk-server ready\n')
