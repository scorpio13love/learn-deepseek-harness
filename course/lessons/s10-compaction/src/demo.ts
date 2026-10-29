/**
 * s10 demo：构造一段长历史，裁剪大工具结果，再用真实模型摘要旧段落。
 *
 * 运行：
 *   cd course/lessons/s10-compaction
 *   cp env.example .env   # 填入 DEEPSEEK_API_KEY
 *   node src/demo.ts
 */

import {
  Compaction,
  createDeepSeekProvider,
  createMessage,
  createTextMessage,
  LlmRuntime,
  Session,
  textOf,
} from './index.ts'

async function main(): Promise<void> {
  const runtime = new LlmRuntime()
  runtime.register(createDeepSeekProvider())
  const model = runtime.createModel('deepseek', 'deepseek-flash')
  const session = new Session('compaction-demo')

  const bigToolResult = 'line of tool output\n'.repeat(200)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', {
    message: createTextMessage('user', '请分析这份日志，并给出结论。'),
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: '我先读取日志。' }] }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read_log', arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'text', text: bigToolResult }],
    }),
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '日志显示服务在 10:03 开始重试，10:05 恢复。'.repeat(4) }],
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  session.append('user/message', {
    message: createTextMessage('user', '再检查一下最近的错误。'),
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: '最近没有新的错误。' }] }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

  const compaction = new Compaction({
    contextWindow: 400,
    thresholdRatio: 0.5,
    retainRatio: 0.12,
    minMessages: 2,
    maxToolResultChars: 120,
  })

  console.log('estimated tokens:', compaction.estimate(session))
  console.log('threshold:', compaction.threshold, 'retain:', compaction.retainTokens)
  console.log('surface before:', session.surfaceSeqs.length, 'raw events:', session.events.length)

  const result = await compaction.compact(session, model, new AbortController().signal)
  console.log('\n=== compaction ===')
  console.log(result)
  console.log('surface after:', session.surfaceSeqs.length, 'raw events:', session.events.length)
  console.log('contentGeneration:', session.contentGeneration)

  console.log('\n=== derived history after ===')
  for (const message of session.deriveMessages()) {
    console.log(`- ${message.role}: ${textOf(message).slice(0, 160)}`)
  }

  console.log('\n=== raw tail preserved ===')
  console.log('last assistant still in raw events:', session.events.some(event => event.type === 'assistant/message'))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
