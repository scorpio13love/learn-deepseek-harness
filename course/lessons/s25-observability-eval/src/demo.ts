/**
 * s18 · observability / eval：沿用前序课程的实现（本课改动见 README）。
 */

import {
  Agent,
  assertSnapshot,
  createDeepSeekProvider,
  LlmRuntime,
  RecordingModel,
  ReplayModel,
  Session,
  snapshotSession,
  ToolRegistry,
} from './index.ts'

async function main(): Promise<void> {
  const runtime = new LlmRuntime()
  runtime.register(createDeepSeekProvider())
  const real = runtime.createModel('deepseek', 'deepseek-flash')
  const recording = new RecordingModel(real)

  const first = new Session('record')
  await new Agent(first, recording, new ToolRegistry()).run('用一句话说明可观测性的价值。')
  console.log('recorded calls:', recording.records.length)

  const replay = new ReplayModel(recording.records, { provider: 'deepseek', model: 'deepseek-flash' })
  const second = new Session('replay')
  await new Agent(second, replay, new ToolRegistry()).run('用一句话说明可观测性的价值。')

  assertSnapshot(snapshotSession(first), snapshotSession(second))
  console.log('replay identical: true')
  console.log('answer:', first.lastAssistantText())
  console.log('events:', first.events.map(event => event.type))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
