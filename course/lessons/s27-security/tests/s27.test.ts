/** s27 离线测试：路径逃逸、审批拒绝、redaction、截断、CUA 授权。 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'

import { FailClosedApproval, allowListApproval } from '../src/approval.ts'
import { CuaAccess, CuaDeniedError } from '../src/cua.ts'
import { redactError, redactText, redactValue } from '../src/redact.ts'
import { SecureTools } from '../src/tools.ts'
import { truncateText } from '../src/truncate.ts'
import { Workspace } from '../src/workspace.ts'

interface Fixture {
  base: string
  root: string
  outside: string
  workspace: Workspace
}

async function setup(t: TestContext): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-s27-test-'))
  const root = join(base, 'workspace')
  const outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
  })
  return { base, root, outside, workspace: await Workspace.open(root) }
}

function code(expected: string) {
  return (error: unknown): boolean => (error as { code?: string }).code === expected
}

// ---------------------------------------------------------------------------
// 路径逃逸
// ---------------------------------------------------------------------------

test('workspace: parent and absolute escapes are rejected', async t => {
  const { workspace, outside } = await setup(t)
  await writeFile(join(outside, 'secret.txt'), 'outside')

  await assert.rejects(workspace.resolve('../outside/secret.txt'), code('PATH_ESCAPE'))
  await assert.rejects(workspace.readText('../outside/secret.txt'), code('PATH_ESCAPE'))
  await assert.rejects(workspace.readText(join(outside, 'secret.txt')), code('PATH_ESCAPE'))
  await assert.rejects(workspace.writeText('../outside/owned.txt', 'x'), code('PATH_ESCAPE'))
  await assert.rejects(workspace.resolve('bad\0path'), code('PATH_ESCAPE'))
})

test('workspace: sibling prefix is not inside the root', async t => {
  const { base, workspace } = await setup(t)
  const sibling = join(base, 'workspace-evil')
  await mkdir(sibling)
  await writeFile(join(sibling, 'secret.txt'), 'no')

  await assert.rejects(workspace.readText('../workspace-evil/secret.txt'), code('PATH_ESCAPE'))
})

test('workspace: symlink pointing outside is resolved and rejected', async t => {
  const { root, outside, workspace } = await setup(t)
  await writeFile(join(outside, 'secret.txt'), 'outside')
  try {
    await symlink(outside, join(root, 'public-link'))
  } catch (error) {
    t.skip(`symlink unavailable: ${String(error)}`)
    return
  }

  await assert.rejects(workspace.resolve('public-link/secret.txt'), code('PATH_ESCAPE'))
  await assert.rejects(workspace.readText('public-link/secret.txt'), code('PATH_ESCAPE'))
})

test('workspace: new nested files are allowed and created', async t => {
  const { workspace } = await setup(t)
  await workspace.writeText('new/dir/file.txt', 'hello')
  assert.equal(await workspace.readText('new/dir/file.txt'), 'hello')
  assert.equal(await workspace.exists('new/dir/file.txt'), true)
})

test('workspace: sensitive files are refused', async t => {
  const { workspace } = await setup(t)
  await assert.rejects(workspace.readText('.env'), code('SENSITIVE_FILE'))
  await assert.rejects(workspace.readText('keys/private.pem'), code('SENSITIVE_FILE'))
  await assert.rejects(workspace.readText('.git/config'), code('SENSITIVE_FILE'))
})

// ---------------------------------------------------------------------------
// 审批 fail-closed
// ---------------------------------------------------------------------------

test('approval: only explicit allowed-once passes', async () => {
  const allow = new FailClosedApproval(() => 'allowed-once')
  const deny = new FailClosedApproval(() => 'denied')
  const unknown = new FailClosedApproval(() => 'allow')
  const nothing = new FailClosedApproval(() => undefined)

  assert.equal(await allow.request({ id: '1', toolName: 'x', summary: 's', args: {} }), 'allowed-once')
  assert.equal(await deny.request({ id: '2', toolName: 'x', summary: 's', args: {} }), 'denied')
  assert.equal(await unknown.request({ id: '3', toolName: 'x', summary: 's', args: {} }), 'denied')
  assert.equal(await nothing.request({ id: '4', toolName: 'x', summary: 's', args: {} }), 'denied')
})

test('approval: throwing, timeout and abort all deny', async t => {
  const throwing = new FailClosedApproval(() => { throw new Error('UI crashed') })
  assert.equal(await throwing.request({ id: 'a', toolName: 'x', summary: 's', args: {} }), 'denied')

  const timeout = new FailClosedApproval(() => new Promise(() => {}), { timeoutMs: 10 })
  assert.equal(await timeout.request({ id: 'b', toolName: 'x', summary: 's', args: {} }), 'denied')
  assert.match(timeout.ledger.at(-1)?.reason ?? '', /timeout/)

  const controller = new AbortController()
  controller.abort()
  const aborted = new FailClosedApproval(() => 'allowed-once')
  assert.equal(await aborted.request({
    id: 'c', toolName: 'x', summary: 's', args: {}, signal: controller.signal,
  }), 'denied')

  const during = new AbortController()
  const slow = new FailClosedApproval(() => new Promise(() => {}), { timeoutMs: 1_000 })
  setTimeout(() => during.abort(), 5)
  assert.equal(await slow.request({
    id: 'd', toolName: 'x', summary: 's', args: {}, signal: during.signal,
  }), 'denied')
})

test('approval: ledger redacts sensitive arguments', async () => {
  const approval = new FailClosedApproval(() => 'denied')
  await approval.request({
    id: 'secret',
    toolName: 'bash',
    summary: 'run',
    args: { command: 'echo hi', apiKey: 'sk-super-secret', nested: { password: 'hunter2' } },
  })
  const json = JSON.stringify(approval.ledger)
  assert.doesNotMatch(json, /sk-super-secret/)
  assert.doesNotMatch(json, /hunter2/)
  assert.equal((approval.ledger[0]?.args as { apiKey: string }).apiKey, '[REDACTED]')
})

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

test('redaction: keys, values, arrays and errors', () => {
  // 运行时拼出测试串，避免源码里出现看似真实的 token 字面量。
  const fakeKey = ['sk', 'fake', '0000000000'].join('-')
  const fakeNestedKey = ['sk', 'nested', '0000000000'].join('-')
  const fakeListKey = ['sk', 'list', '0000000000'].join('-')
  const fakeAws = ['AKIA', 'FAKE', '0000000000'].join('')
  const fakeBearer = ['Bearer', 'fake-token-value'].join(' ')
  const input = {
    apiKey: fakeKey,
    Authorization: fakeBearer,
    nested: {
      password: 'not-a-real-password',
      note: `token is ${fakeNestedKey} and ${fakeAws}`,
    },
    list: [fakeListKey, { clientSecret: 'not-a-real-secret' }],
  }
  const redacted = redactValue(input)
  const json = JSON.stringify(redacted)
  for (const secret of [fakeKey, fakeNestedKey, fakeListKey, fakeAws, 'not-a-real-password', 'not-a-real-secret']) {
    assert.equal(json.includes(secret), false)
  }
  assert.equal((redacted as Record<string, unknown>).apiKey, '[REDACTED]')
  assert.deepEqual((redacted as Record<string, unknown>).list, ['sk-[REDACTED]', { clientSecret: '[REDACTED]' }])

  const error = redactError(new Error(`failed with ${fakeKey}`))
  assert.equal(JSON.stringify(error).includes(fakeKey), false)
  assert.match(redactText(fakeBearer), /Bearer \[REDACTED\]/)
})

test('redaction: circular values and prototype pollution are contained', () => {
  const circular: Record<string, unknown> = { name: 'root' }
  circular.self = circular
  const redacted = redactValue(circular) as Record<string, unknown>
  assert.equal(redacted.self, '[CIRCULAR]')

  const polluted = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as Record<string, unknown>
  const result = redactValue(polluted) as Record<string, unknown>
  assert.equal(Object.hasOwn(result, '__proto__'), false)
  assert.equal(({} as { polluted?: boolean }).polluted, undefined)
  assert.equal(result.ok, 1)
})

// ---------------------------------------------------------------------------
// 截断
// ---------------------------------------------------------------------------

test('truncate: stays within budget and reports omitted count', () => {
  const input = 'ab'.repeat(5_000)
  const result = truncateText(input, 100)
  assert.equal(result.truncated, true)
  assert.ok(result.returnedLength <= 100)
  assert.ok(result.text.endsWith('chars]'))
  assert.match(result.text, new RegExp(`truncated ${result.omitted} chars`))
  assert.equal(result.originalLength, 10_000)
  assert.ok(result.omitted > 9_000)
})

test('truncate: code points keep emoji and Chinese intact', () => {
  const result = truncateText('😀长'.repeat(100), 20)
  assert.ok(result.returnedLength <= 20)
  assert.equal(result.text.includes('\uFFFD'), false)
  assert.equal(Array.from(result.text).length, result.returnedLength)
})

test('truncate: marker larger than budget degrades to a hard cut', () => {
  const result = truncateText('abcdef', 2, { marker: () => 'LONG MARKER' })
  assert.equal(result.text, 'ab')
  assert.equal(result.returnedLength, 2)
  assert.throws(() => truncateText('x', -1), TypeError)
})

// ---------------------------------------------------------------------------
// CUA 授权
// ---------------------------------------------------------------------------

test('cua: allowed action runs, denied action never reaches the executor', async () => {
  const cua = new CuaAccess()
  cua.grant({ appId: 'com.apple.calculator', bundleId: 'com.apple.calculator', actions: ['read-screen', 'click'] })
  let runs = 0

  await cua.authorize(
    { appId: 'com.apple.calculator', bundleId: 'com.apple.calculator', action: 'click' },
    () => { runs += 1 },
  )
  assert.equal(runs, 1)

  await assert.rejects(
    cua.authorize({ appId: 'com.apple.terminal', action: 'click' }, () => { runs += 1 }),
    error => error instanceof CuaDeniedError && error.code === 'UNKNOWN_APP',
  )
  await assert.rejects(
    cua.authorize({ appId: 'com.apple.calculator', bundleId: 'com.apple.calculator', action: 'type' }, () => { runs += 1 }),
    error => error instanceof CuaDeniedError && error.code === 'ACTION_NOT_GRANTED',
  )
  await assert.rejects(
    cua.authorize({ appId: 'com.apple.calculator', bundleId: 'evil.app', action: 'click' }, () => { runs += 1 }),
    error => error instanceof CuaDeniedError && error.code === 'BUNDLE_MISMATCH',
  )
  assert.equal(runs, 1)
})

test('cua: empty grants and unknown action versions fail closed', () => {
  const cua = new CuaAccess()
  cua.grant({ appId: 'app', actions: [] })
  assert.equal(cua.check({ appId: 'app', action: 'click' }).allowed, false)
  assert.equal(cua.check({ appId: 'other', action: 'click' }).allowed, false)
  const invalid = cua.check({ appId: 'app', action: 'drop-tables' as never })
  assert.deepEqual(invalid.allowed ? {} : { code: invalid.code }, { code: 'INVALID_ACTION' })
  assert.throws(() => cua.grant({ appId: ' ', actions: ['click'] }), TypeError)
})

// ---------------------------------------------------------------------------
// 工具组合
// ---------------------------------------------------------------------------

test('tools: read/write stay inside the workspace and log is redacted', async t => {
  const { workspace, root, outside } = await setup(t)
  await writeFile(join(outside, 'secret.txt'), 'outside')
  await workspace.writeText('notes.md', '# notes\n')
  const approval = allowListApproval(
    request => (request.args as { path?: string }).path === 'notes.md',
    { timeoutMs: 50 },
  )
  const tools = new SecureTools({ workspace, approval, maxOutputChars: 50, now: () => 1 })

  const read = await tools.readFile('notes.md')
  assert.equal(read.ok, true)
  assert.equal((read.output as { content: string }).content, '# notes\n')

  const denied = await tools.writeFile('draft.md', 'nope')
  assert.equal(denied.ok, false)
  assert.equal(denied.error?.code, 'APPROVAL_DENIED')
  assert.equal(await workspace.exists('draft.md'), false)

  const allowed = await tools.writeFile('notes.md', '# updated\n')
  assert.equal(allowed.ok, true)
  assert.equal(await readFile(join(root, 'notes.md'), 'utf8'), '# updated\n')

  const escaped = await tools.readFile('../outside/secret.txt')
  assert.equal(escaped.ok, false)
  assert.equal(escaped.error?.code, 'PATH_ESCAPE')

  const escapedWrite = await tools.writeFile('../outside/owned.txt', 'x')
  assert.equal(escapedWrite.ok, false)
  assert.equal(escapedWrite.error?.code, 'PATH_ESCAPE')
  assert.equal(approval.ledger.some(entry => entry.args && JSON.stringify(entry.args).includes('owned')), false)

  const sensitive = await tools.readFile('.env')
  assert.equal(sensitive.ok, false)
  assert.equal(sensitive.error?.code, 'SENSITIVE_FILE')

  tools.log.append('manual', 'request', { apiKey: 'sk-audit-secret', command: 'echo ok' })
  const audit = JSON.stringify(tools.log.entries)
  assert.doesNotMatch(audit, /sk-audit-secret/)
  assert.match(audit, /\[REDACTED\]/)
})

test('tools: oversized output is truncated before it reaches the caller', async t => {
  const { workspace } = await setup(t)
  await workspace.writeText('big.txt', 'x'.repeat(5_000))
  const tools = new SecureTools({
    workspace,
    approval: allowListApproval(() => false),
    maxOutputChars: 64,
  })

  const result = await tools.readFile('big.txt')
  assert.equal(result.ok, true)
  assert.equal(result.truncated, true)
  assert.ok((result.omitted ?? 0) > 4_000)
  assert.ok(Array.from((result.output as { content: string }).content).length <= 64)
})
