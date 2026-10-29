# s05 · tool pipeline：策略、审批、并发与恢复

> 本课代码：`src/`（新增 `pipeline.ts`、`batch.ts`、`recovery.ts`；`tools.ts` / `agent.ts` 接入）
>
> 测试：`tests/s05.test.ts`（11 个离线用例）+ s03/s04 回归 + `tests/live.test.ts`（1 个真实模型用例）
>
> 模型：真实 DeepSeek，默认 `deepseek-flash`。

---

## 0. 先跑起来

```sh
cd course/lessons/s05-tool-pipeline

cp env.example .env
# 编辑 .env，至少填入 DEEPSEEK_API_KEY

node src/demo.ts
node --test tests/s05.test.ts
node --test tests/s04-regression.test.ts
node --test tests/s03-regression.test.ts
node --test tests/live.test.ts     # 需要 key

# 可选：类型检查
npm install
npm run typecheck
```

Demo 会打印流水线阶段：

```text
pre-execute: calc { expression: '(12 + 30) * 2' }
post-execute: calc ok
result: calc ok
...
#07 tool/result        84 meta={"expression":"(12 + 30) * 2","result":"84"}
```

---

## 1. 这一课要回答的问题

1. 工具执行为什么不是「查表 + 调函数」，而是一条可插拔流水线？
2. 为什么守卫只能拒绝，不能把拒绝翻回允许？
3. `ask` 审批为什么在审批服务不可用时直接拒绝？
4. 并发安全工具如何重叠执行，独占工具如何形成屏障？
5. 结果为什么必须按模型顺序提交，而不是完成顺序？
6. 超时、取消、失败步骤分别如何保证工具历史仍然配对？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`tool-execution-pipeline.zh.md`](../../../deepseek-harness/docs/tool-execution-pipeline.zh.md) | 一次调用经过哪些阶段？哪些阶段可以改写调用/结果？ | Q1 |
| 2 | [`contracts.ts` → `PreToolDecision`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L357) | allow/deny/ask/cancel 各自由谁决定？ | Q2 / Q3 / Q4 |
| 3 | [`contracts.ts` → `PostToolDecision`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L367) | accept/block 分别能改什么？ | Q10 |
| 4 | [`contracts.ts` → `ToolGuard`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L391) | 为什么守卫没有 allow？ | Q2 |
| 5 | [`pipeline.ts` → `ToolExecutionPipeline`](../../../deepseek-harness/packages/core/tools/src/pipeline.ts#L62) | 流水线的顺序和失败规范化在哪？ | Q1 / Q10 |
| 6 | [`batch.ts` → `executeToolBatch`](../../../deepseek-harness/packages/core/tools/src/batch.ts#L50) | 独占/并发如何分组？结果如何保持模型序？ | Q5 / Q6 |
| 7 | [`batch.ts` → `runGroup`](../../../deepseek-harness/packages/core/tools/src/batch.ts#L117) | `committed` 为什么只能连续推进？ | Q5 |
| 8 | [`agent.ts` → `ToolCallRecovery`](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L363) | 失败步骤如何补齐缺失结果？ | Q8 / Q9 |

读完后，你应该能画出：

```text
tool/call (recorded)
  → pre-execute waterfall
  → guards (monotonic deny)
  → approval (ask → allowed-once)
  → execute wrapper (timeout/retry/metrics)
  → tool body
  → post-execute (accept/block)
  → tools/result observer
  → tool/result (model order)
```

---

## 3. 核心概念

### 3.1 五个扩展点

| 阶段 | 能做什么 | 不能做什么 |
|---|---|---|
| `pre-execute` | allow / deny / ask / cancel | 改写参数（参数已记录） |
| `guard` | 返回拒绝原因 | 允许、撤销前序拒绝 |
| `execute` wrapper | 超时、重试、指标、替换 signal | 移除 signal |
| 工具体 | 执行实际能力 | 返回非 JSON 值 |
| `post-execute` | accept 替换内容/值、block、附加上下文 | 改调用身份 |
| `result` observer | 只读观察 | 改最终结果 |

真实 DSH 还区分 `projectContent` / `finalizeContent`；s05 保留 post 的 accept/block。

### 3.2 守卫是单调的

`ToolGuard` 只返回：

- `string`：拒绝原因；
- `undefined`：不表态（abstain）。

没有 `allow` 返回值，所以监听器顺序不能把已经发生的拒绝翻回允许。这保证安全策略不会被后续插件「撤销」。

### 3.3 审批 fail closed

`pre-execute` 返回 `ask` 时：

1. 有审批服务：请求 `allowed-once`；
2. 没有审批服务、审批拒绝、审批不可用：**拒绝执行**。

不能因为「没人能批准」就默认允许。这是安全默认值。

### 3.4 并发批次

- `isConcurrencySafe(args) === true` 的调用可以进入滚动池；
- 其他调用是独占屏障，单独执行；
- 池大小由 `maxParallelToolCalls` 控制；
- 工具体可以乱序完成，但结果按输入（模型）顺序返回；
- 取消时停止补充新调用，已启动的调用排空，未开始的调用得到合成的 `ABORTED_BEFORE_DISPATCH` 结果。

### 3.5 恢复

如果步骤在写出 `tool/call` 之后失败，日志里会出现没有 `tool/result` 的调用。下一条请求会得到不配对的工具历史。

s05 在步骤失败时扫描当前 `turn/step`：

- 有 call、无 result → 追加一条保守错误结果；
- 文本说明「已开始但结果未知，重试前先检查外部状态」；
- 已提交结果保持不变；重复调用恢复是幂等的。

---

## 4. 本课实现

### 4.1 文件地图

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/pipeline.ts`](src/pipeline.ts) | pre/guard/approval/around/post/result | `core/tools/src/pipeline.ts` |
| [`src/batch.ts`](src/batch.ts) | 独占屏障、滚动池、模型序结果、取消合成 | `core/tools/src/batch.ts` |
| [`src/recovery.ts`](src/recovery.ts) | 失败步骤补缺失工具结果 | `agent-loop/src/agent.ts` 的 `ToolCallRecovery` |
| [`src/tools.ts`](src/tools.ts) | 注册表委托 pipeline；`executeBatch` | `core/tools/src/index.ts` |
| [`src/agent.ts`](src/agent.ts) | 先记 call、再批量执行、按序提交 result | `core/agent-loop/src/agent.ts` |

### 4.2 pipeline run

```ts
let decision = await runPre(exec)
if (decision.kind === 'ask') decision = await approve(exec, decision)
if (decision.kind !== 'allow') return denied(decision)
for (const guard of guards) if (guard(exec)) return denied(...)
const result = await runExecute(exec, () => invoke(exec))
const post = await runPost(exec, result)
return applyPost(result, post)
```

失败/拒绝/超时都会被规范化成 `ToolResult`，不会让轮次直接崩溃（除非取消）。

### 4.3 批次调度

```ts
while (next < calls.length) {
  if (exclusive(call)) { await runOne(next); next++ }
  else {
    const group = 连续 parallel 调用
    await 滚动池(group, maxParallel)
  }
}
```

结果数组按输入索引写入，最后原样返回；`additionalContexts` 按模型顺序汇总。

### 4.4 Agent 提交顺序

```ts
for (call of calls) append('tool/call', ...)
const batch = await tools.executeBatch(...)
for ([i, call] of calls.entries()) append('tool/result', batch.results[i])
for (context of batch.additionalContexts) append('user/message', context)
```

先记调用、再执行、最后按模型顺序提交结果。即使批次内部乱序完成，日志仍然配对。

---

## 5. 验收

离线（`tests/s05.test.ts`）：

| 测试 | 证明 |
|---|---|
| pre deny | 守卫与工具体都不运行 |
| guard | 单调拒绝，工具体不运行 |
| approval | 缺失/拒绝 fail closed；allowed-once 才执行 |
| post | accept 替换内容；block 变为错误结果 |
| observer | 能观察结果，抛错不破坏结果 |
| timeout | 协作式超时返回 TIMEOUT |
| deferred context | 工具可附带下一请求上下文 |
| parallel batch | 重叠执行、结果模型序 |
| exclusive batch | 独占工具形成屏障 |
| abort | 未开始调用得到合成错误结果 |
| recovery | 缺失 tool/result 补齐且幂等 |

回归：s03 流式 12 个、s04 工具 11 个全部保留。

真实模型（`tests/live.test.ts`）：真实 `deepseek-flash` 调用 calc，经过 pipeline + batch，日志配对、stream、重放。

---

## 6. 刻意简化了什么

| 真实 DSH | s05 | 影响 |
|---|---|---|
| Cordis waterfall 事件 | 普通函数链 | s11 插件化后替换 |
| `tools/execute` 多层 wrapper 顺序 | 数组顺序 | 语义相同 |
| `projectContent` / `finalizeContent` | 无 | 后续补 |
| 工具结果 spill / 输出上限 | 无 | s10 |
| PTC 子调用 | 无 | 选修 |
| 工具展示卡片 | 只有 meta | s16 |
| 审批 UI | 接口 + 测试替身 | s13 |
| 超时后的硬取消 | 协作式 signal | 同真实限制 |

---

## 7. 练习

### 1. 加一个「只读工具」守卫

要求：

- 维护一个 `readOnly` 标志；
- 当标志为 true 时，`write`/`edit`/`bash` 一律拒绝；
- 守卫返回原因，验证监听器顺序不能翻案；
- 与 s04 的 `restrict` 对比：为什么两者都需要？

### 2. 重试包装器

实现 `useExecute` 包装器：

- 工具返回 `isError` 且 code 是 `RATE_LIMITED` 时重试一次；
- 重试不能重复 `pre-execute` / 审批；
- 记录重试次数；
- 思考：为什么重试应该在 execute wrapper，而不是 pre？

### 3. 并发上限实验

要求：

- 三个 20ms 的并发安全工具；
- `maxParallelToolCalls=1/2/3` 分别测总耗时；
- 验证结果顺序始终是 a,b,c；
- 解释「顺序」和「完成时间」为什么是两件事。

### 4. 取消后的日志审计

要求：

- 在批次执行中 abort；
- 打印每个 `tool/call` 是否有对应的 `tool/result`；
- 验证未开始调用是 `ABORTED_BEFORE_DISPATCH`；
- 验证恢复函数不会重复补结果。

### 5. 内容策略

用 `usePost` 实现：

- 工具结果里出现 `secret` 时，替换为 `[redacted]`；
- 保持 `isError` 不变；
- 思考：为什么 post 替换内容不能改变程序化调用拿到的规范值？

---

## 8. 思考题（附源码位置与答案）

### Q1. 为什么工具执行是流水线，而不是直接调用？

因为策略、审批、超时、重试、内容替换、审计都是横切关注点。直接调用会把它们塞进工具实现或 agent loop，导致每个工具重复实现、策略无法统一、插件无法扩展。流水线把这些关注点变成有序阶段。

见 [`ToolExecutionPipeline`](../../../deepseek-harness/packages/core/tools/src/pipeline.ts#L62)。

### Q2. 为什么守卫只能拒绝，不能允许？

如果守卫能返回 allow，后续监听器就可以把前序的 deny 翻回允许，安全策略会依赖监听器顺序。单调守卫只有「拒绝」和「不表态」，拒绝一旦发生就不能被撤销。

见 [`ToolGuard`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L391)。

### Q3. 审批为什么 fail closed？

`ask` 表示「没有人工批准就不能执行」。如果审批服务不存在或不可用却默认允许，就等于绕过了策略。正确行为是拒绝，并让模型看到原因。

见 [`PreToolDecision`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L357) 与 s05 `#approve`。

### Q4. 为什么 pre-execute 可以 deny/ask/cancel，但不能改写参数？

参数已经写进 `tool/call` 并展示给用户；如果 pre 改写参数，日志里的调用和实际执行会不一致，回放/审计失效。需要改写参数应该在工具定义或 schema 层做，而不是执行期。

见 [`ToolExecution`](../../../deepseek-harness/packages/core/tools/src/pipeline.ts#L22)。

### Q5. 为什么结果必须按模型顺序提交？

assistant 的 `tool-call` block 顺序是模型发出的顺序；`tool/result` 必须按同一顺序配对。按完成顺序提交会让日志中的调用/结果错位，provider 可能拒绝请求，回放/UI 也不稳定。

batch 的 `committed` 只跨连续的模型顺序槽位推进；并发完成的乱序结果先缓存，等前面的槽位都齐了再提交。

见 [`executeToolBatch`](../../../deepseek-harness/packages/core/tools/src/batch.ts#L50) 与 [`runGroup`](../../../deepseek-harness/packages/core/tools/src/batch.ts#L117)。

### Q6. 独占工具为什么形成屏障？

独占工具可能修改共享状态（文件、终端、外部系统）。如果它与并发安全工具重叠，执行结果会依赖调度时序。屏障保证独占工具运行期间没有其他调用开始，之后才继续滚动池。

见 [`ToolExecutionMode`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L208)。

### Q7. 超时为什么是协作式的？工具忽略 signal 会怎样？

流水线不能强杀同进程的 Promise/函数；它只能通过 `AbortSignal` 请求工具停止。工具必须观察 signal 并尽快收尾。忽略 signal 的工具会让调用一直挂到自然结束，超时只能限制「等待」，不能限制「实际工作」。

s05 用 `AbortSignal.any([caller, timeout])` 演示；真实 DSH 的超时策略也是协作式的。

### Q8. 取消时为什么要为未开始调用合成结果？

日志里已经有 `tool/call`。如果取消后没有对应的 `tool/result`，下一次请求的工具历史就不配对，回放也会出现悬空调用。

所以取消时为未开始的调用写 `ABORTED_BEFORE_DISPATCH`，已开始的调用排空后按结果提交。

见 [`batch.ts`](../../../deepseek-harness/packages/core/tools/src/batch.ts) 的 abort 分支与 [`agent.ts`](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L363)。

### Q9. 失败步骤为什么要补「结果未知」？

失败可能发生在工具已经开始执行之后。此时不能假装工具没运行（可能有副作用），也不能自动重试（可能重复副作用）。正确的做法是写一条保守错误结果，告诉模型「已开始、结果未知，先检查外部状态」。

见 [`ToolCallRecovery`](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L363) 与 s05 `recovery.ts`。

### Q10. post-execute 的 accept/block 分别改变什么？

- `accept`：可以替换模型内容、替换规范值、附加上下文；结果仍成功。
- `block`：把结果变成错误，反馈内容进入模型；用于策略拒绝或需要模型改正的情况。

替换内容不会改变程序化调用拿到的规范值；要真正拒绝访问，必须 block 或替换值。

见 [`PostToolDecision`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L367)。

---

## 9. 下一课：s06 · system prompt

s05 解决了工具执行。s06 会解决「模型看到的提示词如何组装」：

- sections / order / variables / contexts 如何合并？
- `system-prompt/assemble` waterfall 能做什么？
- 工具 schema 为什么和提示词一起组装？
- 提示词变化时，是改写 head 还是 in-history 追加？
- 为什么这会影响 KV cache？

先读：[`core/system-prompt/src/index.ts`](../../../deepseek-harness/packages/core/system-prompt/src/index.ts) 与 [`docs/subsystems/system-prompt.zh.md`](../../../deepseek-harness/docs/subsystems/system-prompt.zh.md)。
