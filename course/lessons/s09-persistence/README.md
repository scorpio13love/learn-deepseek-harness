# s09 · persistence：JSONL、恢复、崩溃修复与 fork

> 本课代码：`src/`（新增 `storage.ts`；`session.ts` 增加 `onAppend`）
>
> 测试：`tests/s09.test.ts`（10 个离线用例）+ s03-s08 回归（72 个）+ `tests/live.test.ts`（1 个真实模型用例）
>
> 模型：真实 DeepSeek，默认 `deepseek-flash`。

---

## 0. 先跑起来

```sh
cd course/lessons/s09-persistence

cp env.example .env
# 编辑 .env，至少填入 DEEPSEEK_API_KEY

node src/demo.ts
node --test tests/s09.test.ts
node --test tests/s08-regression.test.ts tests/s07-regression.test.ts tests/s06-regression.test.ts tests/s05-regression.test.ts tests/s04-regression.test.ts tests/s03-regression.test.ts
node --test tests/live.test.ts     # 需要 key
```

Demo 会：

1. 创建临时存储目录和一个 session；
2. 跑一轮真实模型；
3. `flush` 后关闭，再 `open` 重放；
4. 手动追加一个半行 JSON，模拟崩溃尾部；
5. `open` 修复截断；
6. `fork` 出子会话并打印继承标记。

---

## 1. 这一课要回答的问题

1. 为什么持久化的是 append-only 事件日志，而不是最终消息？
2. `flush` 为什么必须是显式屏障？
3. 崩溃留下半行 JSON，为什么可以安全丢弃？
4. 未闭合的 turn 为什么要补 `interrupted`？
5. 为什么语义修复属于 agent 层，而不是存储层？
6. fork 为什么复制前缀 + `session/end-seed`？
7. 未回答的 tool call 如何恢复？
8. 为什么一个 session 同一时间只能有一个写者？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`session-persistence`](../../../deepseek-harness/packages/session/session-persistence/src/index.ts) | `create/open/append/flush/close` 的持久性保证是什么？ | Q1 / Q2 / Q9 |
| 2 | [`session-persistence-jsonl`](../../../deepseek-harness/packages/session/session-persistence-jsonl/src/index.ts) | generation、压缩、校验、torn tail 如何处理？ | Q2 / Q3 / Q7 |
| 3 | [`core/session/src/repair.ts`](../../../deepseek-harness/packages/core/session/src/repair.ts) | 崩溃修复的边界在哪？ | Q4 / Q5 |
| 4 | [`core/session/src/fork.ts`](../../../deepseek-harness/packages/core/session/src/fork.ts) | fork 如何复制前缀、关闭打开 turn、标记 seed？ | Q6 |
| 5 | [`session-checkpoint-policy`](../../../deepseek-harness/packages/session/session-checkpoint-policy/src/index.ts) | 哪些时点必须 flush？ | Q2 / Q8 |
| 6 | [`agent-loop` ToolCallRecovery](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L363) | 未回答工具调用如何补结果？ | Q8 |
| 7 | [`architecture.zh.md` 会话日志](../../../deepseek-harness/docs/architecture.zh.md#会话日志) | 模型可见历史如何从日志重建？ | Q1 |
| 8 | [`persistence-changes/README`](../../../deepseek-harness/docs/persistence-changes/README.md) | 格式变更为什么要保留历史 generation？ | Q7 |

读完后，你应该能画出：

```text
create(header) ──▶ session.jsonl
attach(session) ──▶ buffer.append(event)
flush() ─────────▶ write + fsync        ← 持久性屏障
open(id) ─────────▶ parse header/events → drop torn tail → repair open turn → Session.restore
fork(id, cut) ────▶ copy prefix → close open turn (forked) → session/end-seed
```

---

## 3. 核心概念

### 3.1 日志是持久层，消息是派生

存储只负责 `SessionEvent`；`deriveMessages()` 在打开时重建模型历史。这样：

- 重放、审计、fork、压缩都能基于同一份日志；
- 不需要同时维护「消息表」和「事件表」；
- 迁移只改事件解码，不改消息生成。

### 3.2 flush 是显式屏障

s09 的写入顺序：

```text
append(event) → 内存 buffer
flush()       → write(buffer) + fsync
```

`flush` 之前崩溃，buffer 丢失；`flush` 之后崩溃，事件已落盘。真实 DSH 的 `session/flush` 也是持久性屏障，checkpoint policy 决定在请求前/工具前 flush。

### 3.3 截断尾部

JSONL 的每一行是独立事件。如果最后一行只写了一半：

- 它不是一个完整事件；
- 它前面的行仍然完整；
- 丢弃最后一行不会破坏前缀。

s09 在 `open` 时逐行解析，遇到 JSON 错误或 seq 不连续就停止，并把有效前缀重写成新文件。

### 3.4 未闭合 turn

如果最后一个 `turn/start` 没有对应的 `turn/end`，说明进程崩在轮次中间。s09 追加：

```ts
turn/end { turn, reason: { kind: 'interrupted' } }
```

这样会话可以继续；原始事件保持不变，只是补了一个结束标记。

### 3.5 fork

fork 复制源日志的前缀，然后：

1. 如果前缀末尾有未闭合 turn，补 `turn/end { kind: 'forked' }`；
2. 追加 `session/end-seed { inherited: true }`；
3. 子 header 标记 `parentSession` / `isSeeded`。

这告诉读者「哪些事件是继承的、从哪里开始属于子会话」。

### 3.6 未回答的 tool call

工具调用可能有副作用。恢复时不能假装没发生，也不能自动重试。s05 的 `recoverMissingToolResults` 会补一条：

```text
Error: tool "x" was started but its outcome is unknown; check external state before retrying.
```

这样下一次请求的工具历史仍然配对，模型也知道要谨慎。

---

## 4. 本课实现

### 4.1 文件地图

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/storage.ts`](src/storage.ts) | create/open/attach/flush/close/list/fork | `session-persistence` + JSONL backend |
| [`src/session.ts`](src/session.ts) | `onAppend` 观察者 | `session/event` 路由 |
| [`src/demo.ts`](src/demo.ts) | 写入/重开/截断/fork | — |

### 4.2 文件布局

```text
<root>/<sessionId>/session.jsonl
  {"type":"session/header","version":1,"id":"...","createdAt":...}
  {"type":"turn/start","seq":0,...}
  {"type":"user/message","seq":1,...,"surfaceOp":"append"}
  ...
```

### 4.3 create / attach / flush

```ts
const handle = await store.create(id, { cwd })
handle.attach()                 // session.onAppend → buffer
... agent.run(...) ...
await handle.flush()            // write + fsync
await handle.close()
```

### 4.4 open 的修复

```ts
for (line of lines) {
  try { event = JSON.parse(line) } catch { truncated = true; break }
  if (event.seq !== events.length) { truncated = true; break }
  events.push(event)
}
const session = Session.restore(id, events)
if (openTurn(session)) session.append('turn/end', { reason: 'interrupted' })
if (truncated || repaired) rewrite(validPrefix)
```

### 4.5 fork

```ts
const prefix = source.events.filter(seq <= cut)
if (last turn open) prefix.push(turn/end { forked })
prefix.push(session/end-seed { inherited: true })
writeChild(header { parentSession, isSeeded: true }, prefix)
```

---

## 5. 验收

离线（`tests/s09.test.ts`）：

| 测试 | 证明 |
|---|---|
| roundtrip | create/attach/flush/open 后历史一致 |
| unflushed | 未 flush 的事件在崩溃语义下丢失 |
| torn tail | 半行 JSON 被丢弃并重写 |
| unclosed turn | 补 `interrupted` 且只补一次 |
| seq gap | 不连续事件被截断 |
| fork | 复制前缀、补 `forked`、加 seed 标记 |
| fork boundary | 显式 cut 生效；越界拒绝 |
| list | 只返回可读 header |
| bad header | 版本不符拒绝 |
| onAppend | 监听器可注销 |

回归：s03-s08 共 72 个用例全部保留。

真实模型：真实 `deepseek-flash` 写入 → flush → open → fork。

---

## 6. 刻意简化了什么

| 真实 DSH | s09 | 影响 |
|---|---|---|
| zstd 压缩、校验和、generation | 明文 JSONL、单文件 | 可读性优先 |
| 格式迁移 v0→v4 | 单版本 | s02 之外不展开 |
| 单写者锁、并发 resume 排斥 | 无锁 | 教学单进程 |
| checkpoint policy | 手动 flush | 真实自动在请求/工具前 |
| 不可变 generation 发布 | 直接重写 `.tmp` + rename | 语义简化 |
| fork 的 SQLite/字节级优化 | 复制事件对象 | 够用 |
| 未回答 tool call 的完整恢复 | s05 已有函数 | 本课不重复 |

---

## 7. 练习

### 1. 给 header 加 cwd 校验

要求：

- cwd 必须是绝对路径；
- 不存在时保存但不阻塞；
- `open` 时如果 cwd 不存在，回退到进程 cwd 并记录警告。

### 2. 实现 checkpoint

在以下时点自动 flush：

- 模型请求前；
- 工具执行前；
- turn 结束前。

写测试：模拟崩溃后能恢复到最近 checkpoint。

### 3. 单写者锁

用 `<sessionDir>/lock` 文件实现：

- `create/open` 获取独占锁；
- 第二个写者拒绝；
- `close` 释放。

### 4. 压缩日志

实现 `compactFile(id)`：

- 读取事件；
- 丢弃已被 surface replace 遮蔽的旧节点？注意不能丢，审计需要；
- 改为按 generation 写新文件，保留旧文件。

思考：为什么真实 DSH 不删除旧 generation？

### 5. fork 的 tool 历史

fork 一个在 tool 执行中崩溃的会话：

- 补 `forked` closer；
- 为未回答 tool call 补 `TOOL_OUTCOME_UNKNOWN`；
- 验证子会话下一次请求工具历史配对。

---

## 8. 思考题（附源码位置与答案）

### Q1. 为什么持久化的是 append-only 事件日志，而不是最终消息？

事件日志是唯一真源：消息、surface、压缩、fork、审计都能从它派生。只存最终消息会丢失「为什么变成这样」；也无法支持 replace、fork 前缀、崩溃修复。

见 [`session-persistence`](../../../deepseek-harness/packages/session/session-persistence/src/index.ts) 与 s02。

### Q2. 为什么 flush 必须是显式屏障？

因为写入缓冲不等于落盘。只有 `flush`（write + fsync）之后，崩溃才不会丢事件。显式屏障让调用方决定「什么时候必须持久」，例如模型请求前、工具执行前。

见 [`session-checkpoint-policy`](../../../deepseek-harness/packages/session/session-checkpoint-policy/src/index.ts)。

### Q3. 崩溃留下半行 JSON，为什么可以安全丢弃？

JSONL 一行是一个完整事件；半行不是事件，前面的行仍然完整。丢弃尾部不会影响前缀的 seq 连续性。重写有效前缀后，文件恢复一致。

### Q4. 未闭合的 turn 为什么要补 `interrupted`？

会话需要一个明确的轮次结束标记，否则恢复后无法判断「上一轮是否还在进行」。补 `interrupted` 保留原始事件，同时给读者一个明确的结束原因。

见 [`repair.ts`](../../../deepseek-harness/packages/core/session/src/repair.ts)。

### Q5. 为什么语义修复属于 agent 层，而不是存储层？

存储只负责字节和格式：它能判断「尾部是否完整」，但不知道一个未闭合 turn 应该补 `interrupted` 还是 `forked`，也不知道工具调用是否需要 `TOOL_OUTCOME_UNKNOWN`。语义修复依赖 agent 的领域知识。

### Q6. fork 为什么复制前缀 + `session/end-seed`？

前缀让子会话拥有父会话的上下文；`end-seed` 标记「继承到哪里为止」，后面的工作是子会话自己的。没有标记就无法区分继承历史和子会话事件。

见 [`fork.ts`](../../../deepseek-harness/packages/core/session/src/fork.ts)。

### Q7. 为什么 generation 不可变/不覆盖？

已发布的 generation 可能被审计、回放、其他进程读取。覆盖会破坏这些读者；正确做法是发布新的 version-named 文件，保留旧文件。

见 [`persistence-changes`](../../../deepseek-harness/docs/persistence-changes/README.md) 与 s02 的 `SESSION_FORMAT_VERSION`。

### Q8. 未回答的 tool call 如何恢复？

补一条保守错误结果：说明工具已开始、结果未知、重试前先检查外部状态。这样下一次请求的工具历史仍然配对，模型不会误以为工具没运行。

见 s05 的 `recoverMissingToolResults` 与真实 [`ToolCallRecovery`](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L363)。

### Q9. 为什么一个 session 同一时间只能有一个写者？

append-only 日志依赖单一 seq 序列；两个写者会交错写入、破坏连续性。真实 DSH 在 persistence handle 层强制单写者，并排斥并发 resume。

### Q10. JSONL 还是 SQLite？

JSONL 简单、可读、每行独立，适合单会话日志；SQLite 适合跨会话查询/索引。DSH 用 JSONL 做会话主日志，另有 session-query/SQLite 做检索。选择取决于访问模式，不是「哪个更先进」。

---

## 9. 下一课：s10 · compaction

s09 让会话活过重启。s10 会解决「历史太长，上下文装不下」：

- 何时压缩？阈值怎么算？
- 先裁剪工具结果还是先摘要？
- 摘要如何替换 surface 而不删除日志？
- 溢出错误如何重试？
- 为什么压缩本身也是一次模型请求？

先读：[`compaction-basic`](../../../deepseek-harness/packages/compaction/compaction-basic/src/index.ts) 与 [`token-meter`](../../../deepseek-harness/packages/llm/token-meter/src/index.ts)。
