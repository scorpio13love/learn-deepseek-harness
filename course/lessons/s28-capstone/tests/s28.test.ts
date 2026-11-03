/** s28 离线测试：SSE、HTTP 映射、离线 smoke、审批拒绝、产物与事件日志。 */

import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { DenyAllApproval } from '../src/approval.ts'
import { DeepSeekModel, mapHttpError, toWireMessages } from '../src/deepseek.ts'
import { readEventLog } from '../src/events.ts'
import { renderEvalReport } from '../src/eval.ts'
import { OfflineModel } from '../src/offline.ts'
import { runCapstone } from '../src/run.ts'
import { SseDecoder } from '../src/sse.ts'
import { createClock } from '../src/types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, '..', 'fixtures', 'project')

interface Fixture {
  base: string
  workspace: string
  outDir: string
}

async function setup(t: TestContext): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-s28-test-'))
  const workspace = join(base, 'workspace')
  const outDir = join(base, 'out')
  await cp(fixtures, workspace, { recursive: true })
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
  })
  return { base, workspace, outDir }
}

test('sse: frames can split across chunks, CRLF and multiline data', () => {
  const decoder = new SseDecoder()
  assert.deepEqual(decoder.push('data: hel'), [])
  assert.deepEqual(decoder.push('lo\n\n'), ['hello'])

  assert.deepEqual(decoder.push('event: x\r\ndata: a\r\ndata: b\r\n\r\n'), ['a\nb'])
  assert.deepEqual(decoder.push(': comment\n\n'), [])
  assert.deepEqual(decoder.push('data: {"a":1}\n\ndata: [DONE]\n\n'), ['{"a":1}', '[DONE]'])
  assert.deepEqual(decoder.flush(), [])

  const partial = new SseDecoder()
  partial.push('data: tail')
  assert.deepEqual(partial.flush(), ['tail'])
})

test('deepseek: HTTP status maps to a normalized failure', () => {
  assert.deepEqual(mapHttpError(401, 'bad key'), {
    kind: 'auth',
    message: 'HTTP 401: bad key',
    status: 401,
    retryable: false,
  })
  assert.equal(mapHttpError(429, '').kind, 'rate-limit')
  assert.equal(mapHttpError(504, 'gateway timeout').kind, 'timeout')
  assert.equal(mapHttpError(503, 'unavailable').kind, 'server')
  assert.equal(mapHttpError(400, 'bad request').kind, 'unknown')
})

test('deepseek: wire messages carry tool calls and tool_call_id', () => {
  const wire = toWireMessages([
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'README.md' } }],
    },
    { role: 'tool', content: '{"content":"hi"}', toolCallId: 'call-1', name: 'read_file' },
    { role: 'user', content: 'continue' },
  ]) as Array<Record<string, unknown>>

  assert.deepEqual(wire[0], {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'call-1',
      name: 'read_file',
      input: { path: 'README.md' },
    }],
  })
  assert.deepEqual(wire[1], {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: [{ type: 'text', text: '{"content":"hi"}' }],
      },
      { type: 'text', text: 'continue' },
    ],
  })
})

test('offline smoke: multi-tool capstone passes all checks and writes artifacts', async t => {
  const { workspace, outDir } = await setup(t)
  const result = await runCapstone({
    model: new OfflineModel(),
    workspace,
    outDir,
    runId: 'test-run',
    now: createClock(1_000, 10),
  })

  assert.equal(result.result.outcome.kind, 'ok')
  assert.equal(result.evalReport.passed, true)
  assert.equal(result.evalReport.checks.length, 9)
  assert.equal(result.evalReport.checks.every(check => check.passed), true)
  assert.ok(result.audit !== null)
  assert.match(result.audit ?? '', /src\/app\.ts:\d+/)
  assert.match(result.audit ?? '', /README\.md/)

  assert.equal(result.surface.runId, 'test-run')
  assert.equal(result.surface.status, 'ok')
  assert.equal(result.surface.tools.list_files, 1)
  assert.equal(result.surface.tools.read_file, 4)
  assert.equal(result.surface.tools.search_text, 1)
  assert.equal(result.surface.tools.write_file, 1)
  assert.equal(result.surface.filesRead.length, 4)
  assert.deepEqual(result.surface.filesWritten, ['audit.md'])
  assert.equal(result.surface.approvals.approved, 1)
  assert.equal(result.surface.errors, 0)
  assert.equal(result.surface.toolErrors, 0)
  assert.equal(result.surface.steps, 5)
  assert.ok(result.surface.usage.inputTokens > 0)
  assert.ok(result.surface.durationMs > 0)

  const events = await readEventLog(result.artifacts.eventsPath)
  assert.equal(events.length, result.surface.eventCount)
  assert.deepEqual(events.map(event => event.seq), Array.from({ length: events.length }, (_, index) => index + 1))
  assert.equal(events[0]?.type, 'run/start')
  assert.equal(events.at(-1)?.type, 'run/end')

  const surface = JSON.parse(await readFile(result.artifacts.surfacePath, 'utf8')) as { runId: string }
  assert.equal(surface.runId, 'test-run')
  const evalReport = JSON.parse(await readFile(result.artifacts.evalPath, 'utf8')) as { passed: boolean }
  assert.equal(evalReport.passed, true)
  assert.ok(result.artifacts.auditPath !== undefined)
  const artifactAudit = await readFile(result.artifacts.auditPath as string, 'utf8')
  assert.equal(artifactAudit, result.audit)
  assert.equal(await readFile(join(workspace, 'audit.md'), 'utf8'), result.audit)

  const text = renderEvalReport(result.evalReport)
  assert.match(text, /eval: PASS \(9\/9 checks\)/)
  assert.match(text, /\[PASS\] report-written/)
})

test('approval denial: write is blocked, report is missing, eval fails loudly', async t => {
  const { workspace, outDir } = await setup(t)
  const result = await runCapstone({
    model: new OfflineModel(),
    workspace,
    outDir,
    runId: 'denied-run',
    now: createClock(1_000, 10),
    approval: new DenyAllApproval(),
  })

  assert.equal(result.result.outcome.kind, 'ok')
  assert.equal(result.audit, null)
  assert.equal(result.evalReport.passed, false)

  const checks = new Map(result.evalReport.checks.map(check => [check.id, check]))
  assert.equal(checks.get('approval-granted')?.passed, false)
  assert.equal(checks.get('report-written')?.passed, false)
  assert.equal(checks.get('no-errors')?.passed, false)
  assert.equal(result.surface.approvals.denied, 1)
  assert.equal(result.surface.toolErrors, 1)
  assert.equal(result.surface.errors, 1)

  const reportPath = join(outDir, 'eval-report.json')
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as { passed: boolean }
  assert.equal(report.passed, false)
  const text = renderEvalReport(result.evalReport)
  assert.match(text, /eval: FAIL/)
  assert.match(text, /\[FAIL\] approval-granted/)
})

test('events: append-only JSONL rejects malformed lines', async t => {
  const { base } = await setup(t)
  const path = join(base, 'bad.jsonl')
  await import('node:fs/promises').then(fs => fs.writeFile(path, '{"seq":1}\nnot json\n', 'utf8'))
  await assert.rejects(readEventLog(path), /invalid event at line 2/)
})

test('deepseek: streaming response parses text, split tool calls and usage', async () => {
  const original = globalThis.fetch
  const frames = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I will read "}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the file."}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-1","name":"read_file","input":{}}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"}}\n\n',
    'data: {"type":"content_block_stop","index":1}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]
  globalThis.fetch = (async () => new Response(frames.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })) as typeof fetch

  try {
    const model = new DeepSeekModel({ apiKey: 'test-key' })
    const turn = await model.complete({ messages: [{ role: 'user', content: 'go' }], tools: [] })
    assert.equal(turn.text, 'I will read the file.')
    assert.equal(turn.toolCalls.length, 1)
    assert.equal(turn.toolCalls[0]?.name, 'read_file')
    assert.deepEqual(turn.toolCalls[0]?.arguments, { path: 'README.md' })
    assert.equal(turn.usage.inputTokens, 12)
    assert.equal(turn.usage.outputTokens, 7)
    assert.equal(turn.finishReason, 'tool-calls')
  } finally {
    globalThis.fetch = original
  }
})

test('deepseek: HTTP 429 becomes a rate-limit failure turn', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response('slow down', { status: 429 })) as typeof fetch
  try {
    const model = new DeepSeekModel({ apiKey: 'test-key' })
    const turn = await model.complete({ messages: [{ role: 'user', content: 'go' }], tools: [] })
    assert.equal(turn.finishReason, 'error')
    assert.equal(turn.failure?.kind, 'rate-limit')
    assert.equal(turn.failure?.status, 429)
  } finally {
    globalThis.fetch = original
  }
})
