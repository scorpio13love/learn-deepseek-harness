/** 故障注入模型：429、超时、断流、工具错误。全部离线。 */

import type { Failure, Model, ModelChunk, ModelRequest } from './types.ts'

export const RATE_LIMIT_FAILURE: Failure = {
  kind: 'rate-limit',
  message: '429 Too Many Requests',
  status: 429,
  code: 'RATE_LIMITED',
  retryable: true,
}

export const TIMEOUT_FAILURE: Failure = {
  kind: 'timeout',
  message: 'request timed out after 120000ms',
  code: 'ETIMEDOUT',
  retryable: true,
}

export const DISCONNECT_FAILURE: Failure = {
  kind: 'disconnect',
  message: 'stream closed by peer',
  code: 'STREAM_CLOSED',
  retryable: true,
}

export class RateLimitModel implements Model {
  readonly provider = 'fault'
  readonly model = 'rate-limit'

  async *stream(_request: ModelRequest): AsyncIterable<ModelChunk> {
    yield { type: 'finish', reason: 'error', failure: RATE_LIMIT_FAILURE }
  }
}

/** 超时用抛异常模拟，验证 classifier 能把 name/code 归一化。 */
export class TimeoutModel implements Model {
  readonly provider = 'fault'
  readonly model = 'timeout'

  async *stream(_request: ModelRequest): AsyncIterable<ModelChunk> {
    yield { type: 'text-delta', text: 'thinking' }
    const error = new Error(TIMEOUT_FAILURE.message)
    error.name = 'TimeoutError'
    ;(error as Error & { code?: string }).code = 'ETIMEDOUT'
    throw error
  }
}

/** 中途断流：先交付一个前缀，再抛可重放的错误。 */
export class DisconnectModel implements Model {
  readonly provider = 'fault'
  readonly model = 'disconnect'

  async *stream(_request: ModelRequest): AsyncIterable<ModelChunk> {
    yield { type: 'text-delta', text: 'partial answer' }
    const error = new Error(DISCONNECT_FAILURE.message)
    ;(error as Error & { code?: string }).code = 'STREAM_CLOSED'
    throw error
  }
}

/**
 * 第一次请求调用一个必然失败的工具；第二次请求看到 tool 错误后回答。
 * 这样 tool-error 是非终止失败，能被 runner 单独断言。
 */
export class ToolErrorModel implements Model {
  readonly provider = 'fault'
  readonly model = 'tool-error'
  #calls = 0

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    this.#calls += 1
    const toolMessages = request.messages.filter(message => message.role === 'tool')
    if (toolMessages.length === 0) {
      yield { type: 'tool-call', id: 'call-fail-1', name: 'fail_tool', arguments: '{"reason":"boom"}' }
      yield { type: 'finish', reason: 'tool-calls' }
      return
    }
    yield { type: 'text-delta', text: '工具失败了，我改用只读方案。' }
    yield { type: 'finish', reason: 'stop' }
  }
}

export interface FaultCase {
  id: string
  kind: Failure['kind']
  createModel(): Model
}

/** 故障矩阵：测试和 demo 共用，避免两处漂移。 */
export function faultMatrix(): FaultCase[] {
  return [
    { id: 'rate-limit', kind: 'rate-limit', createModel: () => new RateLimitModel() },
    { id: 'timeout', kind: 'timeout', createModel: () => new TimeoutModel() },
    { id: 'disconnect', kind: 'disconnect', createModel: () => new DisconnectModel() },
    { id: 'tool-error', kind: 'tool-error', createModel: () => new ToolErrorModel() },
  ]
}
