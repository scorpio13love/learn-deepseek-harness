/**
 * s12 · composition / boot：沿用前序课程的实现（本课改动见 README）。
 */

import type { Message, ToolCallBlock, ToolResult } from './types.ts'

export interface ToolBatchResult {
  /** 与输入 calls 对齐的模型顺序结果。 */
  results: ToolResult[]
  /** 按模型顺序汇总的额外上下文。 */
  additionalContexts: Message[]
  /** 是否有成功结果主动结束轮次。 */
  concluded: boolean
  aborted: boolean
}

export function abortedResult(): ToolResult {
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
  }
}

/**
 * 执行一个模型调用批次。
 * @param calls 模型给出的调用顺序。
 * @param executeOne 单次执行；pipeline 负责策略/校验/渲染。
 * @param parallel 是否允许与兄弟调用并发。
 * @param maxParallel 并发上限。
 * @param signal 批次取消信号。
 */
export async function executeToolBatch(
  calls: readonly ToolCallBlock[],
  executeOne: (call: ToolCallBlock) => Promise<ToolResult>,
  parallel: (call: ToolCallBlock) => boolean,
  maxParallel: number,
  signal: AbortSignal,
): Promise<ToolBatchResult> {
  if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) {
    throw new RangeError('maxParallel must be a positive integer')
  }

  const results: (ToolResult | undefined)[] = calls.map(() => undefined)
  let aborted = signal.aborted

  const runOne = async (index: number): Promise<void> => {
    const call = calls[index]
    if (call === undefined) return
    if (signal.aborted) {
      aborted = true
      results[index] = abortedResult()
      return
    }
    try {
      results[index] = await executeOne(call)
    } catch (error) {
      if (signal.aborted) {
        aborted = true
        results[index] = abortedResult()
        return
      }
      results[index] = {
        content: [{
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      }
    }
  }

  let next = 0
  while (next < calls.length) {
    if (signal.aborted) {
      aborted = true
      break
    }
    const call = calls[next]!
    if (!parallel(call)) {
      await runOne(next)
      next += 1
      continue
    }

    const group: number[] = []
    while (next < calls.length) {
      const candidate = calls[next]!
      if (!parallel(candidate)) break
      group.push(next)
      next += 1
    }

    let cursor = 0
    const workers = Array.from({ length: Math.min(maxParallel, group.length) }, async () => {
      while (true) {
        const index = group[cursor]
        cursor += 1
        if (index === undefined) return
        await runOne(index)
        if (signal.aborted) {
          aborted = true
          return
        }
      }
    })
    await Promise.all(workers)
  }

  if (signal.aborted) aborted = true
  for (let index = 0; index < results.length; index += 1) {
    if (results[index] === undefined) results[index] = abortedResult()
  }

  const final = results as ToolResult[]
  return {
    results: final,
    additionalContexts: final.flatMap(result => result.additionalContexts ?? []),
    concluded: final.some(result => result.isError === false && result.concludesTurn === true),
    aborted,
  }
}
