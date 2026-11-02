/**
 * s13 · capability seams：沿用前序课程的实现（本课改动见 README）。
 */

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
} from './index.ts'

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-s13-'))
  try {
    const fs = new LocalFs(root)
    const shell = new LocalShell({ cwd: root })
    const registry = new ToolRegistry()
    for (const tool of capabilityTools({ fs, shell, approval: new AllowAllApproval(), cwd: root })) {
      registry.register(tool)
    }

    const signal = new AbortController().signal
    const ctx = { signal, callId: 'c', sessionId: 's' }
    console.log('write:', await registry.execute({
      type: 'tool-call', id: 'c', name: 'write_file', arguments: JSON.stringify({ path: 'notes.txt', content: 'hello sandbox' }),
    }, ctx).then(result => textOf({ id: 'x', role: 'tool', content: result.content })))
    console.log('read:', await registry.execute({
      type: 'tool-call', id: 'c', name: 'read_file', arguments: JSON.stringify({ path: 'notes.txt' }),
    }, ctx).then(result => textOf({ id: 'x', role: 'tool', content: result.content })))
    console.log('bash:', await registry.execute({
      type: 'tool-call', id: 'c', name: 'bash', arguments: JSON.stringify({ command: 'printf "from shell"' }),
    }, ctx).then(result => textOf({ id: 'x', role: 'tool', content: result.content })))

    const escaped = await registry.execute({
      type: 'tool-call', id: 'c', name: 'read_file', arguments: JSON.stringify({ path: '../../etc/passwd' }),
    }, ctx)
    console.log('escape isError:', escaped.isError)

    const denied = new ToolRegistry()
    for (const tool of capabilityTools({ fs, shell, approval: new DenyAllApproval(), cwd: root })) denied.register(tool)
    const deniedResult = await denied.execute({
      type: 'tool-call', id: 'c', name: 'write_file', arguments: JSON.stringify({ path: 'x', content: 'y' }),
    }, ctx)
    console.log('denied isError:', deniedResult.isError)

    const sandbox = new RecordingSandbox()
    sandbox.wrap(['/bin/sh', '-c', 'echo hi'])
    console.log('sandbox argv:', sandbox.calls[0]?.after)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
