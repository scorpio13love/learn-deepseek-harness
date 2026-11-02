/**
 * s01 的 demo：一次真实的 DeepSeek 文本 turn。
 *
 * 这个演示只做最小 loop，不调用任何工具：
 *   1. 用户输入进入日志；
 *   2. loop 从日志派生请求，向 DeepSeek 发起一次流式调用；
 *   3. chunk 被组装成 assistant message，再追加回日志；
 *   4. turn/end 收口，打印完整事件序列。
 *
 * 运行：
 *   cd course/lessons-v3/s01-agent-loop
 *   cp env.example .env    # 填入 DEEPSEEK_API_KEY
 *   node src/demo.ts
 *
 * 观察三件事：
 *   1. 事件顺序：turn/start → step/start → user/message → request/header
 *      → assistant/message → step/end → turn/end；
 *   2. 请求历史来自 `session.deriveMessages()`，不是隐藏的 messages 数组；
 *   3. 即使模型报错或用户取消，turn/end 也一定存在。
 */

import { Agent, createDeepSeekModel, Session, textOf, ToolRegistry } from './index.ts'
import type { Message } from './types.ts'

function roleSummary(message: Message): string {
  return `${message.role}: ${textOf(message)}`
}

async function main(): Promise<void> {
  const model = createDeepSeekModel()
  const session = new Session()
  // 本课不演示工具往返；空注册表让模型只做一次纯文本回答。
  const tools = new ToolRegistry()
  const agent = new Agent(session, model, tools, { maxSteps: 1 })

  console.log(`model: ${model.provider}/${model.model} (${model.baseUrl})`)
  console.log('prompt: 请用三句话解释：一个 agent loop 为什么需要 turn 和 step 两个层级？\n')

  const result = await agent.run(
    '请用三句话解释：一个 agent loop 为什么需要 turn 和 step 两个层级？不要调用任何工具。',
  )

  console.log('=== 事件日志 ===')
  for (const event of session.events) {
    const detail = event.type === 'assistant/message'
      ? `blocks=${event.data.message.content.length}${event.data.interrupted === true ? ' interrupted' : ''}`
      : event.type === 'request/header'
        ? `${event.data.provider}/${event.data.model} tools=[${event.data.tools.join(', ')}]`
        : event.type === 'turn/end'
          ? JSON.stringify(event.data.reason)
          : ''
    console.log(`#${String(event.seq).padStart(2, '0')} ${event.type.padEnd(18)} ${detail}`)
  }

  console.log('\n=== 从日志派生的消息 ===')
  for (const message of session.deriveMessages()) {
    console.log(`- ${roleSummary(message)}`)
  }

  console.log('\n=== 结果 ===')
  console.log('reason:', result.reason)
  console.log('steps :', result.steps)
  console.log('answer:', session.lastAssistantText())

  const usage = session.events
    .filter(event => event.type === 'assistant/message' && event.data.usage !== undefined)
    .map(event => event.type === 'assistant/message' ? event.data.usage : undefined)
  if (usage.length > 0) console.log('usage :', usage)

  if (result.reason.kind === 'error') {
    console.error('\n模型调用失败：', result.reason.failure)
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
