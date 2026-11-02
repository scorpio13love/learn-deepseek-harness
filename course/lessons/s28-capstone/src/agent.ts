/** 多步工具循环：模型回合 → tool calls → tool messages → 下一回合。 */

import type { ApprovalService } from './approval.ts'
import type { ToolDefinition } from './tools.ts'
import { compactToolArgs } from './tools.ts'
import type {
  AgentResult,
  ChatMessage,
  JsonObject,
  JsonValue,
  Model,
  ModelFailure,
  SessionEvent,
  Usage,
} from './types.ts'
import { emptyUsage } from './types.ts'
import { Workspace } from './workspace.ts'

export type RecordEvent = (type: string, data: JsonObject) => Promise<SessionEvent>

export interface RunAgentOptions {
  model: Model
  messages: ChatMessage[]
  tools: ToolDefinition[]
  workspace: Workspace
  approval: ApprovalService
  record: RecordEvent
  maxSteps?: number
  signal?: AbortSignal
}

function failureOf(error: unknown): ModelFailure {
  if (typeof error === 'object' && error !== null) {
    const value = error as { kind?: unknown; message?: unknown; status?: unknown; retryable?: unknown }
    if (typeof value.kind === 'string') {
      return {
        kind: value.kind as ModelFailure['kind'],
        message: typeof value.message === 'string' ? value.message : value.kind,
        ...typeof value.status === 'number' ? { status: value.status } : {},
        ...typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {},
      }
    }
  }
  return { kind: 'unknown', message: error instanceof Error ? error.message : String(error), retryable: false }
}

function summarizeOutput(name: string, output: JsonValue): JsonObject {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return { preview: String(output).slice(0, 120) }
  }
  const record = output as JsonObject
  if (name === 'list_files') {
    return {
      files: Array.isArray(record.files) ? record.files.length : 0,
      truncated: record.truncated === true,
    }
  }
  if (name === 'read_file') {
    return {
      path: typeof record.path === 'string' ? record.path : '',
      chars: typeof record.chars === 'number' ? record.chars : 0,
      truncated: record.truncated === true,
    }
  }
  if (name === 'search_text') {
    return {
      matches: Array.isArray(record.matches) ? record.matches.length : 0,
      scannedFiles: typeof record.scannedFiles === 'number' ? record.scannedFiles : 0,
    }
  }
  if (name === 'write_file') {
    return {
      path: typeof record.path === 'string' ? record.path : '',
      bytes: typeof record.bytes === 'number' ? record.bytes : 0,
    }
  }
  return { preview: JSON.stringify(record).slice(0, 160) }
}

export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const maxSteps = options.maxSteps ?? 8
  const messages = [...options.messages]
  const toolCalls: AgentResult['toolCalls'] = []
  const texts: string[] = []
  let usage: Usage = emptyUsage()
  let steps = 0

  const finish = async (failure?: ModelFailure): Promise<AgentResult> => {
    if (failure !== undefined) {
      await options.record('error', {
        kind: failure.kind,
        message: failure.message,
        retryable: failure.retryable === true,
      })
      await options.record('run/end', { status: 'error', failure: failure.kind })
      return {
        outcome: { kind: 'error', failure },
        steps,
        usage,
        toolCalls,
        text: texts.join('\n'),
        messages,
      }
    }
    await options.record('run/end', { status: 'ok' })
    return {
      outcome: { kind: 'ok' },
      steps,
      usage,
      toolCalls,
      text: texts.join('\n'),
      messages,
    }
  }

  for (let step = 1; step <= maxSteps; step += 1) {
    steps = step
    await options.record('step/start', { step, messageCount: messages.length })
    await options.record('turn/start', { turn: step })

    const turn = await options.model.complete({
      messages: messages.map(message => ({ ...message })),
      tools: options.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    }, {
      ...options.signal === undefined ? {} : { signal: options.signal },
    })

    usage = {
      inputTokens: usage.inputTokens + turn.usage.inputTokens,
      outputTokens: usage.outputTokens + turn.usage.outputTokens,
    }
    await options.record('usage', { ...usage })

    if (turn.finishReason === 'error' || turn.failure !== undefined) {
      await options.record('turn/end', { turn: step, status: 'error' })
      return finish(turn.failure ?? { kind: 'unknown', message: 'model returned an error', retryable: false })
    }

    if (turn.text !== '') {
      texts.push(turn.text)
      await options.record('assistant/text', { turn: step, text: turn.text })
    }

    messages.push({
      role: 'assistant',
      content: turn.text,
      ...turn.toolCalls.length === 0 ? {} : { toolCalls: turn.toolCalls },
    })

    if (turn.toolCalls.length === 0) {
      await options.record('turn/end', { turn: step, status: 'ok' })
      return finish()
    }

    for (const call of turn.toolCalls) {
      const args = typeof call.arguments === 'object' && call.arguments !== null && !Array.isArray(call.arguments)
        ? call.arguments as JsonObject
        : null

      await options.record('tool/call', {
        turn: step,
        callId: call.id,
        name: call.name,
        args: args === null ? {} : compactToolArgs(call.name, args),
      })

      let ok = true
      let output: JsonValue
      const tool = options.tools.find(candidate => candidate.name === call.name)

      try {
        if (args === null) throw new TypeError('tool arguments must be a JSON object')
        if (tool === undefined) throw new Error(`unknown tool: ${call.name}`)
        output = await tool.run(args, {
          workspace: options.workspace,
          approval: options.approval,
          ...options.signal === undefined ? {} : { signal: options.signal },
        })
      } catch (error) {
        ok = false
        const failure = failureOf(error)
        output = { error: { code: failure.kind, message: failure.message } }
        await options.record('error', {
          kind: 'tool-error',
          tool: call.name,
          message: failure.message,
        })
      }

      toolCalls.push({ name: call.name, args: args === null ? null : compactToolArgs(call.name, args), ok })
      await options.record('tool/result', {
        turn: step,
        callId: call.id,
        name: call.name,
        ok,
        summary: summarizeOutput(call.name, output),
      })
      messages.push({
        role: 'tool',
        content: JSON.stringify(output),
        toolCallId: call.id,
        name: call.name,
        ...ok ? {} : { isError: true },
      })
    }

    await options.record('turn/end', { turn: step, status: 'ok' })
  }

  return finish({
    kind: 'unknown',
    message: `max steps (${maxSteps}) exceeded`,
    retryable: false,
  })
}
