/** record / replay：记录 request + chunk，异常也记录。 */

import type { Model, ModelRequest, ModelChunk } from './types.ts'

export interface SerializedError {
  name: string
  message: string
  code?: string
}

export interface RecordedCall {
  request: ModelRequest
  chunks: ModelChunk[]
  /** 流中途抛出的异常；replay 会在相同位置重抛。 */
  error?: SerializedError
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...typeof (error as { code?: unknown }).code === 'string'
        ? { code: (error as { code: string }).code }
        : {},
    }
  }
  return { name: 'Error', message: String(error) }
}

function reviveError(error: SerializedError): Error {
  const revived = new Error(error.message)
  revived.name = error.name
  if (error.code !== undefined) (revived as Error & { code?: string }).code = error.code
  return revived
}

export class RecordingModel implements Model {
  readonly provider: string
  readonly model: string
  readonly calls: RecordedCall[] = []
  #inner: Model

  constructor(inner: Model) {
    this.#inner = inner
    this.provider = inner.provider
    this.model = inner.model
  }

  get records(): readonly RecordedCall[] {
    return this.calls
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelChunk> {
    const record: RecordedCall = {
      request: structuredClone(request),
      chunks: [],
    }
    this.calls.push(record)
    try {
      for await (const chunk of this.#inner.stream(request, signal)) {
        record.chunks.push(structuredClone(chunk))
        yield chunk
      }
    } catch (error) {
      record.error = serializeError(error)
      throw error
    }
  }
}

export class ReplayModel implements Model {
  readonly provider: string
  readonly model: string
  #records: readonly RecordedCall[]
  #cursor = 0

  constructor(records: readonly RecordedCall[], identity: { provider: string; model: string } = { provider: 'replay', model: 'replay' }) {
    this.#records = records
    this.provider = identity.provider
    this.model = identity.model
  }

  get consumed(): number {
    return this.#cursor
  }

  async *stream(_request: ModelRequest, _signal?: AbortSignal): AsyncIterable<ModelChunk> {
    const record = this.#records[this.#cursor]
    if (record === undefined) throw new Error('replay exhausted: model was called more times than recorded')
    this.#cursor += 1
    for (const chunk of record.chunks) yield structuredClone(chunk)
    if (record.error !== undefined) throw reviveError(record.error)
  }
}

export function serializeRecords(records: readonly RecordedCall[]): string {
  return JSON.stringify({ version: 1, records }, null, 2)
}

export function deserializeRecords(json: string): RecordedCall[] {
  const parsed = JSON.parse(json) as { version?: unknown; records?: unknown }
  if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
    throw new TypeError('invalid record file: expected { version: 1, records: [...] }')
  }
  return parsed.records as RecordedCall[]
}
