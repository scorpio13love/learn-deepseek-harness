/**
 * s13 离线测试：fs/shell/sandbox/approval。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AllowAllApproval,
  capabilityTools,
  DenyAllApproval,
  LocalFs,
  LocalShell,
  RecordingSandbox,
  textOf,
  ToolRegistry,
} from '../src/index.ts'

async function workspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-s13-test-'))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

function ctx() {
  return { signal: new AbortController().signal, callId: 'c', sessionId: 's' }
}

function call(name: string, args: unknown) {
  return { type: 'tool-call' as const, id: 'c', name, arguments: JSON.stringify(args) }
}

test('fs: read/write inside workspace and reject escape', async () => {
  const { root, cleanup } = await workspace()
  try {
    const fs = new LocalFs(root)
    await fs.write('a/b.txt', 'hello')
    assert.equal(await fs.read('a/b.txt'), 'hello')
    assert.throws(() => fs.resolve('../../etc/passwd'), /escapes workspace/)
    assert.throws(() => fs.resolve('/etc/passwd'), /escapes workspace/)
  } finally {
    await cleanup()
  }
})

test('shell: stdout, exit code and timeout', async () => {
  const { root, cleanup } = await workspace()
  try {
    const shell = new LocalShell({ cwd: root })
    const ok = await shell.run('printf hello')
    assert.equal(ok.exitCode, 0)
    assert.equal(ok.stdout, 'hello')
    assert.equal(ok.timedOut, false)

    const failed = await shell.run('exit 7')
    assert.equal(failed.exitCode, 7)

    const timed = await shell.run('sleep 1', { timeoutMs: 20 })
    assert.equal(timed.timedOut, true)
  } finally {
    await cleanup()
  }
})

test('sandbox: argv is wrapped before spawn', async () => {
  const sandbox = new RecordingSandbox()
  const wrapped = sandbox.wrap(['/bin/sh', '-c', 'echo hi'])
  assert.deepEqual(wrapped, ['sandbox-exec', '-p', '(version 1)(allow default)', '/bin/sh', '-c', 'echo hi'])
  assert.equal(sandbox.calls.length, 1)
  assert.equal(sandbox.calls[0]?.before[0], '/bin/sh')
})

test('tools: write/read/bash via registry with approval', async () => {
  const { root, cleanup } = await workspace()
  try {
    const tools = capabilityTools({
      fs: new LocalFs(root),
      shell: new LocalShell({ cwd: root }),
      approval: new AllowAllApproval(),
      cwd: root,
    })
    const registry = new ToolRegistry()
    for (const tool of tools) registry.register(tool)

    const written = await registry.execute(call('write_file', { path: 'x.txt', content: 'abc' }), ctx())
    assert.equal(written.isError, false)
    assert.match(textOf({ id: 'x', role: 'tool', content: written.content }), /wrote x\.txt/)

    const read = await registry.execute(call('read_file', { path: 'x.txt' }), ctx())
    assert.equal(textOf({ id: 'x', role: 'tool', content: read.content }), 'abc')

    const bash = await registry.execute(call('bash', { command: 'cat x.txt' }), ctx())
    assert.equal(bash.isError, false)
    assert.match(textOf({ id: 'x', role: 'tool', content: bash.content }), /abc/)
  } finally {
    await cleanup()
  }
})

test('approval: denied write/bash do not execute', async () => {
  const { root, cleanup } = await workspace()
  try {
    const registry = new ToolRegistry()
    for (const tool of capabilityTools({
      fs: new LocalFs(root),
      shell: new LocalShell({ cwd: root }),
      approval: new DenyAllApproval(),
      cwd: root,
    })) registry.register(tool)

    const write = await registry.execute(call('write_file', { path: 'x', content: 'y' }), ctx())
    assert.equal(write.isError, true)
    assert.match(textOf({ id: 'x', role: 'tool', content: write.content }), /not approved/)

    const bash = await registry.execute(call('bash', { command: 'echo should-not-run' }), ctx())
    assert.equal(bash.isError, true)
  } finally {
    await cleanup()
  }
})

test('tools: path escape becomes a model-visible error result', async () => {
  const { root, cleanup } = await workspace()
  try {
    const registry = new ToolRegistry()
    for (const tool of capabilityTools({
      fs: new LocalFs(root),
      shell: new LocalShell({ cwd: root }),
      approval: new AllowAllApproval(),
      cwd: root,
    })) registry.register(tool)

    const result = await registry.execute(call('read_file', { path: '../../etc/passwd' }), ctx())
    assert.equal(result.isError, true)
    assert.match(textOf({ id: 'x', role: 'tool', content: result.content }), /escapes workspace/)
  } finally {
    await cleanup()
  }
})
