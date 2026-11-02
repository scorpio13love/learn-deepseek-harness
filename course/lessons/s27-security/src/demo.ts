/** s27 demo：五种边界一次跑完，并输出 redact 后的审计日志。 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FailClosedApproval, allowListApproval } from './approval.ts'
import { CuaAccess, CuaDeniedError } from './cua.ts'
import { truncateText } from './truncate.ts'
import { SecureTools } from './tools.ts'
import { Workspace } from './workspace.ts'

const base = await mkdtemp(join(tmpdir(), 'dsh-s27-demo-'))
const root = join(base, 'workspace')
const outside = join(base, 'outside')
await mkdir(root)
await mkdir(outside)
await writeFile(join(outside, 'secret.txt'), 'outside secret\n')
await writeFile(join(root, 'notes.md'), '# notes\nTODO: rotate token=sk-demo-1234567890\n')
await writeFile(join(root, 'big.txt'), '长'.repeat(10_000))
try {
  await symlink(outside, join(root, 'public-link'))
} catch {
  // 某些文件系统不允许 symlink；demo 继续跑其余边界。
}

const workspace = await Workspace.open(root)
const approval = allowListApproval(
  request => (request.args as { path?: string }).path === 'notes.md',
  { timeoutMs: 200 },
)
const tools = new SecureTools({ workspace, approval, maxOutputChars: 120, now: () => 1_700_000_000_000 })

const results = {
  readInside: await tools.readFile('notes.md'),
  longOutput: await tools.readFile('big.txt'),
  escapeParent: await tools.readFile('../outside/secret.txt'),
  escapeSymlink: await tools.readFile('public-link/secret.txt'),
  sensitiveFile: await tools.readFile('.env'),
  writeApproved: await tools.writeFile('notes.md', '# notes\nupdated\n'),
  writeDenied: await tools.writeFile('draft.md', 'nope\n'),
}

const cua = new CuaAccess()
cua.grant({ appId: 'com.apple.calculator', bundleId: 'com.apple.calculator', actions: ['read-screen', 'click'] })
let executorCalls = 0
const cuaResults: unknown[] = []
try {
  await cua.authorize(
    { appId: 'com.apple.calculator', bundleId: 'com.apple.calculator', action: 'click' },
    () => { executorCalls += 1; cuaResults.push('clicked calculator') },
  )
} catch (error) {
  cuaResults.push(error instanceof Error ? error.message : String(error))
}
try {
  await cua.authorize(
    { appId: 'com.apple.terminal', action: 'click' },
    () => { executorCalls += 1; cuaResults.push('clicked terminal') },
  )
} catch (error) {
  cuaResults.push(error instanceof CuaDeniedError ? `${error.code}: ${error.message}` : String(error))
}

console.log('--- boundary results ---')
console.log(JSON.stringify({
  ...results,
  truncationPreview: truncateText('x'.repeat(50), 20),
  cuaResults,
  executorCalls,
}, null, 2))
console.log('\n--- redacted audit log ---')
console.log(JSON.stringify(tools.log.entries, null, 2))
console.log('\n--- approval ledger (args redacted) ---')
console.log(JSON.stringify(approval.ledger, null, 2))

// 证明 demo 的审批服务在超时/异常时也是 denied。
const timeoutApproval = new FailClosedApproval(() => new Promise(() => {}), { timeoutMs: 20 })
console.log('\napproval timeout ->', await timeoutApproval.request({
  id: 'a-timeout',
  toolName: 'bash',
  summary: 'run a command',
  args: { command: 'echo hi', token: 'sk-timeout-secret' },
}))

await rm(base, { recursive: true, force: true })
