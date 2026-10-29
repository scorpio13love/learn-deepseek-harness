# s17 · SDK / headless：把 harness 变成进程外服务

> 本课代码：`src/jsonrpc.ts`、`src/sdk.ts`、`src/sdk-server.ts`、`src/sdk-client.ts`
>
> 测试：`tests/s17.test.ts`（3 个离线用例）+ s16 回归
>
> 模型：真实 DeepSeek，默认 `deepseek-flash`。

---

## 0. 先跑起来

```sh
cd course/lessons/s17-sdk-headless
cp env.example .env
node src/demo.ts
node --test tests/s17.test.ts
```

Demo spawn 一个 `sdk-server`，通过 newline JSON-RPC 创建 session、发 prompt、接收 `session/event` 通知。

---

## 1. 这一课要回答的问题

1. JSON-RPC 帧如何编码？
2. `session/create` / `prompt` / `session/event` 如何设计？
3. stdout 为什么只能放协议帧？
4. 取消/关闭如何传播？
5. SDK 与 ACP 的差异？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`sdk/protocol`](../../../deepseek-harness/packages/sdk/protocol/src/index.ts) | 方法、通知、错误码？ | Q1 / Q2 |
| 2 | [`sdk/server`](../../../deepseek-harness/packages/sdk/server/src/index.ts) | session 生命周期与事件回传？ | Q2 / Q4 |
| 3 | [`sdk/client`](../../../deepseek-harness/packages/sdk/client/src/index.ts) | 子进程、请求/通知、背压？ | Q3 |
| 4 | [`bundle/headless`](../../../deepseek-harness/packages/bundle/headless/README.md) | one-shot runner 与 SDK 的区别？ | Q5 |
| 5 | [`acp`](../../../deepseek-harness/packages/acp/README.md) | 自动化协议与 SDK 的边界？ | Q5 |

---

## 3. 核心概念

### 3.1 帧

s17 用 newline-delimited JSON-RPC 2.0：

```json
{"jsonrpc":"2.0","id":1,"method":"session/create","params":{"id":"demo"}}
{"jsonrpc":"2.0","id":1,"result":{"sessionId":"demo"}}
{"jsonrpc":"2.0","method":"session/event","params":{"sessionId":"demo","event":{...}}}
```

### 3.2 方法

- `session/create {id?}` → `{sessionId}`
- `prompt {sessionId,text}` → `{answer,reason}`
- `session/event` 通知：每个 session event
- `shutdown` → `{ok}`

### 3.3 stdout 纯净

stdout 只放协议帧；日志必须走 stderr。否则客户端解析会失败。

### 3.4 关闭

`shutdown` 先返回响应，再关闭输出（`setImmediate`），避免 write-after-end。

---

## 4. 本课实现

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/jsonrpc.ts`](src/jsonrpc.ts) | newline JSON-RPC peer | `sdk/protocol` |
| [`src/sdk.ts`](src/sdk.ts) | session/create、prompt、事件通知 | `sdk/server` |
| [`src/sdk-server.ts`](src/sdk-server.ts) | stdio server | — |
| [`src/sdk-client.ts`](src/sdk-client.ts) | spawn + peer | `sdk/client` |

---

## 5. 验收

| 测试 | 证明 |
|---|---|
| JSON-RPC | 请求/响应、未知方法、通知 |
| SDK | 创建 session、prompt、事件通知 |

---

## 6. 刻意简化了什么

| 真实 DSH | s17 | 影响 |
|---|---|---|
| 完整方法集/多 session 并发 | create/prompt/shutdown | 教学 |
| 背压/流控/重连 | 无 | 后续 |
| ACP/stdio 多传输 | 只有 stdio | 接口相同 |
| 认证/权限 | 无 | 安全 |
| 客户端类型生成 | 手写 | 后续 |

---

## 7. 练习

1. **取消**：加 `prompt/cancel`，透传 AbortSignal。
2. **多 session**：并发 prompt，验证事件不串。
3. **背压**：客户端慢时限制通知队列。
4. **stdout 纯净**：把日志误写到 stdout，写测试捕获。
5. **ACP 对比**：列出 ACP 与 SDK 的方法差异。

---

## 8. 思考题（附源码位置与答案）

### Q1. JSON-RPC 帧如何编码？

s17 用一行一个 JSON 对象；真实 SDK 用 newline-delimited JSON-RPC 2.0，便于 stdio 流式读取。

### Q2. 方法如何设计？

请求/响应用于有结果的操作（create/prompt）；通知用于流式事件（session/event）；shutdown 用于优雅退出。

### Q3. 为什么 stdout 只能放协议帧？

客户端把 stdout 当协议流解析；任何日志都会破坏帧。日志必须走 stderr。

### Q4. 取消/关闭如何传播？

取消用 AbortSignal 透传到 Agent；关闭先响应再 end 输出，避免 write-after-end。

### Q5. SDK 与 ACP 的差异？

SDK 是 DSH 自有 JSON-RPC，面向进程外调用；ACP 是自动化协议，面向编辑器/代理集成。两者都投影 loop，但方法和能力不同。

---

## 9. 下一课：s18 · observability / eval

s17 把 harness 变成服务。s18 会让它可诊断、可回归：

- span/指标如何挂到生命周期？
- record/replay 如何离线复现？
- snapshot 应该包含什么？
- 故障注入覆盖哪些路径？

先读：[`telemetry`](../../../deepseek-harness/packages/telemetry/README.md) 与 [`testing.zh.md`](../../../deepseek-harness/docs/testing.zh.md)。
