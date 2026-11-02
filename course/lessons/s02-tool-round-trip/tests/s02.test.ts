/**
 * s01 离线单元测试：事件日志、流组装、工具注册表、DeepSeek wire 转换。
 *
 * 这些测试不访问网络，因此不需要 API key。
 * 真正的 loop 端到端测试在 live.test.ts，使用真实 DeepSeek。
 *
 * 运行：
 *   cd course/lessons/s01-agent-loop
 *   node --test tests/s01.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createMessage,
  createTextMessage,
  defineTool,
  mapFinishReason,
  mapUsage,
  Session,
  SseDecoder,
  StreamAssembler,
  textOf,
  toWireMessages,
  toWireTools,
  ToolRegistry,
} from '../src/index.ts'
import type { SessionEvent, ToolResult } from '../src/index.ts'

function eventTypes(session: Session): string[] {
  return session.events.map(event => event.type)
}

function eventsOf<T extends SessionEvent['type']>(
  session: Session,
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return session.events.filter(
    (event): event is Extract<SessionEvent, { type: T }> => event.type === type,
  )
}

function addTool(registry: ToolRegistry): void {
  registry.register(defineTool({
    name: 'add',
    description: 'Add two numbers.',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    run(args): ToolResult {
      const { a, b } = args as { a: number; b: number }
      return { content: [{ type: 'text', text: String(a + b) }], isError: false }
    },
  }))
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

test('session: deriveMessages projects only message events', () => {
  const session = new Session('derive')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', { message: createTextMessage('user', 'hi') })
  session.append('request/header', { provider: 'deepseek', model: 'deepseek-flash', tools: [] })
  session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }),
  })
  session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'add', arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'text', text: '3' }],
    }),
  })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  assert.deepEqual(
    session.deriveMessages().map(message => message.role),
    ['user', 'assistant', 'tool'],
  )
  assert.deepEqual(
    session.deriveMessages().map(textOf),
    ['hi', 'hello', '3'],
  )
  assert.equal(eventsOf(session, 'turn/end')[0]?.data.reason.kind, 'completed')
})

test('session: empty assistant messages stay in the log but not in history', () => {
  const session = new Session('empty')
  session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [] }),
  })
  assert.equal(eventsOf(session, 'assistant/message').length, 1)
  assert.deepEqual(session.deriveMessages(), [])
})

test('session: interrupted assistant prefixes still enter derived history', () => {
  const session = new Session('interrupted')
  session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'partial' }] }),
    interrupted: true,
  })
  assert.deepEqual(session.deriveMessages().map(textOf), ['partial'])
})

test('session: seq is monotonic and events are frozen snapshots', () => {
  const session = new Session('seq')
  const first = session.append('turn/start', { turn: 1 })
  const second = session.append('step/start', { turn: 1, step: 1 })
  assert.equal(first.seq, 0)
  assert.equal(second.seq, 1)
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(second.data), true)
})

test('session: replay reconstructs the same derived history', () => {
  const session = new Session('replay')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', { message: createTextMessage('user', '20 + 22?') })
  session.append('assistant/message', {
    message: createMessage({
      role: 'assistant',
      content: [{
        type: 'tool-call',
        id: 'c1',
        name: 'add',
        arguments: '{"a":20,"b":22}',
      }],
    }),
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'text', text: '42' }],
    }),
  })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const persisted = JSON.parse(JSON.stringify(session.events)) as SessionEvent[]
  const restored = Session.restore(session.id, persisted)

  assert.deepEqual(restored.deriveMessages(), session.deriveMessages())
  assert.equal(restored.lastTurn, 1)
  assert.equal(restored.lastSeq, session.lastSeq)
})

test('session: messages are identified and deeply frozen', () => {
  const message = createMessage({ role: 'user', content: [{ type: 'text', text: 'x' }] })
  assert.equal(typeof message.id, 'string')
  assert.equal(message.id.length > 0, true)
  assert.equal(Object.isFrozen(message), true)
  assert.equal(Object.isFrozen(message.content[0]), true)
})

// ---------------------------------------------------------------------------
// StreamAssembler
// ---------------------------------------------------------------------------

test('assembler: reasoning, text and tool calls keep their block order', () => {
  const assembler = new StreamAssembler()
  assembler.push({ type: 'block-start', index: 0, blockType: 'reasoning' })
  assembler.push({ type: 'reasoning-delta', index: 0, text: 'think' })
  assembler.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } })

  assembler.push({ type: 'block-start', index: 1, blockType: 'text' })
  assembler.push({ type: 'text-delta', index: 1, text: 'hello ' })
  assembler.push({ type: 'text-delta', index: 1, text: 'world' })
  assembler.push({ type: 'block-end', index: 1, block: { type: 'text', text: 'hello world' } })

  assembler.push({ type: 'block-start', index: 2, blockType: 'tool-call' })
  assembler.push({ type: 'tool-call-delta', index: 2, id: 'c1', name: 'calc', argumentsDelta: '{"expr' })
  assembler.push({ type: 'tool-call-delta', index: 2, id: 'c1', name: 'calc', argumentsDelta: 'ession":"1+1"}' })
  assembler.push({
    type: 'block-end',
    index: 2,
    block: { type: 'tool-call', id: 'c1', name: 'calc', arguments: '{"expression":"1+1"}' },
  })
  assembler.push({ type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } })
  assembler.push({ type: 'finish', reason: { kind: 'tool-calls' } })

  assert.deepEqual(assembler.blocks(), [
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'hello world' },
    { type: 'tool-call', id: 'c1', name: 'calc', arguments: '{"expression":"1+1"}' },
  ])
  assert.deepEqual(assembler.usage, { inputTokens: 10, outputTokens: 2 })
  assert.equal(assembler.finished?.reason.kind, 'tool-calls')
})

test('assembler: synthesizes blocks from deltas when block-end never arrives', () => {
  const assembler = new StreamAssembler()
  assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
  assembler.push({ type: 'text-delta', index: 0, text: 'he' })
  assembler.push({ type: 'text-delta', index: 0, text: 'llo' })
  assembler.push({ type: 'block-start', index: 1, blockType: 'tool-call' })
  assembler.push({ type: 'tool-call-delta', index: 1, id: 'c1', name: 'calc', argumentsDelta: '{}' })

  assert.deepEqual(assembler.blocks(), [
    { type: 'text', text: 'hello' },
    { type: 'tool-call', id: 'c1', name: 'calc', arguments: '{}' },
  ])
  // 取消时只保留可见前缀，未完成的工具调用不进入历史。
  assert.deepEqual(assembler.partialBlocks(), [{ type: 'text', text: 'hello' }])
})

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

test('tools: success, schema projection and disposal', async () => {
  const registry = new ToolRegistry()
  const dispose = registry.register(defineTool({
    name: 'echo',
    description: 'Echo text.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    run(args) {
      return { content: [{ type: 'text', text: (args as { text: string }).text }], isError: false }
    },
  }))

  const schemas = registry.schemas()
  assert.deepEqual(schemas, [{
    name: 'echo',
    description: 'Echo text.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  }])

  const result = await registry.execute(
    { type: 'tool-call', id: 'c1', name: 'echo', arguments: '{"text":"hi"}' },
    { signal: new AbortController().signal, callId: 'c1', sessionId: 's' },
  )
  assert.equal(result.isError, false)
  assert.equal(textOf({ id: 'x', role: 'tool', content: result.content }), 'hi')

  dispose()
  assert.equal(registry.get('echo'), undefined)
  assert.deepEqual(registry.schemas(), [])
})

test('tools: unknown, invalid JSON, invalid args and thrown errors become error results', async () => {
  const registry = new ToolRegistry()
  addTool(registry)
  registry.register(defineTool({
    name: 'boom',
    description: 'Throws.',
    parameters: { type: 'object', properties: {} },
    run() {
      throw new Error('kaput')
    },
  }))

  const ctx = { signal: new AbortController().signal, callId: 'c', sessionId: 's' }
  const missing = await registry.execute(
    { type: 'tool-call', id: 'c', name: 'missing', arguments: '{}' }, ctx,
  )
  assert.equal(missing.isError, true)
  assert.match(textOf({ id: 'x', role: 'tool', content: missing.content }), /unknown tool/)

  const badJson = await registry.execute(
    { type: 'tool-call', id: 'c', name: 'add', arguments: '{bad' }, ctx,
  )
  assert.equal(badJson.isError, true)

  const missingArg = await registry.execute(
    { type: 'tool-call', id: 'c', name: 'add', arguments: '{"a":1}' }, ctx,
  )
  assert.equal(missingArg.isError, true)
  assert.match(textOf({ id: 'x', role: 'tool', content: missingArg.content }), /required/)

  const wrongType = await registry.execute(
    { type: 'tool-call', id: 'c', name: 'add', arguments: '{"a":"1","b":2}' }, ctx,
  )
  assert.equal(wrongType.isError, true)
  assert.match(textOf({ id: 'x', role: 'tool', content: wrongType.content }), /must be number/)

  const thrown = await registry.execute(
    { type: 'tool-call', id: 'c', name: 'boom', arguments: '{}' }, ctx,
  )
  assert.equal(thrown.isError, true)
  assert.equal(textOf({ id: 'x', role: 'tool', content: thrown.content }), 'Error: kaput')
})

test('tools: duplicate names are rejected', () => {
  const registry = new ToolRegistry()
  addTool(registry)
  assert.throws(() => addTool(registry), /already registered/)
})

// ---------------------------------------------------------------------------
// DeepSeek wire conversion
// ---------------------------------------------------------------------------

test('wire: messages map system/user/assistant/tool and preserve raw tool arguments', () => {
  const messages = [
    createTextMessage('system', 'You are a calculator.'),
    createTextMessage('user', '2 + 3?'),
    createMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me add' },
        { type: 'tool-call', id: 'call_1', name: 'add', arguments: '{"a":2,"b":3}' },
      ],
    }),
    createMessage({
      role: 'tool',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: '5' }],
    }),
  ]

  assert.deepEqual(toWireMessages(messages), [
    { role: 'system', content: 'You are a calculator.' },
    { role: 'user', content: '2 + 3?' },
    {
      role: 'assistant',
      content: 'let me add',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'add', arguments: '{"a":2,"b":3}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '5' },
  ])
})

test('wire: tools map to OpenAI function declarations', () => {
  assert.deepEqual(toWireTools([{
    name: 'calc',
    description: 'Calculate.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
  }]), [{
    type: 'function',
    function: {
      name: 'calc',
      description: 'Calculate.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
    },
  }])
})

test('wire: SSE decoder handles split frames, CRLF and multiple events', () => {
  const decoder = new SseDecoder()
  assert.deepEqual(decoder.push('data: {"a":1}'), [])
  assert.deepEqual(decoder.push('\n\n'), ['{"a":1}'])
  assert.deepEqual(decoder.push('data: x\r\n\r\ndata: y\n\n'), ['x', 'y'])
  assert.deepEqual(decoder.push('data: multi\ndata: line\n\n'), ['multi\nline'])
  assert.deepEqual(decoder.push('data: tail'), [])
  assert.deepEqual(decoder.flush(), ['tail'])
})

test('wire: usage separates cache hits from uncached input', () => {
  assert.deepEqual(mapUsage({
    prompt_tokens: 100,
    prompt_cache_hit_tokens: 80,
    prompt_cache_miss_tokens: 20,
    completion_tokens: 10,
    total_tokens: 110,
    completion_tokens_details: { reasoning_tokens: 3 },
  }), {
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 110,
    cacheReadTokens: 80,
    reasoningTokens: 3,
  })
})

test('wire: finish reasons map to the internal vocabulary', () => {
  assert.deepEqual(mapFinishReason('stop'), { kind: 'stop' })
  assert.deepEqual(mapFinishReason('tool_calls'), { kind: 'tool-calls' })
  assert.deepEqual(mapFinishReason('length'), { kind: 'max-tokens' })
  assert.equal(mapFinishReason('weird').kind, 'error')
})
