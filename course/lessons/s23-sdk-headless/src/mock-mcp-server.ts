/**
 * s17 · SDK / headless：沿用前序课程的实现（本课改动见 README）。
 */

import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })

lines.on('line', (line) => {
  if (line.trim().length === 0) return
  const message = JSON.parse(line) as {
    id?: number
    method?: string
    params?: { name?: string; arguments?: { text?: string } }
  }
  if (message.id === undefined) return
  const reply = (result: unknown): void => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
  }
  const fail = (code: number, text: string): void => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })}\n`)
  }

  switch (message.method) {
    case 'initialize':
      reply({ protocolVersion: '2024-11-05', serverInfo: { name: 'mock', version: '0.0.0' }, capabilities: {} })
      break
    case 'tools/list':
      reply({
        tools: [{
          name: 'echo',
          description: 'Echo text.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        }],
      })
      break
    case 'tools/call':
      if (message.params?.name !== 'echo') {
        fail(-32601, `unknown tool ${String(message.params?.name)}`)
        break
      }
      reply({ content: [{ type: 'text', text: `echo:${message.params.arguments?.text ?? ''}` }] })
      break
    default:
      fail(-32601, `unknown method ${String(message.method)}`)
  }
})
