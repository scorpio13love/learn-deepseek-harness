# s18 · observability / eval：让 agent 可诊断、可回归

> 本课代码：`src/observability.ts`（span、record/replay、snapshot、fault）
>
> 测试：`tests/s18.test.ts`（4 个离线用例）+ s17 回归
>
> 模型：真实 DeepSeek，默认 `deepseek-flash`。

---

## 0. 先跑起来

```sh
cd course/lessons/s18-observability-eval
cp env.example .env
node src/demo.ts
node --test tests/s18.test.ts
```

Demo 用真实模型录制一次调用，再用 replay 离线重放，并比较 session snapshot。

---

## 1. 这一课要回答的问题

1. 改 prompt/loop 后，怎么知道没有退化？
2. 为什么要录制事件/chunk，而不是只存最终文本？
3. 快照应该包含哪些事实？
4. 哪些不确定性必须被注入而不是 mock？
5. 故障注入应该覆盖哪些路径？
6. 可观测性如何不阻塞主流程？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`telemetry/otel`](../../../deepseek-harness/packages/telemetry/otel/src/index.ts) | span 如何挂到 agent/tool 生命周期？ | Q6 |
| 2 | [`session-telemetry`](../../../deepseek-harness/packages/session/session-telemetry/src/index.ts) | 会话级指标如何汇总？ | Q2 |
| 3 | [`testing.zh.md`](../../../deepseek-harness/docs/testing.zh.md) | 快照/回放/e2e 的分工？ | Q1 / Q3 |
| 4 | [`snapshots/AGENTS.md`](../../../deepseek-harness/snapshots/AGENTS.md) | 快照为什么按 session 录制？ | Q3 |
| 5 | [`llm-retry`](../../../deepseek-harness/packages/llm/llm-retry/src/index.ts) | 故障注入覆盖哪些错误？ | Q4 / Q5 |
| 6 | [`benchmarks`](../../../deepseek-harness/benchmarks) | 性能回归如何度量？ | Q1 |

---

## 3. 核心概念

### 3.1 三个层次

- **telemetry**：运行时的 span/指标，回答「慢在哪、失败在哪」；
- **record/replay**：把真实模型调用录下来，离线重放，回答「改动前后行为是否一致」；
- **snapshot**：对事件序列、派生消息、usage 做结构化断言，回答「有没有回归」。

### 3.2 为什么录事件/chunk

只存最终文本会丢失：

- 工具调用、失败 attempt、取消前缀；
- 流式时序、usage/cache；
- surface replace 前后的历史。

回放应该重建完整 session，而不是只比对答案字符串。

### 3.3 故障注入

必须注入真实失败路径：

- 429/5xx/网络超时；
- 流中途断流；
- 工具抛错/超时/取消；
- 上下文溢出。

不要只 mock 成功路径；错误恢复才是 agent 的难点。

### 3.4 可观测性不阻塞

span/指标写入不能阻塞主流程；观察者失败不能改变已提交结果（s05 的 result observer 同理）。

---

## 4. 本课实现

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/observability.ts`](src/observability.ts) | Telemetry、RecordingModel、ReplayModel、snapshot、FaultModel | `telemetry/*`、`snapshots/*`、`llm-retry` |
| [`src/demo.ts`](src/demo.ts) | 真实录制 + 离线重放 | — |

```ts
const recording = new RecordingModel(realModel)
await agent.run(prompt)
const replay = new ReplayModel(recording.records)
await new Agent(new Session(), replay, tools).run(prompt)
assertSnapshot(snapshotSession(first), snapshotSession(second))
```

---

## 5. 验收

| 测试 | 证明 |
|---|---|
| telemetry | span 嵌套、事件、结束时间 |
| record/replay | 同一 prompt 的 snapshot 一致 |
| fault | 终止失败 → attempt + turn error |
| snapshot | 不一致时响亮失败 |

---

## 6. 刻意简化了什么

| 真实 DSH | s18 | 影响 |
|---|---|---|
| OTel exporter/collector | 内存 span | 教学 |
| keyless recorded-session 快照 | 单测级 snapshot | 后续 |
| 真实 API e2e | demo 一次 | 成本 |
| benchmark 基线 | 无 | 后续 |
| 故障矩阵 | 单 FaultModel | 可扩展 |

---

## 7. 练习

1. **span 接入 Agent**：在 turn/step/tool 边界自动 start/end。
2. **回放校验**：回放时比对 request 是否与录制时一致。
3. **故障矩阵**：429、超时、断流、工具抛错、overflow 各一个用例。
4. **快照 diff**：输出可读 diff，而不是 JSON 字符串。
5. **性能基线**：测首 token、工具并发、长会话打开时间。

---

## 8. 思考题（附源码位置与答案）

### Q1. 改 prompt/loop 后怎么知道没有退化？

三层：单测覆盖纯逻辑；record/replay 覆盖模型交互；snapshot 覆盖事件/消息/usage。性能用 benchmark 基线。

### Q2. 为什么录事件/chunk 而不是只存最终文本？

最终文本丢失工具调用、attempt、取消前缀、usage、surface replace。回放要重建完整 session，才能验证行为而不只是答案。

### Q3. 快照应该包含哪些事实？

事件类型序列、派生消息（role/text/工具调用）、usage、turn/step 状态、surface 结构，以及失败/取消标记。

### Q4. 哪些不确定性必须注入？

网络/限流、流中断、工具超时/取消、上下文溢出、模型空响应。mock 成功路径无法覆盖这些。

### Q5. 故障注入覆盖哪些路径？

模型请求失败/重试、工具失败/审批拒绝、取消、overflow、存储 flush 失败。每条都要有可恢复/可解释的结果。

### Q6. 可观测性如何不阻塞主流程？

span/指标写入异步、失败被包含；观察者异常不能改变已提交结果。真实 DSH 的 result observer 也是这个原则。

---

## 9. 结课：从 s01 到 s18

你现在拥有一个可运行的 mini harness：

```text
session log + surface
  → agent loop / stream / tool pipeline
  → prompt / inbox / provider seam
  → persistence / compaction
  → plugin kernel / boot
  → capabilities / subagents / MCP
  → web / SDK
  → telemetry / replay / eval
```

下一步建议：

1. 用 mini harness 跑一个真实任务（读写文件、跑测试、修复 bug）；
2. 对照 `dsh --profile headless` 的事件日志；
3. 选一个真实 DSH 子系统，按本课格式继续深挖。
