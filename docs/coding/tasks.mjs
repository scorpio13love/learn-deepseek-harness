/**
 * AI Coding Lab 题库：每个任务都是 DSH 的核心知识点。
 * 测试在本地 Node 里运行，submission.ts 由用户编辑。
 */
import { readFileSync } from 'node:fs'

const answers = JSON.parse(readFileSync(new URL('./answers.json', import.meta.url), 'utf8'))

const baseTasks = [
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

const extraTasks = [
  {
    id: 'turn-window',
    title: '哪些 turn 还开着？',
    lesson: 's01 · agent loop',
    knowledge: 'turn/start 打开轮次，turn/end 收口；失败/取消也必须收口，否则日志会留下永远悬空的 turn。',
    prompt: '实现 openTurns(events)：按 turn/start 和 turn/end 计算仍未关闭的 turn 编号，升序返回。',
    starter: `export interface TurnEvent {
  type: string
  turn?: number
}

export function openTurns(events: TurnEvent[]): number[] {
  // TODO: turn/start 加入，turn/end 移除
  return []
}
`,
    tests: [
      `test('开始后结束，不留下 open turn', () => {
  const out = s.openTurns([{ type: 'turn/start', turn: 1 }, { type: 'turn/end', turn: 1 }])
  assert.deepEqual(out, [])
})`,
      `test('多个 turn 交错时仍按编号返回', () => {
  const out = s.openTurns([
    { type: 'turn/start', turn: 2 },
    { type: 'turn/start', turn: 1 },
    { type: 'turn/end', turn: 2 },
  ])
  assert.deepEqual(out, [1])
})`,
    ],
  },
  {
    id: 'assemble-text',
    title: '把 text delta 拼成 assistant 文本',
    lesson: 's04 · streaming',
    knowledge: '流式 chunk 是增量；同一 block 的 text delta 按到达顺序拼接，不能把每个 chunk 当成完整消息。',
    prompt: '实现 assembleText(chunks)：把 text-delta 的 text 按顺序拼成一个字符串。',
    starter: `export interface TextChunk {
  type: 'text-delta'
  text: string
}

export function assembleText(chunks: TextChunk[]): string {
  // TODO: 按顺序拼接增量
  return ''
}
`,
    tests: [
      `test('按到达顺序拼接', () => {
  assert.equal(s.assembleText([{ type: 'text-delta', text: 'Hello' }, { type: 'text-delta', text: ' world' }]), 'Hello world')
})`,
      `test('空流返回空字符串', () => {
  assert.equal(s.assembleText([]), '')
})`,
    ],
  },
  {
    id: 'missing-args',
    title: '执行前找出缺失参数',
    lesson: 's05 · tool contract',
    knowledge: '参数 schema 的 required 必须在 execute 之前检查；缺失参数要返回给模型，而不是让工具在内部崩溃。',
    prompt: '实现 missingArgs(args, required)：返回 args 中值为 undefined 的必填字段，保持 required 的顺序。',
    starter: `export function missingArgs(
  args: Record<string, unknown>,
  required: string[],
): string[] {
  // TODO: 只检查必填字段是否存在值
  return []
}
`,
    tests: [
      `test('找出缺失字段并保持顺序', () => {
  assert.deepEqual(s.missingArgs({ expression: '(1+2)*3' }, ['expression', 'precision']), ['precision'])
})`,
      `test('null 不是缺失，undefined 才是', () => {
  assert.deepEqual(s.missingArgs({ a: null, b: undefined }, ['a', 'b']), ['b'])
})`,
    ],
  },
  {
    id: 'render-sections',
    title: '按 order 渲染 prompt sections',
    lesson: 's07 · system prompt',
    knowledge: '稳定 section 的前缀顺序决定 KV cache 是否可复用；渲染顺序必须由 order 决定，而不是对象插入顺序。',
    prompt: '实现 renderSections(sections)：按 order 升序，用两个换行连接每段 text。',
    starter: `export interface Section {
  name: string
  order: number
  text: string
}

export function renderSections(sections: Section[]): string {
  // TODO: 按 order 稳定排序后拼接
  return ''
}
`,
    tests: [
      `test('按 order 而不是输入顺序渲染', () => {
  const out = s.renderSections([
    { name: 'dynamic', order: 20, text: 'D' },
    { name: 'identity', order: 10, text: 'I' },
  ])
  assert.equal(out, 'I\\n\\nD')
})`,
      `test('空 section 列表返回空字符串', () => {
  assert.equal(s.renderSections([]), '')
})`,
    ],
  },
  {
    id: 'partition-inbox',
    title: '拆分 next-turn 与 next-step',
    lesson: 's08 · inbox / steering',
    knowledge: 'followup 进 next-turn，steer/inject 进 next-step；两条队列不能混成一条“待处理消息”。',
    prompt: '实现 partitionInbox(items)：返回 { nextTurn, nextStep }，分别放两类消息 id，保持原顺序。',
    starter: `export interface InboxItem {
  id: string
  kind: 'next-turn' | 'next-step'
}

export function partitionInbox(items: InboxItem[]): {
  nextTurn: string[]
  nextStep: string[]
} {
  // TODO: 按 kind 分流
  return { nextTurn: [], nextStep: [] }
}
`,
    tests: [
      `test('两类消息分别进入不同队列', () => {
  const out = s.partitionInbox([
    { id: 'u1', kind: 'next-turn' },
    { id: 's1', kind: 'next-step' },
    { id: 'u2', kind: 'next-turn' },
  ])
  assert.deepEqual(out.nextTurn, ['u1', 'u2'])
  assert.deepEqual(out.nextStep, ['s1'])
})`,
      `test('不修改输入数组', () => {
  const items = [{ id: 'a', kind: 'next-step' }] as const
  s.partitionInbox([...items])
  assert.equal(items.length, 1)
})`,
    ],
  },
  {
    id: 'normalize-failure',
    title: '把 HTTP 失败归一化成稳定类别',
    lesson: 's09 · LLM seam',
    knowledge: 'adapter 只负责把 401/429/超时/5xx 归一化；重试策略属于上层，不能把两者混在一起。',
    prompt: '实现 normalizeFailure(status)：401→auth，429→rate-limit，408/504→timeout，500–599→server，其余→unknown。',
    starter: `export type FailureKind = 'auth' | 'rate-limit' | 'timeout' | 'server' | 'unknown'

export function normalizeFailure(status: number): FailureKind {
  // TODO: 按状态码分类
  return 'unknown'
}
`,
    tests: [
      `test('常见状态码分类', () => {
  assert.equal(s.normalizeFailure(401), 'auth')
  assert.equal(s.normalizeFailure(429), 'rate-limit')
  assert.equal(s.normalizeFailure(408), 'timeout')
  assert.equal(s.normalizeFailure(504), 'timeout')
})`,
      `test('5xx 与未知状态', () => {
  assert.equal(s.normalizeFailure(500), 'server')
  assert.equal(s.normalizeFailure(418), 'unknown')
})`,
    ],
  },
  {
    id: 'parse-jsonl',
    title: '逐行解析 JSONL，保留坏尾标记',
    lesson: 's10 · persistence',
    knowledge: 'JSONL 一行一个事件；崩溃可能留下半行。解析器应保留前面有效事件，并明确标记坏尾。',
    prompt: '实现 parseJsonl(text)：解析每个非空行，遇到第一个坏行停止，返回有效事件和 tornTail 布尔值。',
    starter: `export interface JsonlResult {
  events: unknown[]
  tornTail: boolean
}

export function parseJsonl(text: string): JsonlResult {
  // TODO: 逐行 JSON.parse；遇到坏行停止
  return { events: [], tornTail: false }
}
`,
    tests: [
      `test('有效 JSONL 全部解析', () => {
  const out = s.parseJsonl('{"seq":1}\\n{"seq":2}\\n')
  assert.deepEqual(out.events, [{ seq: 1 }, { seq: 2 }])
  assert.equal(out.tornTail, false)
})`,
      `test('坏尾保留有效前缀', () => {
  const out = s.parseJsonl('{"seq":1}\\n{"seq":')
  assert.deepEqual(out.events, [{ seq: 1 }])
  assert.equal(out.tornTail, true)
})`,
    ],
  },
  {
    id: 'dispose-effects',
    title: '逆序撤销 effect',
    lesson: 's12 · plugin kernel',
    knowledge: 'effect 必须有归属且可撤销；Fiber dispose 时逆序执行，才能先撤依赖再撤提供方。',
    prompt: '实现 disposeEffects(items)：从后往前调用 dispose，返回实际调用顺序的 name。',
    starter: `export interface Effect {
  name: string
  dispose: () => void
}

export function disposeEffects(items: Effect[]): string[] {
  // TODO: 逆序撤销并记录顺序
  return []
}
`,
    tests: [
      `test('严格逆序撤销', () => {
  const seen: string[] = []
  const items = [
    { name: 'a', dispose: () => seen.push('a') },
    { name: 'b', dispose: () => seen.push('b') },
    { name: 'c', dispose: () => seen.push('c') },
  ]
  const order = s.disposeEffects(items)
  assert.deepEqual(order, ['c', 'b', 'a'])
  assert.deepEqual(seen, ['c', 'b', 'a'])
})`,
      `test('空列表安全', () => {
  assert.deepEqual(s.disposeEffects([]), [])
})`,
    ],
  },
  {
    id: 'apply-patch',
    title: '按 id 覆盖：整段替换而非深合并',
    lesson: 's13 · composition / boot',
    knowledge: 'DSH 的配置覆盖是按 id 整段替换，不做深合并；否则删除字段和恢复默认会变得不可预测。',
    prompt: '实现 applyPatch(base, patch)：返回浅层合并结果，patch 中的对象整段覆盖 base 中的同名对象。',
    starter: `export function applyPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  // TODO: 浅合并；不要递归深合并
  return { ...base }
}
`,
    tests: [
      `test('顶层字段覆盖', () => {
  assert.deepEqual(s.applyPatch({ model: 'a', max: 1 }, { model: 'b' }), { model: 'b', max: 1 })
})`,
      `test('嵌套对象整段替换，不深合并', () => {
  assert.deepEqual(
    s.applyPatch({ provider: { base: 'a', model: 'm1' } }, { provider: { base: 'b' } }),
    { provider: { base: 'b' } },
  )
})`,
    ],
  },
  {
    id: 'can-spawn',
    title: '子 agent 预算检查',
    lesson: 's15 · subagents / presets',
    knowledge: 'maxActive/maxDepth 必须在创建 child 之前检查；预算写在工具描述里不能阻止运行时失控。',
    prompt: '实现 canSpawn(active, depth, maxActive, maxDepth)：未达到两个上限才返回 true。',
    starter: `export function canSpawn(
  active: number,
  depth: number,
  maxActive: number,
  maxDepth: number,
): boolean {
  // TODO: active 和 depth 都要检查
  return false
}
`,
    tests: [
      `test('未达到上限允许', () => {
  assert.equal(s.canSpawn(1, 1, 3, 2), true)
})`,
      `test('任一上限达到就拒绝', () => {
  assert.equal(s.canSpawn(3, 0, 3, 2), false)
  assert.equal(s.canSpawn(0, 2, 3, 2), false)
})`,
    ],
  },
  {
    id: 'safe-serialize',
    title: 'PTC 返回值的安全序列化',
    lesson: 's16 · PTC',
    knowledge: 'PTC 的返回值要跨边界序列化；循环引用不能拖垮进程，应变成结构化错误。',
    prompt: '实现 safeSerialize(value)：成功返回 { ok: true, json }，失败返回 { ok: false, error: "circular" }。',
    starter: `export type SerializeResult =
  | { ok: true; json: string }
  | { ok: false; error: string }

export function safeSerialize(value: unknown): SerializeResult {
  // TODO: 捕获 JSON.stringify 的循环引用
  return { ok: true, json: '' }
}
`,
    tests: [
      `test('普通对象成功序列化', () => {
  const out = s.safeSerialize({ a: 1 })
  assert.equal(out.ok, true)
  assert.equal(out.ok && out.json, '{"a":1}')
})`,
      `test('循环引用返回结构化错误', () => {
  const value: Record<string, unknown> = {}
  value.self = value
  const out = s.safeSerialize(value)
  assert.equal(out.ok, false)
  assert.equal(!out.ok && out.error, 'circular')
})`,
    ],
  },
  {
    id: 'mcp-name',
    title: '生成稳定的 MCP 工具名',
    lesson: 's17 · MCP',
    knowledge: 'MCP 工具名由 server 与 tool 组成稳定命名空间；统一 mcp__ 前缀避免与原生工具冲突。',
    prompt: '实现 mcpToolName(server, tool)：返回 mcp__<server>__<tool>。',
    starter: `export function mcpToolName(server: string, tool: string): string {
  // TODO: 统一命名空间
  return ''
}
`,
    tests: [
      `test('生成 mcp 前缀名称', () => {
  assert.equal(s.mcpToolName('github', 'search'), 'mcp__github__search')
})`,
      `test('保留 server 与 tool 原文', () => {
  assert.equal(s.mcpToolName('my-server', 'read_file'), 'mcp__my-server__read_file')
})`,
    ],
  },
  {
    id: 'select-skills',
    title: '按查询筛选 skill catalog',
    lesson: 's18 · skills / commands',
    knowledge: 'catalog 只包含元数据，模型按需加载正文；筛选应同时匹配 name 和 description，且大小写不敏感。',
    prompt: '实现 selectSkills(catalog, query)：返回匹配的 name 数组，保持 catalog 顺序；query 为空时返回全部。',
    starter: `export interface SkillMeta {
  name: string
  description: string
}

export function selectSkills(catalog: SkillMeta[], query: string): string[] {
  // TODO: name/description 大小写不敏感匹配
  return []
}
`,
    tests: [
      `test('匹配 name 和 description', () => {
  const catalog = [
    { name: 'git', description: 'version control' },
    { name: 'pdf', description: 'extract text' },
    { name: 'search', description: 'find git commits' },
  ]
  assert.deepEqual(s.selectSkills(catalog, 'GIT'), ['git', 'search'])
})`,
      `test('空查询返回全部', () => {
  const catalog = [{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }]
  assert.deepEqual(s.selectSkills(catalog, ''), ['a', 'b'])
})`,
    ],
  },
  {
    id: 'stale-ref',
    title: '判断浏览器 ref 是否过期',
    lesson: 's19 · browser use',
    knowledge: '浏览器动作会改变页面；ref 只对生成它的快照有效，旧快照的 ref 不能继续点击。',
    prompt: '实现 isStaleRef(refSnapshot, currentSnapshot)：两者不同就返回 true。',
    starter: `export function isStaleRef(refSnapshot: string, currentSnapshot: string): boolean {
  // TODO: 比较快照 id
  return false
}
`,
    tests: [
      `test('同快照的 ref 仍然有效', () => {
  assert.equal(s.isStaleRef('s1', 's1'), false)
})`,
      `test('动作后的新快照使旧 ref 失效', () => {
  assert.equal(s.isStaleRef('s1', 's2'), true)
})`,
    ],
  },
  {
    id: 'scale-point',
    title: '把截图坐标换算成原生坐标',
    lesson: 's20 · computer use I',
    knowledge: 'Retina 截图像素与原生屏幕坐标存在 scale 映射；坐标换算错误会让点击落到错误位置。',
    prompt: '实现 scalePoint(x, y, scale)：返回 { x: Math.round(x * scale), y: Math.round(y * scale) }。',
    starter: `export interface Point { x: number; y: number }

export function scalePoint(x: number, y: number, scale: number): Point {
  // TODO: 按 scale 换算并四舍五入
  return { x: 0, y: 0 }
}
`,
    tests: [
      `test('2x Retina 换算', () => {
  assert.deepEqual(s.scalePoint(10, 20, 2), { x: 20, y: 40 })
})`,
      `test('结果四舍五入', () => {
  assert.deepEqual(s.scalePoint(1.4, 1.6, 2), { x: 3, y: 3 })
})`,
    ],
  },
  {
    id: 'stale-reason',
    title: 'CUA 动作前的失效检查',
    lesson: 's21 · computer use II',
    knowledge: '快照变化优先报 STALE_SNAPSHOT；窗口变化报 WINDOW_CHANGED；都没有才允许使用旧坐标。',
    prompt: '实现 staleReason(refSnapshot, currentSnapshot, refWindow, currentWindow)：按上述优先级返回错误码或 null。',
    starter: `export type StaleReason = 'STALE_SNAPSHOT' | 'WINDOW_CHANGED' | null

export function staleReason(
  refSnapshot: string,
  currentSnapshot: string,
  refWindow: string,
  currentWindow: string,
): StaleReason {
  // TODO: snapshot 优先，window 其次
  return null
}
`,
    tests: [
      `test('快照变化优先', () => {
  assert.equal(s.staleReason('s1', 's2', 'w1', 'w2'), 'STALE_SNAPSHOT')
})`,
      `test('窗口变化', () => {
  assert.equal(s.staleReason('s1', 's1', 'w1', 'w2'), 'WINDOW_CHANGED')
  assert.equal(s.staleReason('s1', 's1', 'w1', 'w1'), null)
})`,
    ],
  },
  {
    id: 'apply-delta',
    title: '把 SSE 增量接到快照后面',
    lesson: 's22 · web',
    knowledge: '客户端按 lastSeq 接收增量，避免重复卡片；delta 必须按 seq 排序后追加。',
    prompt: '实现 applyDelta(cards, events, lastSeq)：过滤 seq > lastSeq，按 seq 升序追加事件 id。',
    starter: `export interface DeltaEvent { seq: number; id: string }

export function applyDelta(cards: string[], events: DeltaEvent[], lastSeq: number): string[] {
  // TODO: 过滤、排序、追加
  return [...cards]
}
`,
    tests: [
      `test('只追加 lastSeq 之后的增量', () => {
  const out = s.applyDelta(['c1'], [{ seq: 3, id: 'c3' }, { seq: 2, id: 'c2' }], 1)
  assert.deepEqual(out, ['c1', 'c2', 'c3'])
})`,
      `test('没有新事件保持原数组内容', () => {
  assert.deepEqual(s.applyDelta(['c1'], [{ seq: 1, id: 'c1' }], 1), ['c1'])
})`,
    ],
  },
  {
    id: 'parse-jsonrpc',
    title: '解析 SDK 的 JSON-RPC 行',
    lesson: 's23 · SDK / headless',
    knowledge: 'stdio SDK 以 newline framed JSON-RPC 通信；缺 jsonrpc/method 的行必须拒绝，不能交给 handler。',
    prompt: '实现 parseJsonRpcLine(line)：解析 JSON，要求 jsonrpc === "2.0" 且 method 是字符串；否则抛出 Error("invalid")。',
    starter: `export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: unknown
}

export function parseJsonRpcLine(line: string): JsonRpcRequest {
  // TODO: 校验 jsonrpc 和 method
  return JSON.parse(line)
}
`,
    tests: [
      `test('合法请求原样返回', () => {
  const out = s.parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"session/create"}')
  assert.equal(out.method, 'session/create')
})`,
      `test('非法协议抛出 invalid', () => {
  assert.throws(() => s.parseJsonRpcLine('{"jsonrpc":"1.0","method":"x"}'), /invalid/)
  assert.throws(() => s.parseJsonRpcLine('{"jsonrpc":"2.0"}'), /invalid/)
})`,
    ],
  },
  {
    id: 'card-status',
    title: '把事件映射成卡片状态',
    lesson: 's24 · client UI',
    knowledge: '卡片状态由 host projection 决定：审批请求是 waiting，工具错误是 failed，工具结果是 done，其余是 running。',
    prompt: '实现 cardStatus(event)：approval/request→waiting；tool/result 且 isError→failed；tool/result→done；其余→running。',
    starter: `export type CardStatus = 'running' | 'waiting' | 'done' | 'failed'

export interface CardEvent {
  type: string
  isError?: boolean
}

export function cardStatus(event: CardEvent): CardStatus {
  // TODO: 按事件类型和 isError 映射
  return 'running'
}
`,
    tests: [
      `test('审批等待与工具失败', () => {
  assert.equal(s.cardStatus({ type: 'approval/request' }), 'waiting')
  assert.equal(s.cardStatus({ type: 'tool/result', isError: true }), 'failed')
})`,
      `test('成功工具结果与普通事件', () => {
  assert.equal(s.cardStatus({ type: 'tool/result' }), 'done')
  assert.equal(s.cardStatus({ type: 'assistant/message' }), 'running')
})`,
    ],
  },
  {
    id: 'normalize-span',
    title: '去掉 span 的时间噪声',
    lesson: 's25 · observability',
    knowledge: 'snapshot 要比较行为而不是耗时；归一化 span 时只保留 name/status，不把 duration/startedAt 带进 diff。',
    prompt: '实现 normalizeSpan(span)：返回 { name, status }，丢弃时间字段。',
    starter: `export interface Span {
  name: string
  status: string
  durationMs: number
  startedAt: number
}

export function normalizeSpan(span: Span): { name: string; status: string } {
  // TODO: 只保留稳定字段
  return { name: '', status: '' }
}
`,
    tests: [
      `test('只保留 name 和 status', () => {
  assert.deepEqual(s.normalizeSpan({ name: 'tool', status: 'ok', durationMs: 12, startedAt: 1 }), { name: 'tool', status: 'ok' })
})`,
      `test('不同耗时得到相同归一化结果', () => {
  const a = { name: 'tool', status: 'ok', durationMs: 1, startedAt: 1 }
  const b = { name: 'tool', status: 'ok', durationMs: 999, startedAt: 2 }
  assert.deepEqual(s.normalizeSpan(a), s.normalizeSpan(b))
})`,
    ],
  },
  {
    id: 'matrix-summary',
    title: '汇总 eval 故障矩阵',
    lesson: 's26 · eval',
    knowledge: '故障矩阵按 scenario 聚合 pass/fail；报告要能定位哪一格失败，而不是只给一个总数。',
    prompt: '实现 summarizeMatrix(rows)：返回 { [scenario]: { pass, fail } }，没有成功即 fail，保持首次出现顺序。',
    starter: `export interface EvalRow { scenario: string; ok: boolean }

export function summarizeMatrix(rows: EvalRow[]): Record<string, { pass: number; fail: number }> {
  // TODO: 按 scenario 计数
  return {}
}
`,
    tests: [
      `test('按 scenario 聚合', () => {
  const out = s.summarizeMatrix([
    { scenario: '429', ok: true },
    { scenario: '429', ok: false },
    { scenario: 'timeout', ok: false },
  ])
  assert.deepEqual(out, { '429': { pass: 1, fail: 1 }, timeout: { pass: 0, fail: 1 } })
})`,
      `test('空矩阵返回空对象', () => {
  assert.deepEqual(s.summarizeMatrix([]), {})
})`,
    ],
  },
  {
    id: 'audit-run',
    title: '审计一次 run 的未配对工具',
    lesson: 's28 · capstone',
    knowledge: 'capstone 的验收不仅看最终文本，还要看每次 tool/call 是否有 result；缺失结果必须进入报告。',
    prompt: '实现 auditRun(events)：收集 tool/call 的 id，返回没有对应 tool/result 的 id 数组，保持调用顺序。',
    starter: `export interface RunEvent {
  type: string
  id?: string
}

export function auditRun(events: RunEvent[]): string[] {
  // TODO: 配对 tool/call 与 tool/result
  return []
}
`,
    tests: [
      `test('全部有结果时报告为空', () => {
  const out = s.auditRun([
    { type: 'tool/call', id: 'a' },
    { type: 'tool/result', id: 'a' },
  ])
  assert.deepEqual(out, [])
})`,
      `test('报告缺失结果的调用', () => {
  const out = s.auditRun([
    { type: 'tool/call', id: 'a' },
    { type: 'tool/call', id: 'b' },
    { type: 'tool/result', id: 'a' },
  ])
  assert.deepEqual(out, ['b'])
})`,
    ],
  },
]



const sources = {
  'turn-window': ['course/lessons/s01-agent-loop/src/agent.ts', 'turn/step 生命周期'],
  'pair-tool-results': ['course/lessons/s02-tool-round-trip/src/agent.ts', 'tool-call / tool/result 配对'],
  'derive-surface': ['course/lessons/s03-session-log/src/session.ts', 'deriveMessages / surface'],
  'assemble-text': ['course/lessons/s04-streaming/src/stream.ts', 'StreamAssembler'],
  'missing-args': ['course/lessons/s05-tool-contract/src/schema.ts', 'validateParameters'],
  'plan-batches': ['course/lessons/s06-tool-runtime/src/batch.ts', 'planBatches'],
  'render-sections': ['course/lessons/s07-system-prompt/src/prompt.ts', 'renderPrompt / sections'],
  'partition-inbox': ['course/lessons/s08-inbox-steering/src/inbox.ts', 'next-turn / next-step'],
  'normalize-failure': ['course/lessons/s09-llm-seam/src/messages.ts', 'mapHttpError'],
  'parse-jsonl': ['course/lessons/s10-persistence/src/storage.ts', 'JSONL 解析 / torn tail'],
  'should-compact': ['course/lessons/s11-compaction/src/compaction.ts', 'Compaction / overflow'],
  'dispose-effects': ['course/lessons/s12-plugin-kernel/src/kernel.ts', 'Fiber / effect dispose'],
  'apply-patch': ['course/lessons/s13-composition-boot/src/boot.ts', 'applyPatch / 整段替换'],
  'workspace-path': ['course/lessons/s14-capability-seams/src/capabilities.ts', 'Workspace 路径边界'],
  'can-spawn': ['course/lessons/s15-subagents-presets/src/subagent.ts', 'maxDepth / maxActive'],
  'safe-serialize': ['course/lessons/s16-ptc/src/ptc.ts', 'PTC 返回值序列化'],
  'mcp-name': ['course/lessons/s17-mcp-skills-commands/src/mcp.ts', 'MCP 工具命名'],
  'select-skills': ['course/lessons/s18-skills-commands/src/skills/catalog.ts', 'catalog / 按需加载'],
  'stale-ref': ['course/lessons/s19-browser-use/src/registry.ts', 'ref 与快照'],
  'scale-point': ['course/lessons/s20-computer-use-i/src/tool.ts', 'scale / 原生坐标'],
  'stale-reason': ['course/lessons/s21-computer-use-ii/src/coordinates.ts', 'stale snapshot / window'],
  'apply-delta': ['course/lessons/s22-web/src/projection.ts', 'snapshot + SSE delta'],
  'parse-jsonrpc': ['course/lessons/s23-sdk-headless/src/jsonrpc.ts', 'JSON-RPC line'],
  'card-status': ['course/lessons/s24-client-ui/src/projection.ts', 'ActionCard 状态'],
  'normalize-span': ['course/lessons/s25-observability-eval/src/observability.ts', 'span / snapshot'],
  'matrix-summary': ['course/lessons/s26-eval/src/faults.ts', 'faultMatrix / report'],
  'redact-secrets': ['course/lessons/s27-security/src/redact.ts', 'redactText / redactValue'],
  'audit-run': ['course/lessons/s28-capstone/src/eval.ts', 'evaluate / tool pairing'],
}

const allTasks = [...baseTasks, ...extraTasks].sort((a, b) => Number(a.lesson.slice(1, 3)) - Number(b.lesson.slice(1, 3)))
export const tasks = allTasks.map(task => {
  const [path, label] = sources[task.id] ?? ['', '']
  return { ...task, answer: answers[task.id] ?? '', source: path ? { path, label } : undefined }
})
