/**
 * s16 的核心：一个零依赖的 PTC（programmatic tool calling）runtime。
 *
 * 模型不直接发起 N 次工具调用，而是写一段 JS 程序；runtime 把已注册的工具
 * 绑定成程序里的 `tools.<name>(args)`，执行完后只把最终结果交回模型。
 *
 * 这个最小实现刻意保留真实 `dsh-ptc-runtime` 的四个可观察语义：
 *   1. 工具调用可以是异步的，program 可以 await / Promise.all；
 *   2. 工具结果跨边界前被序列化成 lossless JSON；
 *   3. 工具异常变成结构化失败（program 可以 try/catch，也可以让它冒泡）；
 *   4. 每次 run 有独立的超时/取消，并可以选择 fresh 或 persistent scope。
 *
 * 它**不是沙箱**：`new AsyncFunction` 与宿主同进程、同权限。真实 DSH 的
 * Node backend 会把程序放进受管理的子进程；本课只讲调用协议。
 */

import { ToolRegistry } from './tools.ts'
import type { PtcToolContext, PtcToolDefinition } from './tools.ts'

// ---------------------------------------------------------------------------
// 词汇表
// ---------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type PtcFailureKind =
  | 'invalid-program'
  | 'exception'
  | 'tool-error'
  | 'timeout'
  | 'abort'
  | 'serialization'

export interface PtcFailure {
  kind: PtcFailureKind
  code: string
  message: string
  /** 仅 tool-error：出错的工具名。 */
  tool?: string
}

/** 一次 program 里发生过的工具调用；用于 demo / 测试 / 观测。 */
export interface PtcCallRecord {
  tool: string
  args: JsonValue
  ok: boolean
  value?: JsonValue
  error?: PtcFailure
  durationMs: number
}

export interface PtcRunResult {
  ok: boolean
  /** program 的返回值（已 JSON 序列化）；失败时为 null。 */
  value: JsonValue
  /** program 里 console.* 的输出。 */
  logs: string[]
  calls: PtcCallRecord[]
  error?: PtcFailure
  durationMs: number
}

/**
 * 跨 run 的变量容器。
 *
 * 默认每次 run 新建一个；传入同一个对象即可让 `scope.count` 之类的变量
 * 在多次 run 之间保留。它是显式状态，不是 REPL 的隐式变量表。
 */
export interface PtcScope {
  [key: string]: unknown
}

export interface PtcRunOptions {
  signal?: AbortSignal
  timeoutMs?: number
  scope?: PtcScope
}

export interface PtcRuntimeOptions {
  tools?: ToolRegistry
  /** 默认超时；不传表示不设 deadline。 */
  timeoutMs?: number
  /** 防止 program 刷屏；默认 100 行。 */
  maxLogs?: number
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export class PtcToolError extends Error {
  readonly code: string
  readonly tool: string

  constructor(message: string, code: string, tool: string) {
    super(message)
    this.name = 'PtcToolError'
    this.code = code
    this.tool = tool
  }
}

export class PtcAbortError extends Error {
  readonly kind: 'abort' | 'timeout'

  constructor(kind: 'abort' | 'timeout') {
    super(kind === 'timeout' ? 'program timed out' : 'program aborted')
    this.name = 'PtcAbortError'
    this.kind = kind
  }
}

export class PtcSerializationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PtcSerializationError'
  }
}

// ---------------------------------------------------------------------------
// 序列化：工具结果与 program 返回值都必须是 JSON 可表达的
// ---------------------------------------------------------------------------

function convert(value: unknown, seen: WeakSet<object>): JsonValue {
  if (value === null) return null
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return `${value}n`
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    const code = (value as Error & { code?: unknown }).code
    return {
      name: value.name,
      message: value.message,
      ...typeof code === 'string' ? { code } : {},
    }
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new PtcSerializationError('circular structure cannot cross the PTC boundary')
    }
    seen.add(value)
    try {
      if (Array.isArray(value)) return value.map(item => convert(item, seen))
      if (value instanceof Map) {
        return Object.fromEntries([...value.entries()].map(([key, item]) => [String(key), convert(item, seen)]))
      }
      if (value instanceof Set) return [...value].map(item => convert(item, seen))
      const result: { [key: string]: JsonValue } = {}
      for (const [key, item] of Object.entries(value)) result[key] = convert(item, seen)
      return result
    } finally {
      seen.delete(value)
    }
  }
  return null
}

/** 严格序列化；循环引用会抛 PtcSerializationError。 */
export function toJsonValue(value: unknown): JsonValue {
  return convert(value, new WeakSet<object>())
}

/** 用于调用记录/日志的宽松序列化，永不抛错。 */
function preview(value: unknown): JsonValue {
  try {
    return toJsonValue(value)
  } catch {
    return '[unserializable]'
  }
}

function formatLog(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(toJsonValue(value)) ?? String(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// 失败归类
// ---------------------------------------------------------------------------

function failureOf(error: unknown): PtcFailure {
  if (error instanceof PtcAbortError) {
    return {
      kind: error.kind,
      code: error.kind === 'timeout' ? 'TIMEOUT' : 'ABORTED',
      message: error.message,
    }
  }
  if (error instanceof PtcToolError) {
    return { kind: 'tool-error', code: error.code, message: error.message, tool: error.tool }
  }
  if (error instanceof PtcSerializationError) {
    return { kind: 'serialization', code: 'SERIALIZATION', message: error.message }
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return {
      kind: 'exception',
      code: typeof code === 'string' ? code : 'EXCEPTION',
      message: error.message,
    }
  }
  return { kind: 'exception', code: 'EXCEPTION', message: String(error) }
}

// AsyncFunction 的构造器签名（Node 原生支持，无需依赖）。
type AsyncFunctionConstructor = new (...args: string[]) => (...args: unknown[]) => Promise<unknown>
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as AsyncFunctionConstructor

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class PtcRuntime {
  readonly registry: ToolRegistry
  #timeoutMs: number | undefined
  #maxLogs: number

  constructor(options: PtcRuntimeOptions = {}) {
    this.registry = options.tools ?? new ToolRegistry()
    this.#timeoutMs = options.timeoutMs
    this.#maxLogs = options.maxLogs ?? 100
  }

  /** 注册一个工具，返回注销函数。 */
  register(tool: PtcToolDefinition): () => void {
    return this.registry.register(tool)
  }

  /** 新建一个独立 scope；同一对象传给多次 run 即可持久化变量。 */
  createScope(): PtcScope {
    return {}
  }

  /**
   * 执行一段模型生成的 JS。
   *
   * program 是 async 函数体：可以写 `return`、顶层 `await`，并通过
   * `tools.<name>(args)` 调用工具。所有失败都变成 `PtcRunResult.error`，
   * 本方法不向调用方抛异常（调用方误用除外）。
   */
  async run(program: string, options: PtcRunOptions = {}): Promise<PtcRunResult> {
    const startedAt = performance.now()
    const logs: string[] = []
    const calls: PtcCallRecord[] = []
    const scope: PtcScope = options.scope ?? {}
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs

    const controller = new AbortController()
    const external = options.signal
    const forwardAbort = (): void => controller.abort(external?.reason)
    if (external !== undefined) {
      if (external.aborted) controller.abort(external.reason)
      else external.addEventListener('abort', forwardAbort, { once: true })
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    let timedOut = false
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
    }

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      if (external !== undefined) external.removeEventListener('abort', forwardAbort)
      if (abortListener !== undefined) controller.signal.removeEventListener('abort', abortListener)
    }

    const finish = (result: Omit<PtcRunResult, 'durationMs'>): PtcRunResult => {
      cleanup()
      return { ...result, durationMs: Math.max(0, Math.round(performance.now() - startedAt)) }
    }

    // 已经取消：不要执行模型代码。
    if (controller.signal.aborted) {
      return finish({
        ok: false,
        value: null,
        logs,
        calls,
        error: {
          kind: timedOut ? 'timeout' : 'abort',
          code: timedOut ? 'TIMEOUT' : 'ABORTED',
          message: timedOut ? 'program timed out' : 'program aborted',
        },
      })
    }

    const pushLog = (...args: unknown[]): void => {
      if (logs.length >= this.#maxLogs) return
      logs.push(args.map(formatLog).join(' '))
    }
    const capturedConsole = {
      log: pushLog,
      info: pushLog,
      warn: pushLog,
      error: pushLog,
      debug: pushLog,
    }

    let callSeq = 0
    const runId = `run-${Math.random().toString(36).slice(2, 8)}`

    const callTool = async (name: string, args: unknown): Promise<JsonValue> => {
      const tool = this.registry.get(name)
      if (tool === undefined) {
        throw new PtcToolError(`unknown tool "${name}"`, 'UNKNOWN_TOOL', name)
      }

      const callId = `${runId}:${callSeq += 1}`
      const argsPreview = preview(args)
      const callStartedAt = performance.now()

      const recordFailure = (failure: PtcFailure): void => {
        calls.push({
          tool: name,
          args: argsPreview,
          ok: false,
          error: failure,
          durationMs: Math.max(0, Math.round(performance.now() - callStartedAt)),
        })
      }

      const ctx: PtcToolContext = { signal: controller.signal, callId }
      let raw: unknown
      try {
        raw = await tool.run(args, ctx)
      } catch (error) {
        if (controller.signal.aborted) {
          const abort = new PtcAbortError(timedOut ? 'timeout' : 'abort')
          recordFailure(failureOf(abort))
          throw abort
        }
        if (error instanceof PtcToolError) {
          recordFailure(failureOf(error))
          throw error
        }
        const code = error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'
          ? String((error as Error & { code?: unknown }).code)
          : 'TOOL_ERROR'
        const wrapped = new PtcToolError(
          error instanceof Error ? error.message : String(error),
          code,
          name,
        )
        recordFailure(failureOf(wrapped))
        throw wrapped
      }

      let value: JsonValue
      try {
        value = toJsonValue(raw)
      } catch (error) {
        const failure = failureOf(error)
        recordFailure(failure)
        throw error
      }

      calls.push({
        tool: name,
        args: argsPreview,
        ok: true,
        value,
        durationMs: Math.max(0, Math.round(performance.now() - callStartedAt)),
      })
      return value
    }

    // Proxy 让未知工具名也变成结构化错误，而不是 “x is not a function”。
    const tools = new Proxy<Record<string, (args?: unknown) => Promise<JsonValue>>>({}, {
      get: (_target, property) => {
        if (typeof property !== 'string' || property === 'then') return undefined
        return (args: unknown = {}) => callTool(property, args)
      },
      has: (_target, property) => typeof property === 'string' && this.registry.get(property) !== undefined,
      ownKeys: () => this.registry.list().map(tool => tool.name),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    })

    let programFunction: (...args: unknown[]) => Promise<unknown>
    try {
      programFunction = AsyncFunction('tools', 'console', 'scope', program)
    } catch (error) {
      return finish({
        ok: false,
        value: null,
        logs,
        calls,
        error: {
          kind: 'invalid-program',
          code: 'INVALID_PROGRAM',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }

    const programPromise = (async (): Promise<unknown> => await programFunction(tools, capturedConsole, scope))()
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(new PtcAbortError(timedOut ? 'timeout' : 'abort'))
      if (controller.signal.aborted) abortListener()
      else controller.signal.addEventListener('abort', abortListener, { once: true })
    })

    let value: unknown
    try {
      value = await Promise.race([programPromise, abortPromise])
    } catch (error) {
      return finish({ ok: false, value: null, logs, calls, error: failureOf(error) })
    }

    // program 正常结束后，若外部紧接着取消，以取消为准。
    if (controller.signal.aborted) {
      return finish({
        ok: false,
        value: null,
        logs,
        calls,
        error: {
          kind: timedOut ? 'timeout' : 'abort',
          code: timedOut ? 'TIMEOUT' : 'ABORTED',
          message: timedOut ? 'program timed out' : 'program aborted',
        },
      })
    }

    let serialized: JsonValue
    try {
      serialized = toJsonValue(value)
    } catch (error) {
      return finish({ ok: false, value: null, logs, calls, error: failureOf(error) })
    }

    return finish({ ok: true, value: serialized, logs, calls })
  }
}
