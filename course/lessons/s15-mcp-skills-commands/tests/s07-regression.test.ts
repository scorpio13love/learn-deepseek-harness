/**
 * s07 离线测试：队列语义、followup/steer/inject、取消与 idle。
 *
 * 不需要 API key。真实模型端到端在 live.test.ts。
 * 测试里的 Model 是可控的传输替身，只用于制造时序；demo/live 走真实 DeepSeek。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  Agent,
  createTextMessage,
  Inbox,
  Session,
  textOf,
  ToolRegistry,
} from '../src/index.ts'
import type { ChatRequest, Message, Model, StreamChunk } from '../src/index.ts'

function msg(text: string): Message {
  return createTextMessage('user', text)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class CapturingModel implements Model {
  readonly provider = 'test'
  readonly model = 'capture'
  readonly requests: ChatRequest[] = []
  #delay: number

  constructor(delay = 0) {
    this.#delay = delay
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const call = this.requests.length
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (this.#delay > 0) await sleep(this.#delay)
    yield { type: 'text-delta', index: 0, text: `answer-${call}` }
    if (this.#delay > 0) await sleep(this.#delay)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `answer-${call}` } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('inbox: turn claim takes all next-step plus one next-turn', () => {
  const inbox = new Inbox()
  inbox.append('next-turn', msg('t1'))
  inbox.append('next-turn', msg('t2'))
  inbox.append('next-step', msg('s1'))
  inbox.append('next-step', msg('s2'))

  const claimed = inbox.claim('turn')
  assert.deepEqual(claimed.map(textOf), ['s1', 's2', 't1'])
  assert.deepEqual(inbox.nextTurn.map(textOf), ['t2'])
  assert.deepEqual(inbox.nextStep, [])
  assert.deepEqual(inbox.claim('step'), [])
})

test('inbox: step claim only consumes next-step; unique ids and replace/remove', () => {
  const inbox = new Inbox()
  const first = msg('a')
  const second = msg('b')
  const third = msg('c')
  inbox.append('next-turn', first)
  inbox.append('next-step', second)
  inbox.append('next-step', third)

  assert.deepEqual(inbox.claim('step').map(textOf), ['b', 'c'])
  assert.deepEqual(inbox.nextTurn, [first])
  assert.throws(() => inbox.append('next-step', first), /already pending/)

  const replacement = msg('a2')
  assert.equal(inbox.replace(first.id, replacement), true)
  assert.equal(textOf(inbox.nextTurn[0]!), 'a2')
  assert.equal(inbox.remove(replacement.id), true)
  assert.equal(inbox.hasPending, false)
})

test('followup: idle agent wakes and runs a turn', async () => {
  const session = new Session('followup')
  const model = new CapturingModel()
  const agent = new Agent(session, model, new ToolRegistry())

  agent.followup(msg('hello'))
  assert.equal(agent.status, 'running')
  await agent.whenIdle()

  assert.equal(agent.status, 'idle')
  assert.equal(model.requests.length, 1)
  assert.equal(textOf(model.requests[0]!.messages[0]!), 'hello')
  assert.deepEqual(
    session.events.filter(event => event.type === 'turn/start').map(event => event.data.turn),
    [1],
  )
})

test('inject: idle agent is not woken; next run claims it first', async () => {
  const session = new Session('inject')
  const model = new CapturingModel()
  const agent = new Agent(session, model, new ToolRegistry())

  agent.inject(msg('injected'))
  assert.equal(agent.status, 'idle')
  assert.equal(session.events.length, 0)

  await agent.run('prompt')
  assert.deepEqual(
    model.requests[0]!.messages.map(textOf),
    ['injected', 'prompt'],
  )
})

test('steer: input is consumed at the next step boundary', async () => {
  const session = new Session('steer')
  const model = new CapturingModel(10)
  const agent = new Agent(session, model, new ToolRegistry())

  const pending = agent.run('hello')
  agent.steer(msg('steer-now'))
  const result = await pending

  assert.equal(result.steps, 2)
  assert.equal(model.requests.length, 2)
  assert.deepEqual(
    model.requests[1]!.messages.map(message => message.role),
    ['user', 'assistant', 'user'],
  )
  assert.equal(textOf(model.requests[1]!.messages[2]!), 'steer-now')
  assert.equal(session.events.filter(event => event.type === 'turn/start').length, 1)
})

test('followup while running starts a second turn and whenIdle waits for both', async () => {
  const session = new Session('followup-active')
  const model = new CapturingModel(10)
  const agent = new Agent(session, model, new ToolRegistry())

  const pending = agent.run('first')
  agent.followup(msg('second'))
  const result = await pending

  assert.equal(model.requests.length, 2)
  assert.equal(result.steps, 1)
  assert.deepEqual(
    session.events.filter(event => event.type === 'turn/start').map(event => event.data.turn),
    [1, 2],
  )
  assert.equal(textOf(model.requests[1]!.messages.at(-1)!), 'second')
})

test('cancel: clears pending by default and preserves it with keepInbox', async () => {
  const session = new Session('cancel')
  const model = new CapturingModel()
  const agent = new Agent(session, model, new ToolRegistry())

  agent.inject(msg('keep-me'))
  agent.cancel({ kind: 'user' })
  await agent.run('fresh')
  assert.deepEqual(model.requests[0]!.messages.map(textOf), ['fresh'])

  const model2 = new CapturingModel()
  const agent2 = new Agent(new Session('cancel-keep'), model2, new ToolRegistry())
  agent2.inject(msg('keep-me'))
  agent2.cancel({ kind: 'user' }, { keepInbox: true })
  await agent2.run('next')
  assert.deepEqual(model2.requests[0]!.messages.map(textOf), ['keep-me', 'next'])
})

test('cancel: an active run settles aborted and returns to idle', async () => {
  const session = new Session('cancel-active')
  const model = new CapturingModel(50)
  const agent = new Agent(session, model, new ToolRegistry())

  const pending = agent.run('hello')
  setTimeout(() => agent.cancel({ kind: 'user' }), 5)
  const result = await pending

  assert.equal(result.reason.kind, 'aborted')
  assert.equal(agent.status, 'idle')
  assert.equal(session.events.some(event => event.type === 'turn/end'), true)
})

test('start: fire-and-forget then await whenIdle', async () => {
  const session = new Session('start')
  const model = new CapturingModel()
  const agent = new Agent(session, model, new ToolRegistry())
  agent.start('hello')
  await agent.whenIdle()
  assert.equal(model.requests.length, 1)
  assert.equal(session.lastAssistantText(), 'answer-1')
})

test('run: queued next-step and next-turn are claimed in order', async () => {
  const session = new Session('order')
  const model = new CapturingModel()
  const agent = new Agent(session, model, new ToolRegistry())
  agent.inject(msg('context'))
  agent.followup(msg('queued'))
  agent.followup(msg('second-turn'))

  await agent.whenIdle()
  assert.equal(model.requests.length, 2)
  assert.deepEqual(model.requests[0]!.messages.map(textOf), ['context', 'queued'])
  assert.deepEqual(model.requests[1]!.messages.at(-1)?.role, 'user')
  assert.equal(textOf(model.requests[1]!.messages.at(-1)!), 'second-turn')
})
