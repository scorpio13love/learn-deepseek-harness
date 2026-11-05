/**
 * AI Coding Lab 题库：每个任务都是 DSH 的核心知识点。
 * 测试在本地 Node 里运行，submission.ts 由用户编辑。
 */
export const tasks = [
  {
    id: 'pair-tool-results',
    title: '配对 tool-call 与 tool/result',
    lesson: 's02 · tool round-trip',
    knowledge: 'tool-call 和 tool/result 必须按 id 成对；缺失的调用和多余的结果都要显式暴露，否则下一步请求会带着非法历史。',
    prompt: '实现 pairToolResults(calls, results)，返回 paired、unmatchedCalls、unmatchedResults。不要依赖数组顺序，按 id 配对。',
    starter: `export interface ToolCall {
  id: string
  name: string
  args: unknown
}

export interface ToolResult {
  id: string
  isError?: boolean
  content: unknown
}

export interface Pairing {
  paired: Array<{ call: ToolCall; result?: ToolResult }>
  unmatchedCalls: string[]
  unmatchedResults: string[]
}

export function pairToolResults(
  calls: ToolCall[],
  results: ToolResult[],
): Pairing {
  // TODO: 按 id 配对；缺失/多余都别丢
  return { paired: [], unmatchedCalls: [], unmatchedResults: [] }
}
`,
    tests: [
      `test('按 id 配对，不依赖顺序', () => {
  const calls = [{ id: 'a', name: 'read', args: {} }, { id: 'b', name: 'write', args: {} }]
  const results = [{ id: 'b', content: 'ok' }, { id: 'a', content: 'ok' }]
  const r = s.pairToolResults(calls, results)
  assert.equal(r.paired.length, 2)
  assert.equal(r.paired[0].result?.id, 'a')
  assert.equal(r.paired[1].result?.id, 'b')
  assert.deepEqual(r.unmatchedCalls, [])
  assert.deepEqual(r.unmatchedResults, [])
})`,
      `test('缺失结果和多余结果都要暴露', () => {
  const calls = [{ id: 'a', name: 'read', args: {} }, { id: 'b', name: 'write', args: {} }]
  const results = [{ id: 'a', content: 'ok' }, { id: 'x', content: 'orphan' }]
  const r = s.pairToolResults(calls, results)
  assert.equal(r.paired.length, 2)
  assert.equal(r.paired[1].result, undefined)
  assert.deepEqual(r.unmatchedCalls, ['b'])
  assert.deepEqual(r.unmatchedResults, ['x'])
})`,
      `test('重复 result 不应覆盖成两个调用共享同一个结果', () => {
  const calls = [{ id: 'a', name: 'read', args: {} }]
  const results = [{ id: 'a', content: 'first' }, { id: 'a', content: 'second' }]
  const r = s.pairToolResults(calls, results)
  assert.equal(r.paired[0].result?.content, 'first')
  assert.deepEqual(r.unmatchedResults, ['a'])
})`,
    ],
  },
  {
    id: 'derive-surface',
    title: '实现 append + replace 的 surface',
    lesson: 's03 · session log / surface',
    knowledge: 'surface 是当前模型视图，不是可变 messages。append 添加事件；replace 用 sourceEventSeqs 遮蔽旧视图，但不删除原始事件。',
    prompt: '实现 deriveSurface(events)，维护当前视图 id 数组。遇到 replace 时先移除 sourceEventSeqs 中仍存在的 id，再加入当前事件 id。',
    starter: `export interface SurfaceEvent {
  id: string
  surfaceOp?: 'append' | 'replace'
  sourceEventSeqs?: string[]
}

export function deriveSurface(events: SurfaceEvent[]): string[] {
  // TODO: append 加入 id；replace 先移除来源，再加入当前 id
  return []
}
`,
    tests: [
      `test('append 保持顺序', () => {
  assert.deepEqual(s.deriveSurface([{ id: 'u1' }, { id: 'a1' }, { id: 'a2' }]), ['u1', 'a1', 'a2'])
})`,
      `test('replace 遮蔽来源但保留当前节点', () => {
  const events = [
    { id: 'u1' },
    { id: 'a1' },
    { id: 'summary', surfaceOp: 'replace', sourceEventSeqs: ['a1'] },
    { id: 'a2' },
  ]
  assert.deepEqual(s.deriveSurface(events), ['u1', 'summary', 'a2'])
})`,
      `test('replace 可以遮蔽多个来源，且不存在的来源不报错', () => {
  const events = [
    { id: 'u1' }, { id: 'a1' }, { id: 'a2' },
    { id: 'summary', surfaceOp: 'replace', sourceEventSeqs: ['a1', 'a2', 'missing'] },
  ]
  assert.deepEqual(s.deriveSurface(events), ['u1', 'summary'])
})`,
    ],
  },
  {
    id: 'should-compact',
    title: '实现上下文压缩阈值',
    lesson: 's11 · compaction',
    knowledge: '压缩在估算 token 超过 contextWindow × thresholdRatio 时触发；阈值不是常量，应该由调用方传入。',
    prompt: '实现 shouldCompact(tokens, contextWindow, thresholdRatio)。达到阈值返回 true；非法 window/ratio 时返回 false，不要抛出。',
    starter: `export function shouldCompact(
  tokens: number,
  contextWindow: number,
  thresholdRatio: number,
): boolean {
  // TODO: 用比例判断，不要写死 0.8
  return false
}
`,
    tests: [
      `test('达到阈值触发', () => {
  assert.equal(s.shouldCompact(80, 100, 0.8), true)
  assert.equal(s.shouldCompact(95, 100, 0.8), true)
})`,
      `test('低于阈值不触发', () => {
  assert.equal(s.shouldCompact(79, 100, 0.8), false)
})`,
      `test('阈值由调用方决定，不是写死', () => {
  assert.equal(s.shouldCompact(60, 100, 0.5), true)
  assert.equal(s.shouldCompact(40, 100, 0.5), false)
})`,
      `test('非法参数安全返回 false', () => {
  assert.equal(s.shouldCompact(10, 0, 0.8), false)
  assert.equal(s.shouldCompact(10, 100, 0), false)
  assert.equal(s.shouldCompact(Number.NaN, 100, 0.8), false)
})`,
    ],
  },
  {
    id: 'plan-batches',
    title: '规划 parallel / exclusive 批次',
    lesson: 's06 · tool runtime',
    knowledge: '只有显式声明可并发的工具才进 parallel 组；exclusive 调用前必须先形成顺序屏障，否则写文件/Shell 会被盲目并发。',
    prompt: '实现 planBatches(calls)。连续的 parallel 调用合成一组；exclusive 调用各自一组，并在它前后切断 parallel 组。',
    starter: `export interface Call {
  id: string
  concurrency?: 'parallel' | 'exclusive'
}

export function planBatches(calls: Call[]): Call[][] {
  // TODO: 连续 parallel 合组；exclusive 前后都要断组
  return []
}
`,
    tests: [
      `test('连续 parallel 合成一组', () => {
  const calls = [{ id: 'a', concurrency: 'parallel' }, { id: 'b', concurrency: 'parallel' }] as const
  assert.deepEqual(s.planBatches([...calls]).map(g => g.map(c => c.id)), [['a', 'b']])
})`,
      `test('exclusive 自己一组，并切断前后 parallel', () => {
  const calls = [
    { id: 'a', concurrency: 'parallel' },
    { id: 'w', concurrency: 'exclusive' },
    { id: 'b', concurrency: 'parallel' },
    { id: 'c', concurrency: 'parallel' },
  ] as const
  assert.deepEqual(s.planBatches([...calls]).map(g => g.map(c => c.id)), [['a'], ['w'], ['b', 'c']])
})`,
      `test('缺省 concurrency 视为 exclusive', () => {
  assert.deepEqual(s.planBatches([{ id: 'a' }, { id: 'b' }]).map(g => g.map(c => c.id)), [['a'], ['b']])
})`,
    ],
  },
  {
    id: 'workspace-path',
    title: '实现工作区路径边界',
    lesson: 's14 · capability seams / s27 · security',
    knowledge: '字符串 startsWith 挡不住 ../app-evil、前缀目录和符号链接；应使用 resolve + relative，判断结果是否越出工作区。',
    prompt: '实现 isInsideWorkspace(root, candidate)。工作区自身返回 true；越出 root 或前缀相似目录返回 false。可以使用 node:path。',
    starter: `import { isAbsolute, relative, resolve } from 'node:path'

export function isInsideWorkspace(root: string, candidate: string): boolean {
  // TODO: 用 resolve + relative，不要用 startsWith
  return false
}
`,
    tests: [
      `test('工作区内的路径允许', () => {
  assert.equal(s.isInsideWorkspace('/repo', '/repo/src/a.ts'), true)
  assert.equal(s.isInsideWorkspace('/repo', '/repo'), true)
})`,
      `test('../ 越界拒绝', () => {
  assert.equal(s.isInsideWorkspace('/repo', '/repo/../secret'), false)
  assert.equal(s.isInsideWorkspace('/repo', '/repo/src/../../secret'), false)
})`,
      `test('前缀相似目录拒绝', () => {
  assert.equal(s.isInsideWorkspace('/repo', '/repo-evil/a.ts'), false)
})`,
    ],
  },
  {
    id: 'redact-secrets',
    title: '日志脱敏 redaction',
    lesson: 's27 · security',
    knowledge: 'secret 进入日志/上下文就泄露了。redaction 要覆盖 API key、Bearer token、x-api-key 等形式，同时保留可审计结构。',
    prompt: '实现 redactSecrets(text)：把 sk- 开头的 key、Bearer token、x-api-key 的值替换为 [REDACTED]。不要改普通单词。',
    starter: `export function redactSecrets(text: string): string {
  // TODO: 覆盖 sk-...、Bearer ...、x-api-key: ...
  return text
}
`,
    tests: [
      `test('脱敏 sk- key', () => {
  const out = s.redactSecrets('key=sk-abcdefgh12345678 end')
  assert.equal(out.includes('sk-abcdefgh12345678'), false)
  assert.equal(out.includes('[REDACTED]'), true)
})`,
      `test('脱敏 Bearer token', () => {
  const out = s.redactSecrets('Authorization: Bearer abc.def-123456')
  assert.equal(out.includes('abc.def-123456'), false)
  assert.equal(out.includes('Bearer [REDACTED]'), true)
})`,
      `test('脱敏 x-api-key 并保留字段名', () => {
  const out = s.redactSecrets('x-api-key: sk-live-123456789')
  assert.equal(out.includes('sk-live-123456789'), false)
  assert.equal(out.includes('x-api-key'), true)
  assert.equal(out.includes('[REDACTED]'), true)
})`,
    ],
  },
]
