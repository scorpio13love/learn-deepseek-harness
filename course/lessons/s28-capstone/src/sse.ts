/** 最小 SSE 解码器：处理跨 chunk 帧、CRLF、多行 data 和 [DONE]。 */

export class SseDecoder {
  #buffer = ''

  push(chunk: string): string[] {
    this.#buffer += chunk
    const payloads: string[] = []

    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.#buffer)
      if (match === null) break
      const block = this.#buffer.slice(0, match.index)
      this.#buffer = this.#buffer.slice(match.index + match[0].length)
      const payload = parseBlock(block)
      if (payload !== undefined) payloads.push(payload)
    }

    return payloads
  }

  flush(): string[] {
    const block = this.#buffer
    this.#buffer = ''
    const payload = parseBlock(block)
    return payload === undefined ? [] : [payload]
  }
}

function parseBlock(block: string): string | undefined {
  const data: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    data.push(line.slice(5).replace(/^ /, ''))
  }
  return data.length === 0 ? undefined : data.join('\n')
}
