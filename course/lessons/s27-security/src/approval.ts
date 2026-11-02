/** fail-closed 审批：只有一次明确的 allowed-once 才放行。 */

import type { JsonValue } from './redact.ts'
import { redactValue } from './redact.ts'

export type ApprovalDecision = 'allowed-once' | 'denied'

export interface ApprovalRequest {
  id: string
  toolName: string
  summary: string
  args: unknown
  signal?: AbortSignal
}

export interface ApprovalService {
  request(request: ApprovalRequest): Promise<ApprovalDecision>
}

export interface ApprovalAuditEntry {
  at: number
  requestId: string
  toolName: string
  decision: ApprovalDecision
  reason: string
  args: JsonValue
}

export class DenyAllApproval implements ApprovalService {
  async request(): Promise<ApprovalDecision> {
    return 'denied'
  }
}

export interface FailClosedOptions {
  /** 默认 5s。超时返回 denied。 */
  timeoutMs?: number
  /** 逻辑时间，测试注入。 */
  now?: () => number
}

/**
 * 决策函数的任何异常、超时、取消、未知返回值都收敛成 denied。
 * request() 本身不会 reject。
 */
export class FailClosedApproval implements ApprovalService {
  #decide: (request: ApprovalRequest) => Promise<ApprovalDecision | string | undefined> | ApprovalDecision | string | undefined
  #timeoutMs: number
  #now: () => number
  #ledger: ApprovalAuditEntry[] = []

  constructor(
    decide: (request: ApprovalRequest) => Promise<ApprovalDecision | string | undefined> | ApprovalDecision | string | undefined,
    options: FailClosedOptions = {},
  ) {
    this.#decide = decide
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? 5_000)
    this.#now = options.now ?? (() => Date.now())
  }

  get ledger(): readonly ApprovalAuditEntry[] {
    return this.#ledger.map(entry => ({ ...entry }))
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const record = (decision: ApprovalDecision, reason: string): ApprovalDecision => {
      this.#ledger.push({
        at: this.#now(),
        requestId: request.id,
        toolName: request.toolName,
        decision,
        reason,
        args: redactValue(request.args),
      })
      return decision
    }

    if (request.signal?.aborted === true) return record('denied', 'aborted-before-request')

    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined

    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('approval timeout')), this.#timeoutMs)
      })

      const aborted = new Promise<never>((_resolve, reject) => {
        if (request.signal === undefined) return
        onAbort = () => reject(new Error('approval aborted'))
        if (request.signal.aborted) onAbort()
        else request.signal.addEventListener('abort', onAbort, { once: true })
      })

      const decision = await Promise.race([
        Promise.resolve(this.#decide(request)),
        timeout,
        aborted,
      ])

      if (decision === 'allowed-once') return record('allowed-once', 'explicit-allow')
      return record('denied', decision === 'denied' ? 'explicit-deny' : 'unknown-decision')
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'approval-error'
      return record('denied', reason)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) request.signal?.removeEventListener('abort', onAbort)
    }
  }
}

/** 只对满足谓词的请求明确放行；其余走 fail-closed。 */
export function allowListApproval(
  predicate: (request: ApprovalRequest) => boolean,
  options: FailClosedOptions = {},
): FailClosedApproval {
  return new FailClosedApproval(
    request => predicate(request) ? 'allowed-once' : 'denied',
    options,
  )
}
