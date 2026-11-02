/** 最小 agent loop + 失败归一化。eval 只依赖这里产出的 RunResult。 */

import type {
  ChatMessage,
  Failure,
  JsonValue,
  Model,
  ModelChunk,
  RunEvent,
  RunResult,
  Tool,
  ToolCallRecord,
  Usage,
} from './types.ts'
import { createClock, emptyUsage } from './types.ts'

export interface RunAgentOptions {
  model: Model
  prompt: string
  tools?: Tool[]
  maxSteps?: number
  now?: () => number
  signal?: AbortSignal
}

/** 把 provider/网络/工具抛出的任意错误收敛成 Failure。 */
export function classifyError(error: unknown): Failure {
  if (typeof error === 'object' && error !== null) {
    const value = error as {
      kind?: unknown
      message?: unknown
      code?: unknown
      status?: unknown
      name?: unknown
    }
    if (typeof value.kind === 'string' && isFailureKind(value.kind)) {
      return {
        kind: value.kind,
        message: typeof value.message === 'string' ? value.message : value.kind,
        ...typeof value.code === 'string' ? { code: value.code } : {},
        ...typeof value.status === 'number' ? { status: value.status } : {},
        retryable: value.kind === 'rate-limit' || value.kind === 'timeout' || value.kind === 'disconnect',
      }
    }
    const message = typeof value.message === 'string' ? value.message : String(error)
    const code = typeof value.code === 'string' ? value.code : undefined
    const status = typeof value.status === 'number' ? value.status : undefined
    const name = typeof value.name === 'string' ? value.name : undefined

    if (status === 429 || code === 'RATE_LIMITED' || /rate.?limit|too many requests/i.test(message)) {
      return { kind: 'rate-limit', message, retryable: true, ...status === undefined ? {} : { status }, ...code === undefined ? {} : { code } }
    }
    if (name === 'TimeoutError' || code === 'ETIMEDOUT' || /timed?\s*out|timeout/i.test(message)) {
      return { kind: 'timeout', message, retryable: true, ...code === undefined ? {} : { code } }
    }
    if (code === 'STREAM_CLOSED' || name === 'AbortError' || /stream closed|disconnect|ECONNRESET|socket hang up/i.test(message)) {
      return { kind: 'disconnect', message, retryable: true, ...code === undefined ? {} : { code } }
    }
    return { kind: 'model-error', message, retryable: false, ...code === undefined ? {} : { code } }
  }
  return { kind: 'model-error', message: String(error), retryable: false }
}

function isFailureKind(value: string): value is Failure['kind'] {
  return value === 'rate-limit'
    || value === 'timeout'
    || value === 'disconnect'
    || value === 'tool-error'
    || value === 'model-error'
}

class Recorder {
  #events: RunEvent[] = []
  #now: () => number
  #seq = 0

  constructor(now: () => number) {
    this.#now = now
  }

  emit(type: string, data: JsonValue): void {
    this.#seq += 1
    this.#events.push({
      seq: this.#seq,
      at: this.#now(),
      type,
      data: data as RunEvent['data'],
    })
  }

  get events(): RunEvent[] {
    return [...this.#events]
  }
}

interface ConsumedTurn {
  text: string
  calls: Array<{ id: string; name: string; arguments: string }>
  usage: Usage
  finish: { reason: 'stop' | 'tool-calls' | 'error'; failure?: Failure } | undefined
}

type ConsumeResult =
  | ({ ok: true } & ConsumedTurn)
  | { ok: false; error: unknown; partial: ConsumedTurn }

/** 读取一个完整的模型回合；流中断时把已交付的前缀一起返回。 */
async function consumeStream(
  stream: AsyncIterable<ModelChunk>,
  emit: (type: string, data: JsonValue) => void,
): Promise<ConsumeResult> {
  let text = ''
  let usage = emptyUsage()
  let finish: ConsumedTurn['finish']
  const calls: ConsumedTurn['calls'] = []

  try {
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        continue
      }
      if (chunk.type === 'tool-call') {
        calls.push({ id: chunk.id, name: chunk.name, arguments: chunk.arguments })
        emit('tool/call', { callId: chunk.id, name: chunk.name, args: chunk.arguments })
        continue
      }
      if (chunk.type === 'usage') {
        usage = {
          inputTokens: usage.inputTokens + chunk.inputTokens,
          outputTokens: usage.outputTokens + chunk.outputTokens,
        }
        continue
      }
      finish = chunk.reason === 'error'
        ? { reason: 'error', failure: chunk.failure ?? { kind: 'model-error', message: 'model returned error without failure' } }
        : { reason: chunk.reason }
    }
  } catch (error) {
    return { ok: false, error, partial: { text, calls, usage, finish } }
  }

  return { ok: true, text, calls, usage, finish }
}

export async function runAgent(options: RunAgentOptions): Promise<RunResult> {
  const recorder = new Recorder(options.now ?? createClock())
  const emit = (type: string, data: JsonValue): void => recorder.emit(type, data)
  const tools = options.tools ?? []
  const maxSteps = options.maxSteps ?? 6
  const messages: ChatMessage[] = [{ role: 'user', content: options.prompt }]
  const failures: Failure[] = []
  const toolCalls: ToolCallRecord[] = []
  let usage = emptyUsage()
  let steps = 0

  emit('run/start', { prompt: options.prompt, model: options.model.model })

  const finishWithError = (failure: Failure): RunResult => {
    failures.push(failure)
    emit('run/error', { kind: failure.kind, message: failure.message })
    emit('run/end', { status: 'error', failure: failure.kind })
    return {
      events: recorder.events,
      messages,
      outcome: { kind: 'error', failure },
      failures,
      usage,
      steps,
      toolCalls,
    }
  }

  while (steps < maxSteps) {
    steps += 1
    emit('step/start', { step: steps, messages: messages.length })
    const request = {
      messages: messages.map(message => ({ ...message })),
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    }

    const consumed = await consumeStream(options.model.stream(request, options.signal), emit)

    usage = {
      inputTokens: usage.inputTokens + (consumed.ok ? consumed.usage.inputTokens : consumed.partial.usage.inputTokens),
      outputTokens: usage.outputTokens + (consumed.ok ? consumed.usage.outputTokens : consumed.partial.usage.outputTokens),
    }

    if (!consumed.ok) {
      if (consumed.partial.text !== '') {
        emit('text', { text: consumed.partial.text, partial: true })
        messages.push({ role: 'assistant', content: consumed.partial.text })
      }
      return finishWithError(classifyError(consumed.error))
    }

    if (consumed.text !== '') {
      emit('text', { text: consumed.text })
      messages.push({ role: 'assistant', content: consumed.text })
    }

    if (consumed.finish?.reason === 'error') {
      return finishWithError(consumed.finish.failure ?? { kind: 'model-error', message: 'unknown model error' })
    }

    if (consumed.calls.length === 0) {
      emit('run/end', { status: 'ok' })
      return {
        events: recorder.events,
        messages,
        outcome: { kind: 'ok' },
        failures,
        usage,
        steps,
        toolCalls,
      }
    }

    const assistantCalls = consumed.calls.map(call => ({
      id: call.id,
      name: call.name,
      arguments: parseArguments(call.arguments),
    }))
    if (consumed.text === '') {
      messages.push({ role: 'assistant', content: '', toolCalls: assistantCalls })
    } else {
      // 文本消息已经 push 过，补上 toolCalls 关联。
      const last = messages.at(-1)
      if (last !== undefined) last.toolCalls = assistantCalls
    }

    for (const [index, call] of consumed.calls.entries()) {
      const parsed = assistantCalls[index]
      let args: JsonValue = parsed?.arguments ?? null
      let ok = true
      let output: JsonValue
      const tool = tools.find(candidate => candidate.name === call.name)

      if (tool === undefined) {
        ok = false
        const failure: Failure = { kind: 'tool-error', message: `unknown tool: ${call.name}`, retryable: false }
        failures.push(failure)
        output = { error: failure.message }
        emit('tool/error', { callId: call.id, name: call.name, message: failure.message })
      } else {
        try {
          output = await tool.run(args, options.signal)
        } catch (error) {
          ok = false
          const failure = classifyError(error)
          const toolFailure: Failure = {
            ...failure,
            kind: 'tool-error',
            retryable: failure.retryable ?? false,
          }
          failures.push(toolFailure)
          output = { error: failure.message }
          emit('tool/error', { callId: call.id, name: call.name, message: failure.message })
        }
      }

      toolCalls.push({ id: call.id, name: call.name, args, ok })
      emit('tool/result', { callId: call.id, name: call.name, ok, output })
      messages.push({
        role: 'tool',
        content: JSON.stringify(output),
        toolCallId: call.id,
        toolName: call.name,
        ...ok ? {} : { isError: true },
      })
    }
  }

  return finishWithError({
    kind: 'model-error',
    message: `max steps (${maxSteps}) exceeded`,
    retryable: false,
  })
}

function parseArguments(raw: string): JsonValue {
  if (raw.trim() === '') return null
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    return null
  }
}
