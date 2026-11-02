/** s26 离线测试：record→replay、故障矩阵、快照与失败报告。 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runAgent } from '../src/agent.ts'
import {
  DisconnectModel,
  RateLimitModel,
  ToolErrorModel,
  faultMatrix,
} from '../src/faults.ts'
import {
  RecordingModel,
  ReplayModel,
  deserializeRecords,
  serializeRecords,
} from '../src/model.ts'
import { ScenarioRunner, formatReport } from '../src/runner.ts'
import { assertSnapshot, diffSnapshots, snapshotRun } from '../src/snapshot.ts'
import type { Model, ModelChunk, ModelRequest, Tool } from '../src/types.ts'

/** 先调用 echo，再根据 tool 消息回答。无内部状态，因此重复运行一致。 */
class ScriptedModel implements Model {
  readonly provider = 'test'
  readonly model = 'scripted'

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    const toolMessages = request.messages.filter(message => message.role === 'tool')
    if (toolMessages.length === 0) {
      yield { type: 'tool-call', id: 'call-echo-1', name: 'echo', arguments: '{"text":"hello"}' }
      yield { type: 'finish', reason: 'tool-calls' }
      return
    }
    yield { type: 'text-delta', text: 'tool said: ' }
    yield { type: 'text-delta', text: toolMessages[0]?.content ?? '' }
    yield { type: 'usage', inputTokens: 11, outputTokens: 7 }
    yield { type: 'finish', reason: 'stop' }
  }
}

const echo: Tool = {
  name: 'echo',
  description: 'Echo the text argument.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  run: args => args,
}

test('record -> replay produces an identical snapshot', async () => {
  const recording = new RecordingModel(new ScriptedModel())
  const first = await runAgent({ model: recording, prompt: 'hi', tools: [echo] })

  const replay = new ReplayModel(recording.records, { provider: 'test', model: 'scripted' })
  const second = await runAgent({ model: replay, prompt: 'hi', tools: [echo] })

  assertSnapshot(snapshotRun(first), snapshotRun(second))
  assert.equal(recording.records.length, 2)
  assert.equal(replay.consumed, 2)
  assert.equal(first.outcome.kind, 'ok')
  assert.equal(first.toolCalls.length, 1)
  assert.deepEqual(first.toolCalls[0]?.args, { text: 'hello' })
})

test('record file survives JSON round-trip and still replays', async () => {
  const recording = new RecordingModel(new ScriptedModel())
  const first = await runAgent({ model: recording, prompt: 'hi', tools: [echo] })
  const json = serializeRecords(recording.records)
  const restored = deserializeRecords(json)

  const replay = new ReplayModel(restored, { provider: 'test', model: 'scripted' })
  const second = await runAgent({ model: replay, prompt: 'hi', tools: [echo] })
  assertSnapshot(snapshotRun(first), snapshotRun(second))
  assert.match(json, /"version": 1/)
})

test('disconnect: partial prefix is kept and the error is replayable', async () => {
  const recording = new RecordingModel(new DisconnectModel())
  const first = await runAgent({ model: recording, prompt: 'hi' })

  assert.equal(first.outcome.kind, 'error')
  assert.equal(first.outcome.kind === 'error' ? first.outcome.failure.kind : '', 'disconnect')
  assert.equal(first.messages.some(message => message.role === 'assistant' && message.content === 'partial answer'), true)
  assert.equal(first.events.some(event => event.type === 'text' && event.data.partial === true), true)
  assert.equal(recording.records[0]?.error?.code, 'STREAM_CLOSED')

  const replay = new ReplayModel(recording.records, { provider: 'fault', model: 'disconnect' })
  const second = await runAgent({ model: replay, prompt: 'hi' })
  assertSnapshot(snapshotRun(first), snapshotRun(second))
})

test('fault matrix: all four faults normalize and the runner passes declared expectations', async () => {
  const failTool: Tool = {
    name: 'fail_tool',
    description: 'Always throws.',
    parameters: { type: 'object' },
    run: () => { throw new Error('boom') },
  }
  const scenarios = faultMatrix().map(item => ({
    id: item.id,
    description: item.id,
    prompt: 'go',
    createModel: item.createModel,
    ...item.kind === 'tool-error' ? { tools: [failTool] } : {},
    expect: item.kind === 'tool-error'
      ? { kind: 'tool-error' as const }
      : { kind: 'failure' as const, failure: item.kind },
  }))

  const report = await new ScenarioRunner({ repeats: 2 }).runAll(scenarios)
  assert.equal(report.total, 4)
  assert.equal(report.passed, 4)
  assert.deepEqual(report.failures, [])
  assert.equal(report.passRate, 1)

  const kinds = report.scenarios.flatMap(scenario => scenario.failures.map(failure => failure.kind))
  assert.deepEqual(kinds.sort(), ['disconnect', 'rate-limit', 'timeout', 'tool-error'])
})

test('tool error is non-terminal: fed back to the model, run can still finish', async () => {
  const failTool: Tool = {
    name: 'fail_tool',
    description: 'Always throws.',
    parameters: { type: 'object' },
    run: () => { throw new Error('boom') },
  }
  const result = await runAgent({ model: new ToolErrorModel(), prompt: 'go', tools: [failTool] })

  assert.equal(result.outcome.kind, 'ok')
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]?.kind, 'tool-error')
  assert.equal(result.toolCalls[0]?.ok, false)
  assert.equal(result.messages.some(message => message.role === 'tool' && message.isError === true), true)
})

test('runner repeats: same scenario yields the same snapshot every time', async () => {
  const runner = new ScenarioRunner({ repeats: 3 })
  const report = await runner.run({
    id: 'repeat',
    description: 'deterministic tool use',
    prompt: 'hi',
    createModel: () => new ScriptedModel(),
    tools: [echo],
  })

  assert.equal(report.status, 'passed')
  assert.equal(report.runs.length, 3)
  assert.deepEqual(report.runs[0]?.snapshot, report.runs[1]?.snapshot)
  assert.deepEqual(report.runs[1]?.snapshot, report.runs[2]?.snapshot)
  assert.equal(report.metrics.toolCalls, 1)
  assert.equal(report.metrics.inputTokens, 11)
})

test('failure report: expected ok but got 429', async () => {
  const runner = new ScenarioRunner()
  const report = await runner.run({
    id: 'regression/429',
    description: 'must succeed',
    prompt: 'go',
    createModel: () => new RateLimitModel(),
    expect: { kind: 'ok' },
  })

  assert.equal(report.status, 'failed')
  assert.match(report.reason, /expected ok, got failure rate-limit/)
  const text = formatReport(report)
  assert.match(text, /\[FAIL\] regression\/429/)
  assert.match(text, /rate-limit/)
  assert.match(text, /429 Too Many Requests/)
})

test('snapshot diff points at the changed field', async () => {
  const result = await runAgent({ model: new RateLimitModel(), prompt: 'go' })
  const snapshot = snapshotRun(result)
  const changed = structuredClone(snapshot)
  changed.messages[0]!.content = 'changed'

  const diffs = diffSnapshots(snapshot, changed)
  assert.equal(diffs.length, 1)
  assert.equal(diffs[0]?.path, '$.messages[0].content')
  assert.equal(diffs[0]?.left, 'go')
  assert.equal(diffs[0]?.right, 'changed')
  assert.throws(() => assertSnapshot(snapshot, changed), /snapshot mismatch[\s\S]*\$.messages\[0\]\.content/)
})

test('replay exhaustion is loud', async () => {
  const replay = new ReplayModel([])
  const result = await runAgent({ model: replay, prompt: 'go' })
  assert.equal(result.outcome.kind, 'error')
  assert.equal(result.outcome.kind === 'error' ? result.outcome.failure.kind : '', 'model-error')
  assert.match(result.outcome.kind === 'error' ? result.outcome.failure.message : '', /replay exhausted/)
})
