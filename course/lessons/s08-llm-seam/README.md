# s08 · LLM seam：provider、prepareCall、能力与重试

> 本课代码：`src/`（新增 `llm.ts`；`deepseek.ts` 增加 Provider/`prepare`；`agent.ts` 接入 prepared call 与重试）
>
> 测试：`tests/s08.test.ts`（8 个离线用例）+ s03-s07 回归（54 个）+ `tests/live.test.ts`（1 个真实模型用例）
>
> 模型：真实 DeepSeek，默认 `deepseek-flash`。

---

## 0. 先跑起来

```sh
cd course/lessons/s08-llm-seam

cp env.example .env
# 编辑 .env，至少填入 DEEPSEEK_API_KEY

node src/demo.ts
node --test tests/s08.test.ts
node --test tests/s07-regression.test.ts tests/s06-regression.test.ts tests/s05-regression.test.ts tests/s04-regression.test.ts tests/s03-regression.test.ts
node --test tests/live.test.ts     # 需要 key
```

Demo 会先打印 `prepareCall` 的结果，再跑真实模型：

```text
prepared config: { provider: 'deepseek', model: 'deepseek-flash' }
capabilities: { contextWindow: 1048576 }
retry policy: { maxRetries: 2, retryableCodes: [ 'NETWORK', 'HTTP_429', ... ] }
```

---

## 1. 这一课要回答的问题

1. 为什么 loop 不直接调用 provider，而是经过 `prepareCall`？
2. `prepareCall` 到底绑定了什么？为什么不能只传 provider/model 字符串？
3. `contextWindow` / `systemPromptUpdate` / `toolUpdate` 如何影响 loop？
4. `in-history` 与「替换 head」对 KV cache 有什么不同？
5. 重试应该发生在哪一层？为什么重试不重跑 pre-step / 用户消息准入？
6. 哪些错误可重试？哪些必须终止？
7. 真实 DSH 的 DeepSeek adapter 为什么用 Messages 而不是 Chat Completions？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`llm/llm/src/call-config.ts`](../../../deepseek-harness/packages/llm/llm/src/call-config.ts) | `prepareCall` 解析/绑定什么？ | Q1 / Q2 |
| 2 | [`llm-deepseek/src/adapter.ts`](../../../deepseek-harness/packages/llm/llm-deepseek/src/adapter.ts#L22) | 适配器如何持有一次调用的配置？ | Q2 / Q9 |
| 3 | [`llm-deepseek/src/model-info.ts`](../../../deepseek-harness/packages/llm/llm-deepseek/src/model-info.ts) | 能力元数据从哪里来？ | Q3 |
| 4 | [`llm/types.ts` → `ResolvedModelInfo`](../../../deepseek-harness/packages/llm/llm/src/types.ts) | `systemPromptUpdate` / `toolUpdate` 的语义？ | Q3 / Q4 / Q5 |
| 5 | [`llm-retry`](../../../deepseek-harness/packages/llm/llm-retry/src/index.ts) | 重试在哪一层？什么错误可重试？ | Q6 / Q7 |
| 6 | [`agent-loop` prepareRequest](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L613) | loop 如何校验路由未被改写？ | Q2 |
| 7 | [`agent-loop` prompt admission](../../../deepseek-harness/packages/core/agent-loop/README.md#understand-the-implementation) | in-history 如何写入 system？ | Q4 |
| 8 | [`deepseek-llm-api-wire-extensions`](../../../deepseek-harness/docs/deepseek-llm-api-wire-extensions.zh.md) | 真实 wire 扩展有哪些？ | Q9 |

读完后，你应该能画出：

```text
Agent
  │ prepareCall({provider, model, signal})
  ▼
LlmRuntime ──▶ Provider ──▶ PreparedCall
                              ├─ config（provider/model/maxTokens）
                              ├─ capabilities（contextWindow / prompt / tool update）
                              ├─ retryPolicy
                              └─ stream(request)
```

---

## 3. 核心概念

### 3.1 为什么需要 prepareCall

`prepareCall` 是「这次调用」的准备步骤：

- 校验 provider/model 路由；
- 物化适配器默认值（reasoning effort、maxTokens）；
- 返回精确路由能力（contextWindow、提示词/工具更新模式）；
- 返回重试策略；
- 绑定一个适配器实例的 `stream`。

loop 在 header 记录、提示词准入、dispatch 全程复用同一个 prepared call，避免中途换成另一个适配器实现。

### 3.2 能力元数据

| 能力 | loop 的用途 |
|---|---|
| `contextWindow` | 压缩阈值、token meter、request/context |
| `systemPromptUpdate: 'in-history'` | 提示词变化时追加而非替换 head |
| `toolUpdate: 'in-history' \| 'addition-only'` | 工具变化时用 developer/message 增量 |
| `defaultMaxTokens` | 请求未指定时的输出上限 |

s08 实现 `contextWindow` 和 `systemPromptUpdate` 的 loop 行为；`toolUpdate` 只保留类型和说明（工具增量留给后续）。

### 3.3 in-history vs 替换 head

- **替换 head**：把第一个 system 节点换成新文本。请求前缀从第一个 token 开始变化，KV cache 全失效。
- **in-history**：把新 system 消息追加在历史之后。provider 读取「最新的 system 消息」作为有效提示词；之前的前缀缓存仍然可用。

s08 的 DeepSeek Chat Completions 适配器**不声明** `in-history`（因为它没有实现该 wire 语义）；测试里的 provider 会声明，用来验证 loop 行为。

### 3.4 重试

重试发生在 **step 内**：

1. 一次 attempt 失败 → 写 `assistant/attempt`；
2. 若错误可重试且还有预算 → 新建 attempt，重新 `prepareCall`/请求；
3. 成功 → 写 `assistant/message`。

重试**不重跑** pre-step、提示词组装、用户消息准入；否则会重复提交用户输入。

### 3.5 可重试错误

可重试性由 `retryPolicy.retryableCodes` 决定，例如：

- 网络错误 `NETWORK`；
- 429 / 5xx；
- provider 的 `SERVER` / `RATE_LIMITED`。

不可重试：鉴权失败、非法请求、内容过滤、取消。取消永远不重试。

---

## 4. 本课实现

### 4.1 文件地图

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/llm.ts`](src/llm.ts) | Provider、LlmRuntime、PreparedCall 类型、重试辅助 | `llm/llm/src/{index,call-config}.ts` |
| [`src/deepseek.ts`](src/deepseek.ts) | `DeepSeekModel.prepare()`、`DeepSeekProvider` | `llm-deepseek/src/adapter.ts` |
| [`src/agent.ts`](src/agent.ts) | prepared call、request/context、in-history、重试 | `agent-loop/src/agent.ts` |
| [`src/demo.ts`](src/demo.ts) | runtime 注册 + prepare 输出 | — |

### 4.2 prepareCall

```ts
const prepared = await this.#model.prepare?.({ signal })
// config: { provider, model, maxTokens }
// capabilities: { contextWindow, systemPromptUpdate? }
// retryPolicy: { maxRetries, retryableCodes }
// stream(request)
```

### 4.3 request/context

```ts
const context = {
  provider,
  model,
  contextWindow: prepared?.capabilities.contextWindow,
  systemPromptUpdate: prepared?.capabilities.systemPromptUpdate,
}
```

只在变化时写；它是路由元数据，不参与请求重建。

### 4.4 重试循环

```ts
for (let attempt = 0; ; attempt++) {
  try { return await runStepOnce(...) }
  catch (error) {
    if (!(error instanceof LlmError) || attempt >= maxRetries
      || !isRetryable(error.failure, policy)) throw error
    await sleep(retryDelayMs(attempt), signal)
  }
}
```

每次失败的 attempt 都保留自己的 stream；成功的那次写 `assistant/message`。

---

## 5. 验收

离线（`tests/s08.test.ts`）：

| 测试 | 证明 |
|---|---|
| runtime | 注册/注销、prepare、未知 provider |
| createModel | 每次 stream 都 prepare |
| retry helpers | 可重试 code、退避上限 |
| flaky attempt | 第一次失败、第二次成功；attempt 保留 |
| capabilities | request/context 记录 contextWindow/systemPromptUpdate；header maxTokens |
| in-history | 提示词变化追加而不是替换 head |
| legacy model | 没有 prepare 的 Model 仍然可用 |
| DeepSeek provider | contextWindow/retryPolicy，且不声明 in-history |

回归：s03-s07 共 54 个用例全部保留。

真实模型：通过 `LlmRuntime` + `DeepSeekProvider` 跑真实 `deepseek-flash`，header/context/stream/重放。

---

## 6. 刻意简化了什么

| 真实 DSH | s08 | 影响 |
|---|---|---|
| Messages 协议 + x-api-key | Chat Completions + Bearer | 教学适配器 |
| model catalog / listing / pricing | 单个 provider | 后续 |
| toolUpdate 增量 | 只用类型描述 | 后续 |
| replayState / ReplayEnvelope | 无 | 后续 |
| 图像/文件/缓存定价 | 无 | 后续 |
| 多层 llm-retry | 单层 step 重试 | 教学够用 |
| 取消/超时 watchdog | 只有 AbortSignal | 后续 |

---

## 7. 练习

### 1. 第二个 provider

实现一个 OpenAI-compatible provider：

- 复用 `DeepSeekModel` 的 SSE 解析；
- 改 base URL、model id、能力元数据；
- 在 runtime 里注册两个 provider；
- 写测试：同一 Agent 换 provider，不改 loop。

### 2. 工具增量

实现 `toolUpdate: 'addition-only'`：

- 工具集合变化时写 `developer/message`；
- 只记录新增工具，不重写完整声明；
- 验证请求 header 的 tools 与 developer 消息一致。

### 3. 重试指标

在 retry 包装器里记录：

- attempt 次数；
- 每次的错误 code / 延迟；
- 最终是否成功；
- 输出到 `onAssistantStream` 之外的 observer。

### 4. 非重试错误

构造一个 401：

- 确认不会重试；
- `turn/end` 是 error；
- attempt 保留完整 stream。

### 5. 能力协商实验

用 TestProvider 分别声明：

- 无 `systemPromptUpdate`；
- `systemPromptUpdate: 'in-history'`；
- 运行两轮并改变提示词；
- 对比 system 事件数量与 surface 顺序，解释 KV cache 差异。

---

## 8. 思考题（附源码位置与答案）

### Q1. 为什么 loop 不直接调用 provider？

因为 provider 的 wire 协议、认证、流格式、错误分类、能力元数据都不同。loop 只应依赖 provider-neutral 的 `PreparedCall`；适配器负责把请求翻译成具体协议。这样换 provider 不需要改 loop。

见 [`LlmRuntime`](src/llm.ts) 与真实 [`call-config.ts`](../../../deepseek-harness/packages/llm/llm/src/call-config.ts)。

### Q2. prepareCall 到底绑定了什么？为什么不能只传字符串？

它绑定一个适配器实例、物化后的配置、能力元数据和 retryPolicy。只传 provider/model 字符串，loop 无法保证 header 记录、提示词准入、dispatch 用的是同一个适配器实例；中途换实现会让日志与实际请求不一致。

见真实 [`prepareRequest`](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L613)。

### Q3. 能力元数据如何影响 loop？

- `contextWindow`：request/context、压缩、token meter；
- `systemPromptUpdate`：决定 system 消息是替换 head 还是追加；
- `toolUpdate`：决定工具变化能否用增量；
- `defaultMaxTokens`：请求未指定时的输出上限。

能力不是猜测，必须由适配器声明。

### Q4. in-history 与替换 head 的 KV cache 差异？

替换 head 会让请求从第一个 token 开始不同，前缀缓存全失效；in-history 把新提示词追加在历史之后，之前的前缀仍然可复用。代价是模型必须支持读取历史中任意位置的 system 消息。

见真实 [`ResolvedModelInfo`](../../../deepseek-harness/packages/llm/llm/src/types.ts) 与 `#admitPrompt`。

### Q5. toolUpdate 的 addition-only / in-history 是什么？

- `addition-only`：模型能读 developer 消息里的 `tool-addition`，把新工具加入可用集合；
- `in-history`：还能读 `tool-removal`，从历史中移除工具。

没有声明时，每次请求都必须重写完整工具声明，前缀缓存会失效。

### Q6. 重试应该在哪一层？为什么重试不重跑 pre-step？

重试在 step 内、attempt 层。pre-step 已经决定了哪些输入进入本轮；重跑它会重复提交用户消息、重复执行条件工具求值，甚至改变本轮语义。

见 s03 的 attempt 与 s08 的 `#runStep`。

### Q7. 哪些错误可重试？

由 `retryPolicy.retryableCodes` 决定，通常是网络、429、5xx、provider 的临时错误。鉴权、非法请求、内容过滤、取消不可重试。

见 [`isRetryable`](src/llm.ts) 与真实 [`llm-retry`](../../../deepseek-harness/packages/llm/llm-retry/src/index.ts)。

### Q8. 为什么适配器默认值要物化/清除？

物化：请求必须带精确的 maxTokens/reasoning effort，header 才能重建。
清除：下一次请求要重新解析当前路由的默认值，而不是把上一次的默认值当成用户选择。

s08 的 `prepare` 返回 config；真实 loop 还有 `requestProposal` 清除 adapterDefaults。

### Q9. 为什么真实 DSH 的 DeepSeek adapter 用 Messages 而不是 Chat Completions？

真实适配器需要 `thinking`、`tool_use`、`cache_read_input_tokens`、文件/图片、mid-conversation tool changes 等 Messages 语义；Chat Completions 表达不了这些。s08 的 Chat Completions 适配器是为了教学简单，能力元数据也相应保守。

见 [`llm-deepseek/src/adapter.ts`](../../../deepseek-harness/packages/llm/llm-deepseek/src/adapter.ts#L22) 与 [`translate.ts`](../../../deepseek-harness/packages/llm/llm-deepseek/src/translate.ts)。

### Q10. 换 provider 为什么不用改 loop？

因为 loop 只依赖 `PreparedCall` 的 config/capabilities/retryPolicy/stream。新 provider 只要实现 `Provider` 并返回同样的结构，就能被 runtime 注册、被 Agent 使用。

见 [`Provider`](src/llm.ts) 与 [`LlmRuntime`](src/llm.ts)。

---

## 9. 下一课：s09 · persistence

s08 让模型调用可替换、可重试。s09 会让会话活过进程重启：

- JSONL 日志如何 append/flush？
- 重启时如何恢复到最后一次 flush？
- 未闭合的 turn 如何修复？
- 未回答的 tool call 如何恢复？
- fork 如何复制前缀并标记继承边界？

先读：[`session-persistence`](../../../deepseek-harness/packages/session/session-persistence/src/index.ts) 与 [`session-persistence-jsonl`](../../../deepseek-harness/packages/session/session-persistence-jsonl/src/index.ts)。
