# s02 · session log：append-only、surface 与重放

> 本课代码：`src/`（`types.ts`、`session.ts`、`deepseek.ts`、`env.ts`、`tools.ts`、`agent.ts`、`demo.ts`）
>
> 测试：`tests/s02.test.ts`（12 个离线用例）+ `tests/live.test.ts`（1 个真实模型用例）
>
> 模型：真实 DeepSeek，默认 `deepseek-flash`。

---

## 0. 先跑起来

```sh
cd course/lessons/s02-session-log

cp env.example .env
# 编辑 .env，至少填入 DEEPSEEK_API_KEY

node src/demo.ts
node --test tests/s02.test.ts      # 不需要 key
node --test tests/live.test.ts     # 需要 key；没有则 SKIP

# 可选：类型检查
npm install
npm run typecheck
```

Demo 会做四件事：

1. 用真实模型跑一轮「调用 calc 工具」；
2. 打印事件日志，`S` 标记当前进入 surface 的节点；
3. 打印 `request/header`、`request/context` 和派生消息；
4. 导出 JSON、`Session.restore()` 重放，再用 `surfaceOp: replace` 把历史压缩成一条摘要，证明原始事件仍在。

输出大致是：

```text
=== 事件日志（S = 进入 surface） ===
  #00 turn/start
  #01 step/start
S #02 user/message       "append"
  #03 request/header
  #04 request/context
S #05 assistant/message  "append"
  #06 tool/call
S #07 tool/result        "append"
  #08 step/end
  #09 step/start
S #10 assistant/message  "append"
  #11 step/end
  #12 turn/end

=== 导出 / 重放 ===
raw events: 13, surface: 4, derived: 4
restored===live: true

=== surface replace（压缩） ===
after: raw events 14, surface 1, derived 1
原始 assistant 仍在 events 里: true
contentGeneration: 1
```

具体条数取决于模型调用了几次工具。

---

## 1. 这一课要回答的问题

1. 为什么 DSH 不存 `messages: Message[]`，而要存一堆事件？
2. 哪些事件进入模型历史？`tool/call` 为什么不在里面？
3. `surfaceOp: replace` 和「删除旧事件」有什么区别？
4. 压缩之后，原始 assistant 消息去哪了？为什么还能审计？
5. `request/header` 为什么只是「最近一份快照」，而不是每个 step 都写？
6. 从磁盘恢复一个 session 时，凭什么相信重建出来的历史就是对的？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`docs/subsystems/session.zh.md`](../../../deepseek-harness/docs/subsystems/session.zh.md) | 事件信封、surface、派生历史三者的关系是什么？ | Q1 |
| 2 | [`types.ts` → `SessionEventMap`](../../../deepseek-harness/packages/core/session/src/types.ts#L287) | 哪些事件是 surface，哪些只是日志事实？ | Q2 |
| 3 | [`types.ts` → `SessionEvent`](../../../deepseek-harness/packages/core/session/src/types.ts#L501) | `seq`、`time`、`ignorable` 各自解决什么问题？ | Q1 / Q11 |
| 4 | [`surface.ts` → `deriveEventMessage`](../../../deepseek-harness/packages/core/session/src/surface.ts#L120) | 为什么空 system/developer/assistant 返回 null？ | Q3 |
| 5 | [`surface.ts` → `foldSurface` / `SurfaceManager`](../../../deepseek-harness/packages/core/session/src/surface.ts#L594) | append/replace 如何折叠成有序 surface？ | Q4 / Q5 |
| 6 | [`index.ts` → `append()`](../../../deepseek-harness/packages/core/session/src/index.ts#L806) | 一条事件在什么时候才算「进入日志」？ | Q10 |
| 7 | [`index.ts` → `deriveMessages()`](../../../deepseek-harness/packages/core/session/src/index.ts#L999) | 派生历史读的是原始事件还是 surface？ | Q2 / Q3 |
| 8 | [`index.ts` → `requestHeader()`](../../../deepseek-harness/packages/core/session/src/index.ts#L927) | 为什么 header 只需要「最近一份」？ | Q6 / Q7 |
| 9 | [`session-persistence`](../../../deepseek-harness/packages/session/session-persistence/src/index.ts) | 重放如何保证 seq 连续、surface 引用有效？ | Q8 |
| 10 | [`index.ts` → `append()` 的 JSDoc](../../../deepseek-harness/packages/core/session/src/index.ts#L796) | 为什么事件数据必须是无损 JSON？ | Q9 |

读完后，你应该能画出：

```text
raw events:  turn/start, step/start, user, request/header, assistant, tool/call, tool/result, ...
                  │
                  │ 只看 5 种 surface 事件的 surfaceOp
                  ▼
surface nodes: [02 user, 05 assistant, 07 tool/result, 10 assistant]
                  │
                  │ deriveEventMessage
                  ▼
messages:      [user, assistant(tool-call), tool(result), assistant]
```

---

## 3. 核心概念

### 3.1 事件信封

```ts
interface SessionEvent<K> {
  type: K
  seq: number          // 单调、连续
  time: number         // Unix epoch ms
  data: SessionEventMap[K]
  ignorable?: true     // 未知类型是否可安全跳过
  // surface 事件还带：
  surfaceOp: 'append' | { op: 'replace'; startSeq; endSeq }
  sourceEventSeqs?: number[]
}
```

- `seq` 是事件的稳定位置，也是 `sourceEventSeqs` 引用的坐标；
- `time` 用于审计、UI、回放；
- `ignorable` 默认**不可忽略**：读到不认识的必需事件，必须拒绝重建，而不是静默丢历史；
- surface 元数据只允许出现在 5 种消息事件上。

### 3.2 surface 是派生历史的唯一入口

不是所有事件都进入模型历史。只有：

```text
system/message
developer/message
user/message
assistant/message
tool/result
```

`tool/call` **不是** surface 事件：工具调用作为 `tool-call` block 存在 assistant message 里；`tool/result` 才是工具结果消息。`turn/*`、`step/*`、`assistant/attempt`、`request/header`、`request/context` 都是日志事实，不是模型消息。

```ts
deriveMessages(): Message[] {
  for (const seq of this.#surface) {
    const message = this.#deriveEventMessage(this.#events[seq])
    if (message) messages.push(message)
  }
}
```

### 3.3 append 与 replace

```ts
// 正常追加
session.append('user/message', { message }, { surfaceOp: 'append' })

// 压缩：用一条摘要替换一段连续 surface 节点
session.append('user/message', { message: summary }, {
  surfaceOp: { op: 'replace', startSeq: 2, endSeq: 7 },
  sourceEventSeqs: [2, 5, 7],
})
```

replace 的规则：

1. `startSeq` / `endSeq` 必须都是当前 surface 节点；
2. 区间必须连续；
3. `sourceEventSeqs` 必须覆盖区间内**每一个**被遮蔽的节点；
4. 原始事件不删除，只是从 surface 中移除；
5. 新节点插到被替换区间的起始位置。

### 3.4 派生规则

| 事件 | 派生结果 |
|---|---|
| `user/message` | 原样 |
| `tool/result` | 原样 |
| `system/message` | 内容为空 → `null`，否则原样 |
| `developer/message` | 内容为空 → `null`，否则原样 |
| `assistant/message` | 内容为空 → `null`，否则原样 |
| 其他 | `null` |

空节点留在 surface 上，是为了让 replace 仍然能定位它们、表达「没有系统提示词」和承载 `max-tokens` 步骤的 usage；它们只是不产生 wire message。

### 3.5 request/header 与 request/context

- `request/header` 是**完整请求信封**：`config`（provider/model/maxTokens）+ `tools`。只在 `initial` / `change` / `series` 时追加；未变化的步骤和重试继承最近一份。
- `request/context` 是**路由元数据**：`contextWindow`、`systemPromptUpdate` 等。它不参与请求重建，只在变化时记录。
- 两者都是 log-only，不进模型历史。

### 3.6 重放

`Session.restore(id, events)` 做三件事：

1. 校验 `seq` 从 0 连续；
2. 校验事件类型、时间、`ignorable`、surface 元数据；
3. 按顺序重新折叠 surface：append 追加，replace 校验区间和 source 后替换。

它不信任外部传入的 surface，而是从原始事件重新算出来。这样即使进程崩溃、文件被截断，也能判断出「哪些历史是完整的」。

---

## 4. 本课实现

### 4.1 文件地图

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/types.ts`](src/types.ts) | 事件信封、surface 类型、JSON 校验 | `dsh-session` 的类型 |
| [`src/session.ts`](src/session.ts) | append、surface fold、derive、restore | `core/session/src/{index,surface}.ts` |
| [`src/agent.ts`](src/agent.ts) | 写入 surface intent、header/context | `core/agent-loop/src/agent.ts` |
| [`src/deepseek.ts`](src/deepseek.ts) | 真实 DeepSeek 适配器 | `llm/llm-deepseek` |
| [`src/demo.ts`](src/demo.ts) | 日志 / 重放 / 压缩演示 | — |

### 4.2 append 的提交顺序

```ts
append(type, data, intent) {
  // 1. 校验类型、surface intent、sourceEventSeqs
  // 2. 校验 data 是无损 JSON
  // 3. 构造候选 event（尚未写入）
  // 4. 计算下一个 surface；replace 在这里校验区间与 shadowed 覆盖
  // 5. 全部通过后，才 push events / 更新 surface / nextSeq++
}
```

失败时日志完全不变。这对应真实 `Session.append()` 的「在 append 点失败，而不是等到 flush 时才发现」。

### 4.3 replace 的核心算法

```ts
const startIndex = surface.indexOf(startSeq)
const endIndex = surface.indexOf(endSeq)
const shadowed = surface.slice(startIndex, endIndex + 1)
for (const seq of shadowed) {
  if (!sources.has(seq)) throw new Error(`must cite shadowed node #${seq}`)
}
surface = [...surface.slice(0, startIndex), event.seq, ...surface.slice(endIndex + 1)]
```

真实实现在 [`surface.ts`](../../../deepseek-harness/packages/core/session/src/surface.ts#L594) 的 `foldSurface` / `SurfaceManager`，还会处理 message projections 和 `replaceGeneration`。

### 4.4 重放

```ts
static restore(id, events) {
  const session = new Session(id)
  for (const raw of events) {
    assertJsonValue(raw)
    const event = deepFreeze(structuredClone(raw))
    session.#validateRestoredEvent(event)   // seq 连续、surface 元数据合法
    session.#surface = session.#applySurface(session.#surface, event)
    session.#events.push(event)
  }
  return session
}
```

---

## 5. 验收

离线（`tests/s02.test.ts`）：

| 测试 | 证明 |
|---|---|
| append | 只有 surface 节点进入历史；header/context 不进 |
| intent 校验 | surface 必须带 surfaceOp；log-only 不能带 |
| replace | 旧节点从历史消失，原始事件保留 |
| replace 校验 | 越界、非连续、漏 cite、重复 cite 都拒绝 |
| 派生规则 | 空 system/developer/assistant 留在 surface 但不产生消息 |
| header/context | 只保留最新快照 |
| JSON 校验 | undefined/Date/循环/NaN 在 append 点拒绝 |
| 冻结 | 事件、data、message 都不可变 |
| ignorable | 追加与重放都保留 |
| replay | surface/history/header/generation 一致 |
| 坏重放 | seq gap、未知类型、缺失 surfaceOp、坏 source 都拒绝 |
| toJSON | 可无损 JSON 序列化 |

真实模型（`tests/live.test.ts`）：

- 调用 `calc` 完成一轮；
- 记录且只记录一份 `request/header` / `request/context`；
- 导出、`restore` 后派生历史一致；
- 对整段历史做一次 replace，派生出 1 条摘要，原始 assistant 仍在 events 里。

运行：

```sh
node --test tests/s02.test.ts
node --test tests/live.test.ts
```

---

## 6. 刻意简化了什么

| 真实 DSH | s02 | 影响 |
|---|---|---|
| JSONL 持久化、generation、迁移 | 内存 + JSON 导出 | s09 补 |
| `assistant/message` 嵌入完整 stream | 只存最终消息 | s03 补 |
| `assistant/attempt` 嵌入失败流 | 只存 failure | s03 补 |
| message projections | 无 | s16 的 projection |
| `replaceGeneration` / `contentGeneration` 细分 | 只有一个 `contentGeneration`，replace 时 +1 | s10 对齐 |
| `request/header` 的 `adapterDefaults` / `series` | 只有 config + tools；reason initial/change | s08 补 |
| 工具增删的 `developer/message` 投影 | 只记录，不参与 agent 生成 | s06/s08 补 |
| fork / `session/end-seed` | 只保留事件类型 | s09 补 |

---

## 7. 练习

### 练习 1：写一个 `compact()` 辅助函数

要求：

- 输入 `session`、`startSeq`、`endSeq`、摘要文本；
- 自动收集区间内的 surface seq 作为 `sourceEventSeqs`；
- 调用 `append('user/message', ..., { surfaceOp: { op: 'replace', ... } })`；
- 对越界、非连续区间抛错；
- 写测试：replace 前 3 条，surface 减少 2 条，raw events +1。

### 练习 2：检测未闭合的 turn

要求：

- 在 `Session.restore()` 后扫描事件，若最后一个 `turn/start` 没有对应的 `turn/end`，打印警告；
- 或者追加一条 `turn/end { reason: { kind: 'interrupted' } }`（需要先扩展 `TurnEndReason`）；
- 思考：为什么真实 DSH 把「语义修复」放在 agent 层，而不是存储层？

提示：s09 会正式实现 `interruptedTurnClosers`。

### 练习 3：source 血缘查询

要求：

- 写 `lineage(session, seq)`：返回某个事件直接/间接引用的所有 `sourceEventSeqs`；
- 对一次 replace，打印被摘要遮蔽的旧节点；
- 验证：即使旧节点已不在 surface，仍能从 raw events 找到。

### 练习 4：JSONL 导入导出

要求：

- `toJSONL(session)`：每个事件一行 `JSON.stringify(event)`；
- `fromJSONL(id, text)`：逐行解析并 `Session.restore()`；
- 测试：包含 replace 的日志往返后 surface/derive/header 完全一致；
- 思考：如果最后一行被截断，应该如何报告/修复？

### 练习 5（进阶）：消息投影

要求：

- 注册一个纯函数 `project(message) => message`，在 derive 时应用；
- 模拟「把 tool result 里的密钥脱敏」；
- 保证 projection 不改变 surface 节点数量，只改变派生消息。

提示：真实 DSH 的 `SessionMessageProjection` 就是做这个的。

---

## 8. 思考题（附源码位置与答案）

### Q1. 事件信封为什么需要 `seq`、`time`、`ignorable`？

- `seq`：稳定、连续的位置，用来引用（`sourceEventSeqs`）、去重、判断缺口；
- `time`：审计、UI 排序、回放时的真实时间；
- `ignorable`：前向兼容。默认**不可忽略**——读到不认识的必需事件必须拒绝重建，否则可能静默丢掉改变语义的历史；只有纯信息性记录才由写入方标 `true`。

见 [`SessionEvent`](../../../deepseek-harness/packages/core/session/src/types.ts#L501) 与 [`append()`](../../../deepseek-harness/packages/core/session/src/index.ts#L806)。

### Q2. 为什么只有 5 种 surface 事件进入模型历史？

因为只有这 5 种事件产生 LLM 消息：`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`。边界、attempt、header/context 是「日志事实」，不是模型输入。

特别注意 `tool/call`：它不是 surface 事件，因为工具调用已经作为 `tool-call` block 存在于 assistant message 里；如果再派生一次会重复。`tool/result` 才是独立的工具结果消息。

见 [`SurfaceEventType`](../../../deepseek-harness/packages/core/session/src/types.ts#L447) 与 [`deriveMessages()`](../../../deepseek-harness/packages/core/session/src/index.ts#L999)。

### Q3. 空 system/developer/assistant 为什么留在 surface 但不产生消息？

它们保留 surface 位置，用于：

- 表达「没有系统提示词」（空 head）；
- 让后续 replace 仍能定位节点；
- 承载 `max-tokens` 步骤的 usage（空 assistant 事件）。

但空内容对 provider 没有意义，所以 `deriveEventMessage()` 返回 `null`，不生成 wire message。

见 [`deriveEventMessage()`](../../../deepseek-harness/packages/core/session/src/surface.ts#L120)。

### Q4. `surfaceOp: replace` 与「删除事件」有什么区别？

replace **不删除原始事件**，只把被遮蔽的节点从 surface 中移除，让派生历史看不到它们。原始事件仍在日志里，可用于审计、回放、fork、遥测和压缩来源追踪。

删除事件会破坏 append-only、`seq` 连续性和所有 `sourceEventSeqs` 引用，也无法解释「历史为什么变了」。

见 [`foldSurface`](../../../deepseek-harness/packages/core/session/src/surface.ts#L594) 与 [`SurfaceOp`](../../../deepseek-harness/packages/core/session/src/types.ts#L470)。

### Q5. replace 为什么要求 `sourceEventSeqs` 覆盖所有被遮蔽节点？

因为它是一份**来源证明**：新节点必须声明「我替代了哪些旧节点」。如果漏掉一个，那个节点就会从历史里消失却没有留下任何引用，审计和压缩都无法解释它去哪了。

s02 在 `#applySurface` 里逐个检查 shadowed 节点是否被 cite；真实 `SurfaceManager` 做同样的完整性检查。

### Q6. `request/header` 为什么只记录变化？它为什么不进历史？

header 是请求信封，不是模型消息。同一个 provider/model/tools 的连续步骤和重试共享同一份 header，重复写只会让日志膨胀。

只在 `initial` / `change` / `series` 时追加；回放时取「最近一份 header」即可重建请求。注意它记录的是 `config + tools`，不是 messages。

见 [`request/header`](../../../deepseek-harness/packages/core/session/src/types.ts#L398) 与 [`requestHeader()`](../../../deepseek-harness/packages/core/session/src/index.ts#L927)。

### Q7. `request/context` 与 `request/header` 的分工？

- `request/header`：参与请求重建的 call config + tools；
- `request/context`：路由能力元数据（`contextWindow`、`systemPromptUpdate`），只用于下游策略，不参与 header 相等比较，也不参与请求重建。

两者都只在变化时写。

见 [`request/context`](../../../deepseek-harness/packages/core/session/src/types.ts#L410)。

### Q8. replay 如何重建 surface？为什么必须校验 seq 连续？

按 `seq` 顺序扫描原始事件：surface 事件按 `surfaceOp` 折叠，replace 校验区间和来源；最后得到的 surface 就是派生历史的输入。

`seq` 必须连续：否则无法判断是否有事件缺失；`sourceEventSeqs` 的坐标也会失效。缺一条就可能把一段历史「静默缝合」错。

见 [`Session.restore()`](src/session.ts) 与真实 [`session-persistence`](../../../deepseek-harness/packages/session/session-persistence/src/index.ts)。

### Q9. 为什么事件数据必须是无损 JSON？

日志最终要写进 JSONL，并在另一端原样读回。函数、undefined、BigInt、Date、Map、循环引用都无法无损往返；如果等到 flush 才发现，内存状态和磁盘状态就会分叉。

所以 `append` 在入口就做一次无损校验，失败不改变日志。真实实现用 `snapshotJsonValue` 做单次读取/校验/拷贝，避免 getter 在验证和存储之间返回不同值。

见 [`append()` 的 JSDoc](../../../deepseek-harness/packages/core/session/src/index.ts#L796)。

### Q10. 为什么 append 要先校验再提交？

因为日志是唯一真源。任何「半条事件」都会破坏 `seq` 连续性、surface 折叠和恢复。

s02 的顺序是：校验类型/intent → 校验 JSON → 构造候选 → 计算下一个 surface（replace 校验）→ 全部通过才 push / 更新 surface / `nextSeq++`。失败时日志完全不变。

### Q11. `ignorable` 默认为什么是「不可忽略」？

因为未知事件可能改变后续历史的解释方式。默认拒绝重建是保守但安全的：宁可让用户升级/修复，也不要把「被掏空的历史」当成完整历史继续跑。写入方只有确认某条记录纯属信息性、丢失不影响重建时，才标 `true`。

见 [`SessionEvent`](../../../deepseek-harness/packages/core/session/src/types.ts#L501) 的 `ignorable` 注释。

### Q12. `contentGeneration` 为什么在 replace 时推进？

派生历史、token 估算、UI 缓存都可能缓存「上一版 surface」的结果。replace 改变了已有模型可见内容，必须让这些缓存知道要重建。s02 用一个单调计数器演示；真实 `Session` 区分 `replaceGeneration` 和 `contentGeneration`，s10 会用到。

见 [`SurfaceManager.contentGeneration`](../../../deepseek-harness/packages/core/session/src/surface.ts#L612)。

---

## 9. 下一课：s03 · streaming

s02 把「消息」写进日志，但 assistant 消息目前只保存最终结果。s03 会回答：

- 流式 chunk 如何组装成 block？
- 成功、失败、取消、重试分别如何结算？
- 为什么 `assistant/message` 要嵌入完整 stream，`assistant/attempt` 又不进历史？
- 取消时已交付的文本前缀如何保留？
- usage 的 input/output/cache 字段为什么要「不相交」？

先读：[`llm/llm/src/assembler.ts`](../../../deepseek-harness/packages/llm/llm/src/assembler.ts) 与 [`docs/subsystems/llm-streaming.zh.md`](../../../deepseek-harness/docs/subsystems/llm-streaming.zh.md)。
