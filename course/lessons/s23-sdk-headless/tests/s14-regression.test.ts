/**
 * s14 离线测试：委派、深度/并发预算、preset、subagent 工具。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LocalSubagentBackend,
  SubagentManager,
  subagentTool,
  ToolRegistry,
  defineTool,
  textOf,
} from '../src/index.ts'
import type { AgentPreset, ChatRequest, Model, StreamChunk, SubagentBackend, SubagentRequest } from '../src/index.ts'

class FakeBackend implements SubagentBackend {
  readonly requests: SubagentRequest[] = []
  block = false
  async run(request: SubagentRequest) {
    this.requests.push(request)
    if (this.block) await new Promise(resolve => setTimeout(resolve, 20))
    return { childId: `child-${this.requests.length}`, answer: `answer:${request.task}`, depth: request.depth + 1 }
  }
}

function manager(backend: SubagentBackend, maxDepth = 2, maxActive = 2): SubagentManager {
  return new SubagentManager({ backend, maxDepth, maxActive })
}

test('manager: depth and active budgets', async () => {
  const backend = new FakeBackend()
  const m = manager(backend, 1, 1)
  await m.spawn({ task: 'a', parentSessionId: 'p', depth: 0 })
  await assert.rejects(async () => m.spawn({ task: 'b', parentSessionId: 'p', depth: 1 }), /depth limit/)

  const blocking = new FakeBackend()
  blocking.block = true
  const m2 = manager(blocking, 2, 1)
  const first = m2.spawn({ task: 'a', parentSessionId: 'p', depth: 0 })
  await assert.rejects(async () => m2.spawn({ task: 'b', parentSessionId: 'p', depth: 0 }), /concurrency limit/)
  await first
})

test('tool: subagent delegates and renders the answer', async () => {
  const backend = new FakeBackend()
  const tool = subagentTool({ manager: manager(backend), parentSessionId: 'parent' })
  const registry = new ToolRegistry()
  registry.register(tool)
  const result = await registry.execute({
    type: 'tool-call', id: 'c', name: 'subagent', arguments: JSON.stringify({ task: 'do it' }),
  }, { signal: new AbortController().signal, callId: 'c', sessionId: 'parent' })
  assert.equal(result.isError, false)
  assert.match(textOf({ id: 'x', role: 'tool', content: result.content }), /child child-1: answer:do it/)
  assert.equal(backend.requests[0]?.depth, 0)
})

class CaptureModel implements Model {
  readonly provider = 'test'
  readonly model = 'm'
  readonly requests: ChatRequest[] = []
  async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'child answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'child answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('local backend: preset filters tools and injects persona', async () => {
  const model = new CaptureModel()
  const tools = new ToolRegistry()
  for (const name of ['a', 'b']) {
    tools.register(defineTool({
      name,
      description: name,
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
      execute: () => name,
    }))
  }
  const backend = new LocalSubagentBackend({ model, tools })
  const preset: AgentPreset = { name: 'p', prompt: 'You are a specialist.', toolNames: ['a'] }
  const result = await backend.run({ task: 'hello', parentSessionId: 'p', depth: 0, preset })
  assert.equal(result.answer, 'child answer')
  assert.equal(model.requests[0]?.tools.map(tool => tool.name).join(','), 'a')
  assert.equal(textOf(model.requests[0]!.messages[0]!), 'You are a specialist.')
})
