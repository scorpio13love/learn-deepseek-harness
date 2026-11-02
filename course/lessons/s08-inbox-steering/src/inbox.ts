/**
 * s07 的 inbox：两条有序待处理队列。
 *
 * - `next-turn`：每条消息独占一个新轮次（followup）；
 * - `next-step`：在下个步骤边界消费（steer / inject）。
 *
 * 轮次边界领取全部 next-step + 一条 next-turn；步骤之间只领取 next-step。
 * 真实实现见 `packages/core/agent-loop/src/inbox.ts`；s07 先做内存版本。
 */

import type { Message } from './types.ts'

export type InboxTarget = 'next-turn' | 'next-step'

export class Inbox {
  #nextTurn: Message[] = []
  #nextStep: Message[] = []

  get nextTurn(): readonly Message[] {
    return this.#nextTurn
  }

  get nextStep(): readonly Message[] {
    return this.#nextStep
  }

  get hasPending(): boolean {
    return this.#nextTurn.length > 0 || this.#nextStep.length > 0
  }

  append(target: InboxTarget, message: Message): void {
    this.#assertUnique(message)
    this.#list(target).push(message)
  }

  prepend(target: InboxTarget, message: Message): void {
    this.#assertUnique(message)
    this.#list(target).unshift(message)
  }

  replace(messageId: string, message: Message): boolean {
    for (const list of [this.#nextTurn, this.#nextStep]) {
      const index = list.findIndex(item => item.id === messageId)
      if (index < 0) continue
      if (message.id !== messageId) this.#assertUnique(message)
      list[index] = message
      return true
    }
    return false
  }

  remove(messageId: string): boolean {
    for (const list of [this.#nextTurn, this.#nextStep]) {
      const index = list.findIndex(item => item.id === messageId)
      if (index < 0) continue
      list.splice(index, 1)
      return true
    }
    return false
  }

  clear(): void {
    this.#nextTurn = []
    this.#nextStep = []
  }

  /**
   * 领取：纯删除。
   * - 'turn'：全部 next-step + 一条 next-turn；
   * - 'step'：全部 next-step。
   */
  claim(target: 'turn' | 'step'): Message[] {
    if (target === 'step') {
      const claimed = this.#nextStep
      this.#nextStep = []
      return claimed
    }
    const claimed = [...this.#nextStep]
    this.#nextStep = []
    const first = this.#nextTurn.shift()
    if (first !== undefined) claimed.push(first)
    return claimed
  }

  #list(target: InboxTarget): Message[] {
    return target === 'next-turn' ? this.#nextTurn : this.#nextStep
  }

  #assertUnique(message: Message): void {
    if (this.#nextTurn.some(item => item.id === message.id)
      || this.#nextStep.some(item => item.id === message.id)) {
      throw new Error(`message "${message.id}" is already pending`)
    }
  }
}
