/** 审批：默认拒绝；capstone 只允许写 audit.md。 */

import type { JsonObject } from './types.ts'

export type ApprovalDecision = 'allowed-once' | 'denied'

export interface ApprovalRequest {
  id: string
  toolName: string
  summary: string
  /** 工作区相对路径；用于 allowlist 与 surface 摘要。 */
  path?: string
  args: JsonObject
  signal?: AbortSignal
}

export interface ApprovalService {
  request(request: ApprovalRequest): Promise<ApprovalDecision>
}

export class DenyAllApproval implements ApprovalService {
  async request(): Promise<ApprovalDecision> {
    return 'denied'
  }
}

export class AllowPathsApproval implements ApprovalService {
  #allowed: Set<string>

  constructor(paths: readonly string[]) {
    this.#allowed = new Set(paths)
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const path = request.path?.replace(/^\.\//, '')
    return path !== undefined && this.#allowed.has(path) ? 'allowed-once' : 'denied'
  }
}

/**
 * 把审批请求/结果写进事件日志，并保证异常也是 denied。
 */
export class EventedApproval implements ApprovalService {
  #inner: ApprovalService
  #emit: (type: string, data: JsonObject) => Promise<unknown>

  constructor(inner: ApprovalService, emit: (type: string, data: JsonObject) => Promise<unknown>) {
    this.#inner = inner
    this.#emit = emit
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    await this.#emit('approval/request', {
      id: request.id,
      toolName: request.toolName,
      path: request.path ?? null,
      summary: request.summary,
    })

    let decision: ApprovalDecision = 'denied'
    try {
      const result = await this.#inner.request(request)
      decision = result === 'allowed-once' ? 'allowed-once' : 'denied'
    } catch {
      decision = 'denied'
    }

    await this.#emit('approval/decision', {
      id: request.id,
      decision,
      toolName: request.toolName,
      path: request.path ?? null,
    })
    return decision
  }
}

export class ApprovalDeniedError extends Error {
  readonly code = 'APPROVAL_DENIED'

  constructor(path: string) {
    super(`write_file "${path}" was not approved`)
    this.name = 'ApprovalDeniedError'
  }
}
