/** 按 code point 截断，避免切断 surrogate pair。 */

export interface TruncatedText {
  text: string
  truncated: boolean
  originalLength: number
  returnedLength: number
  omitted: number
}

export interface TruncateOptions {
  /**
   * 自定义 marker；默认 `… [truncated N chars]`。
   * marker 也计入 maxChars。
   */
  marker?: (omitted: number) => string
}

export function truncateText(input: string, maxChars: number, options: TruncateOptions = {}): TruncatedText {
  if (!Number.isInteger(maxChars) || maxChars < 0) {
    throw new TypeError('maxChars must be a non-negative integer')
  }

  const chars = Array.from(input)
  const originalLength = chars.length
  if (originalLength <= maxChars) {
    return {
      text: input,
      truncated: false,
      originalLength,
      returnedLength: originalLength,
      omitted: 0,
    }
  }

  const makeMarker = options.marker ?? ((omitted: number) => `… [truncated ${omitted} chars]`)

  // marker 里的 omitted 会随保留长度变化；迭代到稳定，默认 marker 通常 1–2 次即可。
  let omitted = originalLength - maxChars
  let keep = 0
  let marker = ''
  for (let attempt = 0; attempt < 5; attempt += 1) {
    marker = makeMarker(omitted)
    const markerLength = Array.from(marker).length
    if (markerLength >= maxChars) {
      // marker 本身超限时，退化成硬截断；仍然保证结果长度 <= maxChars。
      const text = chars.slice(0, maxChars).join('')
      return {
        text,
        truncated: true,
        originalLength,
        returnedLength: maxChars,
        omitted: originalLength - maxChars,
      }
    }
    keep = maxChars - markerLength
    const nextOmitted = originalLength - keep
    if (nextOmitted === omitted) break
    omitted = nextOmitted
  }

  const text = chars.slice(0, keep).join('') + marker
  return {
    text,
    truncated: true,
    originalLength,
    returnedLength: Array.from(text).length,
    omitted: originalLength - keep,
  }
}

export function truncateToolOutput(input: string, maxChars = 2_000): TruncatedText {
  return truncateText(input, maxChars)
}
