# s03 · streaming：把字节流结算成可回放的 attempt

> 本课代码：`src/`（新增 `stream.ts`；`types.ts` / `session.ts` / `agent.ts` 扩展）
>
> 测试：`tests/s03.test.ts`（12 个离线用例）+ `tests/live.test.ts`（1 个真实模型用例）
>
> 模型：真实 DeepSeek，默认 `deepseek-flash`。

---

## 0. 先跑起来

```sh
cd course/lessons/s03-streaming

cp env.example .env
# 编辑 .env，至少填入 DEEPSEEK_API_KEY

node src/demo.ts
node --test tests/s03.test.ts      # 不需要 key
node --test tests/live.test.ts     # 需要 key；没有则 SKIP

# 可选：类型检查
npm install
npm run typecheck
```

Demo 会打印：

```text
=== 事件日志（S = surface） ===
S #05 assistant/message  stream=20
...
=== 持久 stream 与 live 帧 ===
assistant #5: blocks=1 stream=20 expanded===message=true
  first chunks: block-start → tool-call-delta → tool-call-delta ...
live frames: { start: 2, chunk: 39, end: 2, last: { type: 'end', outcome: 'committed' } }

=== 重放 ===
derived equal: true
stream equal: true
```

具体条数取决于模型输出。

---

## 1. 这一课要回答的问题

1. provider 的 SSE 字节流，为什么不能直接写进 session log？
2. 成功、失败、取消、重试，四种结局分别该写什么事件？
3. 为什么成功消息要嵌入完整 stream，而失败 attempt 不进模型历史？
4. 取消时用户已经看到一半文本，这段文本去哪了？
5. live UI 帧和持久事件是什么关系？谁先谁后？
6. usage 的 `inputTokens` / `cacheReadTokens` 为什么要分开？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`llm-streaming.zh.md`](../../../deepseek-harness/docs/subsystems/llm-streaming.zh.md) | chunk、block、message 三层是什么关系？ | Q1 |
| 2 | [`types.ts` → `StreamChunk`](../../../deepseek-harness/packages/llm/llm/src/types.ts#L496) | 为什么用 index 关联交错 delta？ | Q1 / Q8 |
| 3 | [`assembler.ts` → `BlockAssembler`](../../../deepseek-harness/packages/llm/llm/src/assembler.ts#L38) | block-start / delta / block-end 如何合成内容块？ | Q8 |
| 4 | [`assistant-stream.ts` → `AssistantStreamRecord`](../../../deepseek-harness/packages/llm/llm/src/assistant-stream.ts#L20) | 真实实现为什么把 delta 打包成 run？ | Q2 / Q9 |
| 5 | [`agent-loop/src/assistant-stream.ts` → `AssistantStreamAttempt`](../../../deepseek-harness/packages/core/agent-loop/src/assistant-stream.ts#L14) | attempt 如何同时驱动 live 帧和持久 stream？ | Q5 / Q7 |
| 6 | [`agent.ts` → `step()` 的流式段](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L480) | 成功、失败、取消分别落到哪个事件？ | Q3 / Q4 |
| 7 | [`session/types.ts` → `assistant/message`](../../../deepseek-harness/packages/core/session/src/types.ts#L349) | 为什么消息要带 stream 和 usage？ | Q2 / Q6 |
| 8 | [`session/types.ts` → `assistant/attempt`](../../../deepseek-harness/packages/core/session/src/types.ts#L363) | 失败 attempt 为什么不进派生历史？ | Q3 / Q10 |

读完后，你应该能画出这个矩阵：

| 结局 | 持久事件 | 进模型历史？ |
|---|---|---|
| 正常完成 | `assistant/message` + `stream` + `usage` | 是（内容非空） |
| `max-tokens` | `assistant/message` + `stream` + `usage` | 是（内容非空） |
| 失败/重试 | `assistant/attempt` + `stream` + `failure` | 否 |
| 取消且已有可见前缀 | `assistant/message` + `interrupted: true` + `stream` | 是 |
| 取消且无内容 | `assistant/attempt` + `stream` + failure | 否 |

---

## 3. 核心概念

### 3.1 三层：chunk → block → message

```text
SSE chunk           block                  message
text-delta      →   text block         →   assistant/message
tool-call-delta →   tool-call block
usage           →   usage
finish          →   finish reason
```

- **chunk** 是 provider 的流式协议，delta 可能交错、分片、跨 chunk 切割；
- **block** 是按 index 组装后的完整内容块；
- **message** 是写进日志、进入模型历史的最终消息。

`StreamAssembler` 负责 chunk → block；`assistant/message` 负责 block → message；`stream` 记录保留 chunk 级证据。

### 3.2 成功：message 嵌入完整 stream

```ts
session.append('assistant/message', {
  message,
  stream: attempt.stream,   // [{ time, chunk }, ...]
  usage: attempt.usage,
}, { surfaceOp: 'append' })
```

为什么要嵌入 stream？

- 重放时可以从 chunk 还原 block，验证消息没有被篡改；
- UI 可以按原始节奏重播；
- 审计可以看到模型真实输出，而不是二次组装结果；
- `usage` 和内容一起持久化，避免单独记录丢失。

### 3.3 失败：attempt 保留 stream，但不进历史

```ts
session.append('assistant/attempt', {
  turn, step,
  failure,
  stream: attempt.stream,
})
```

`assistant/attempt` 是**日志事实**：它证明「这次尝试发生过、失败在哪」；但它不是模型可见消息，`deriveMessages()` 会忽略它。

失败流仍有价值：排障、重放、统计、判断是否已经产生可见输出。

### 3.4 取消：保留用户已经看到的内容

取消发生在流中途时：

- 有可见文本/推理 → 写 `assistant/message { interrupted: true }`，保留已交付前缀；
- 没有内容 → 写 `assistant/attempt { code: 'ABORTED' }`；
- 未完成的 tool-call **不进入历史**，因为模型还没有真正发起调用，下一轮不应该看到半截参数。

这条规则是「用户看到什么，模型下次就记得什么」的具体实现。

### 3.5 live 帧 vs 持久事件

- **live 帧**（`agent/assistant-stream`）：进程内的 start / chunk / end，给 UI 实时渲染，不持久化。
- **持久事件**（`assistant/message` / `assistant/attempt`）：先 append，再发 committed end 帧。

顺序很重要：**先持久结算，再通知 live end**。这样 UI 收到 end 时，日志里一定已经有对应事实；如果 append 失败，就发 abandoned end，而不是让 UI 以为成功。

### 3.6 usage 的不相交语义

```ts
{
  inputTokens: 20,        // 未命中缓存的输入
  outputTokens: 10,
  cacheReadTokens: 80,    // 缓存命中
  cacheWriteTokens: 0,
  reasoningTokens: 3,
}
```

`inputTokens` **不含**缓存命中；billed input = input + cacheRead + cacheWrite。这样 token meter、价格、压缩阈值才能正确计算。

---

## 4. 本课实现

### 4.1 文件地图

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/stream.ts`](src/stream.ts) | `StreamAssembler`、`AssistantStreamAttempt`、`expandStream` | `llm/llm/src/{assembler,assistant-stream}.ts`、`agent-loop/src/assistant-stream.ts` |
| [`src/types.ts`](src/types.ts) | `TimedStreamChunk`、`AssistantStreamFrame`、事件 map 扩展 | `dsh-llm` + `dsh-session` |
| [`src/session.ts`](src/session.ts) | 校验 assistant 事件必须带 stream；重放 | `core/session` |
| [`src/agent.ts`](src/agent.ts) | 成功/失败/取消的结算分支 | `core/agent-loop/src/agent.ts` |
| [`src/deepseek.ts`](src/deepseek.ts) | 真实 SSE → chunk | `llm-deepseek` |
| [`src/demo.ts`](src/demo.ts) | 观察 stream/live 帧/重放 | — |

### 4.2 attempt 的生命周期

```ts
const attempt = new AssistantStreamAttempt({ attemptId, turn, step, onFrame })
attempt.start()
for await (const chunk of model.stream(request)) {
  attempt.push(chunk)          // 记录 stream + 喂 assembler + 发 live chunk
}
// 成功
session.append('assistant/message', { message, stream: attempt.stream, usage })
attempt.settle('committed', 'assistant/message')
```

失败/取消时改为 append `assistant/attempt` 或 interrupted message，然后 `settle` 相应的 end 帧。

### 4.3 chunk 组装

```ts
case 'block-start': open.set(index, { type, text: '', id: '', name: '', args: '' })
case 'text-delta': open.get(index).text += chunk.text
case 'tool-call-delta':
  open.id = chunk.id
  open.args += chunk.argumentsDelta
case 'block-end': blocks.set(index, chunk.block)
```

`block-end` 的 block 是权威值；没有 `block-end` 时（例如取消）才从 delta 合成。

### 4.4 为什么要 `expandStream`

```ts
const expanded = expandStream(event.data.stream)
// expanded.blocks === event.data.message.content
```

它把持久 stream 喂回同一个 assembler，用来验证：

- 消息确实由这些 chunk 产生；
- 重放/迁移没有破坏内容；
- 测试可以独立验证组装逻辑。

---

## 5. 验收

离线（`tests/s03.test.ts`）：

| 测试 | 证明 |
|---|---|
| assembler | reasoning/text/tool-call 按 index 组装 |
| delta 合成 | 没有 block-end 也能从 delta 还原；取消前缀丢弃 tool-call |
| expandStream | 持久 stream 能还原 blocks/usage/finish |
| attempt 帧 | start → chunk* → end，stream 冻结且可序列化 |
| 取消前缀 | 只保留 text，不保留未完成 tool-call |
| session stream | assistant/message 必须带 stream，重放后 expand 一致 |
| attempt 历史 | attempt 有 stream 但不进 deriveMessages |
| 重放校验 | 缺 stream 的 assistant 事件被拒绝 |
| transport 失败 | 失败 attempt 带 stream，turn error |
| 取消 | interrupted message + 前缀 + turn aborted |
| live 帧顺序 | end 帧在持久 settlement 之后 |

真实模型（`tests/live.test.ts`）：

- 真实 `deepseek-flash` 工具轮次；
- 每条 assistant/message 的 `expandStream(stream)` 与 message content 一致；
- live 帧有 start/chunk/end，最后 end 为 committed；
- 导出、`restore` 后 stream 与派生历史一致。

---

## 6. 刻意简化了什么

| 真实 DSH | s03 | 影响 |
|---|---|---|
| `AssistantStreamRecord` 打包成 text-chunks / tool-call-chunks run | 扁平 `{time, chunk}` | 语义相同，体积更大；s09 可升级 |
| `replayState` / `ReplayEnvelope` | 无 | s08 补 |
| `agent/assistant-stream` 事件总线 | `onAssistantStream` 回调 | s11 插件化后换成事件 |
| 活动 watchdog / idle timeout | 无 | s08 |
| 重试 | 无 | s08 |
| projected message / 压缩 | 无 | s10 |
| 工具调用取消的合成结果 | 无 | s05 |

---

## 7. 练习

### 练习 1：把 live 帧改成事件

当前用 `AgentOptions.onAssistantStream` 回调。要求：

- 实现一个极简 `EventBus`（`on(type, handler)` / `emit(type, payload)`）；
- 用 `agent/assistant-stream` 事件发布 start/chunk/end；
- demo 里订阅并统计帧；
- 思考：为什么 end 帧必须在 durable append 之后？

### 练习 2：压缩 stream 记录

实现 `compactStream(records)`：

- 把连续 `text-delta` 合并成一个 `text-chunks` run（`time0`、`dt[]`、`texts[]`）；
- 把连续 `tool-call-delta` 合并成 `tool-call-chunks`；
- 保持无损：`expandStream(compact)` 与原始结果一致；
- 对比真实 [`assistant-stream.ts`](../../../deepseek-harness/packages/llm/llm/src/assistant-stream.ts#L20)。

### 练习 3：重试

要求：

- 当 `finish.reason.kind === 'error'` 且 code 是 `RATE_LIMITED` 时，最多重试 2 次；
- 每次重试创建新的 attempt，旧的写 `assistant/attempt`；
- 成功时只保留成功 stream；
- 思考：重试的 attempt 是否应该进历史？为什么？

### 练习 4：usage 汇总

实现 `sessionUsage(session)`：

- 汇总所有 `assistant/message.usage`；
- 分开输出 input / output / cacheRead / cacheWrite / reasoning；
- 验证：`totalTokens` 与各项的关系（不要假设它们是简单相加，视 provider 而定）。

### 练习 5（进阶）：从 stream 重建部分消息

要求：

- 给定一个 `interrupted: true` 的 assistant/message，找到对应的 stream；
- 用 `expandStream` 重建前缀；
- 验证 `partialBlocks` 不含 tool-call；
- 思考：如果取消发生在 tool-call 参数只写了一半时，为什么不能把它写进历史？

---

## 8. 思考题（附源码位置与答案）

### Q1. provider 的 SSE 字节流，为什么不能直接写进 session log？

因为日志需要的是**无损、可重放、与 provider 无关**的事实。SSE 字节里有分帧、心跳、provider 私有字段；直接存会把日志绑死在某个 wire 协议上。

正确做法是：SSE → `StreamChunk` → 持久 `stream` 记录 → `assistant/message` / `assistant/attempt`。这样换 provider 不需要改日志格式。

见 [`StreamChunk`](../../../deepseek-harness/packages/llm/llm/src/types.ts#L496) 与 [`AssistantStreamRecord`](../../../deepseek-harness/packages/llm/llm/src/assistant-stream.ts#L20)。

### Q2. 为什么成功消息要嵌入完整 stream？

因为消息是「组装结果」，stream 是「原始证据」。嵌入后可以：

- 重放时还原；
- 审计模型真实输出；
- UI 按原始节奏重播；
- 验证消息没有被策略/投影篡改。

真实 DSH 把 stream 打包成紧凑 run，但语义仍是「本次 attempt 的完整 chunk 序列」。

见 [`assistant/message`](../../../deepseek-harness/packages/core/session/src/types.ts#L349)。

### Q3. `assistant/attempt` 为什么不进模型历史？

它不是模型消息，而是「这次调用失败/被取消/被重试」的日志事实。模型下一次不应该看到一条失败的空消息；它应该只看到已经成功提交的历史。

但 attempt 仍然保留 stream，供排障、统计、重放。

见 [`assistant/attempt`](../../../deepseek-harness/packages/core/session/src/types.ts#L363) 与 [`deriveEventMessage`](../../../deepseek-harness/packages/core/session/src/surface.ts#L120)。

### Q4. 取消时为什么保留可见前缀，且丢弃未完成 tool-call？

用户已经看到了文本；如果不保留，模型会「忘记自己说过什么」，用户也会觉得上下文断裂。

未完成 tool-call 不能保留，因为参数可能只写了一半，模型并没有真正发起调用；下一轮如果看到半截 `tool-call`，会得到无法配对的工具历史。

见 [`step()` 的取消分支](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L499) 与 `interruptedBlocks()`。

### Q5. live 帧和持久事件是什么关系？谁先谁后？

- live 帧：进程内、瞬态、给 UI；
- 持久事件：写日志、可重放、唯一真源。

顺序必须是：**先 append 持久事件，再发 committed end 帧**。这样 UI 收到 end 时，日志里一定已经有对应事实；append 失败就发 abandoned end。

见 [`AssistantStreamAttempt.settle`](../../../deepseek-harness/packages/core/agent-loop/src/assistant-stream.ts#L69)。

### Q6. usage 的 input / output / cache 为什么不相交？

因为账单和上下文计算需要区分「未命中输入」「缓存命中」「缓存写入」「输出」「推理」。如果 provider 把 cache hit 折进 `prompt_tokens`，adapter 要减出来，保证 `inputTokens` 只算未命中部分。

s03 的 `mapUsage` 和真实 [`translate.ts`](../../../deepseek-harness/packages/llm/llm-deepseek/src/translate.ts#L34) 都按这个语义映射。

### Q7. 为什么 attempt 在持久化之后才发 end 帧？

因为 end 帧携带 `committed` / `abandoned` 结果。只有 append 成功后才能说 committed；如果 append 抛错，必须发 abandoned，不能让 UI 以为成功。

见 [`AssistantStreamAttempt.settle`](../../../deepseek-harness/packages/core/agent-loop/src/assistant-stream.ts#L69) 与 [`step()`](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L480)。

### Q8. 为什么 tool-call 参数要按 index 合并，block-end 是权威？

provider 会交错发送多个工具调用的参数分片；`index` 是唯一可靠的关联键。分片拼接出的 JSON 不一定是权威值，`block-end` 携带的完整 block 才是；没有 block-end 时才从 delta 合成。

见 [`BlockAssembler`](../../../deepseek-harness/packages/llm/llm/src/assembler.ts#L38)。

### Q9. 重放时如何从 stream 还原消息？

把持久 stream 按顺序喂回同一个 `StreamAssembler`，得到 blocks / usage / finish；再用它和 `assistant/message.message` 对比。`expandStream()` 就是这件事。

真实实现有 `expandAssistantStream`，并在持久边界做校验。

### Q10. 为什么失败也要保留 stream？

因为失败流是证据：

- 失败前是否已经产生可见文本？
- 是 provider 错误还是解析错误？
- 重试时是否需要保留前缀？
- 统计首 token 时间、流中断位置。

没有 stream，`assistant/attempt` 只剩下一个错误字符串，无法解释「当时到底发生了什么」。

---

## 9. 下一课：s04 · tools

s03 解决了「模型输出怎么结算」。s04 会转向模型能调用的能力：

- 为什么工具要声明 JSON Schema，而不是直接写函数？
- `defineTool` 如何从 schema 推导参数类型并在运行时校验？
- 为什么工具返回「规范值」而不是文本？
- 条件工具、作用域工具、工具限制分别解决什么问题？
- 工具 schema 如何进入系统提示词？

先读：[`core/tools/src/{contracts,schema}.ts`](../../../deepseek-harness/packages/core/tools/src/contracts.ts) 与 [`docs/cookbook/adding-a-tool.zh.md`](../../../deepseek-harness/docs/cookbook/adding-a-tool.zh.md)。
