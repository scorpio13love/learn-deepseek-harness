# s16 · web：session projection 与 SSE

> 本课代码：`src/projection.ts`、`src/web.ts`、`src/demo.ts`
>
> 测试：`tests/s16.test.ts`（2 个离线用例）+ s15 回归
>
> 本课不调用模型；重点是把会话状态送到浏览器并在断线后恢复。

---

## 0. 先跑起来

```sh
cd course/lessons/s16-web
node src/demo.ts
node --test tests/s16.test.ts
```

Demo 启动 `http://127.0.0.1:<port>`：

- `/api/session`：当前快照；
- `/api/events?since=-1`：SSE 重放 + 增量；
- `/`：极简 HTML 客户端。

---

## 1. 这一课要回答的问题

1. 为什么客户端不自己 fold 事件？
2. 快照和增量如何配合？
3. 断线重连如何从 seq 恢复？
4. 多客户端为什么能保持一致？
5. projection 为什么必须是纯同步 fold？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`session-projection`](../../../deepseek-harness/packages/session/session-projection/src/index.ts) | 注册、fold、快照、变更流？ | Q1 / Q5 |
| 2 | [`host/webserver`](../../../deepseek-harness/packages/host/webserver/src/index.ts) | 命名路由、升级路由、fallback？ | Q2 |
| 3 | [`session-controller`](../../../deepseek-harness/packages/api/session-controller/src/index.ts) | 历史尾页 + `session/projection` 推送？ | Q2 / Q3 |
| 4 | [`client/connection`](../../../deepseek-harness/packages/client/connection/src/index.ts) | 重连、去重、流恢复？ | Q3 |
| 5 | [`client/ui-conversation`](../../../deepseek-harness/packages/client/ui-conversation/src/index.ts) | 为什么客户端只渲染投影？ | Q1 |

---

## 3. 核心概念

### 3.1 projection 是纯 fold

```ts
apply(state, event) → nextState
```

- 同步、无 I/O；
- 无关事件返回同一个引用；
- 框架负责驱动，领域只负责计算。

s16 的 `SessionProjection` 在每次 append 后重新 fold 消息/状态/usage；真实 DSH 用增量 fold + stateSchema。

### 3.2 快照 + 增量

客户端首屏拿 `{seq, state}`，然后订阅 seq 之后的事件/投影帧。快照与增量在同一个 seq 切点，避免「先看到新状态又收到旧事件」的错乱。

### 3.3 断线重连

客户端记住最后收到的 seq，重连时带 `since`。服务端重放 `seq > since` 的事件，再转入 live。这样不丢事件、不重复。

### 3.4 多客户端

投影由 host 计算一次，所有客户端读同一份；客户端不各自 fold，避免版本/顺序差异。

---

## 4. 本课实现

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/projection.ts`](src/projection.ts) | 消息/状态/usage fold | `session-projection` |
| [`src/web.ts`](src/web.ts) | HTTP + SSE | `host/webserver` + `session-controller` |
| [`src/demo.ts`](src/demo.ts) | 事件流演示 | — |

---

## 5. 验收

| 测试 | 证明 |
|---|---|
| projection | 消息、turn、status、usage |
| web | snapshot 端点 |
| SSE | 重放 + live 推送 |

---

## 6. 刻意简化了什么

| 真实 DSH | s16 | 影响 |
|---|---|---|
| 多路由/升级/fallback | 单文件 server | 教学 |
| 投影缓存/checkpoint | 每次全量 fold | 规模 |
| 认证/Origin/远程权限 | 无 | 安全 |
| 客户端插件/slot | 单 HTML | s17 之后 |
| 断线去重协议 | since 简单过滤 | 够用 |

---

## 7. 练习

1. **增量 projection**：只 fold 新事件，不重算历史。
2. **多客户端**：两个 SSE 客户端同时连接，验证事件一致。
3. **重连**：断开后从 `since=lastSeq` 恢复，不重复。
4. **认证**：给 `/api/*` 加 token。
5. **UI 卡片**：把 tool/result 渲染成不同 HTML。

---

## 8. 思考题（附源码位置与答案）

### Q1. 为什么客户端不自己 fold 事件？

因为 fold 规则属于领域，客户端版本可能落后；多客户端会各自算出不同结果。Host 计算一次，客户端只渲染。

### Q2. 快照和增量如何配合？

快照携带 seq；增量只发 seq 之后的事件/投影。切点一致就不会出现「旧事件覆盖新状态」。

### Q3. 断线重连如何恢复？

客户端记住最后 seq，重连带 `since`；服务端重放 `seq > since` 的事件，再转 live。

### Q4. 多客户端为什么一致？

所有客户端读同一份 host 投影；事件顺序由 session seq 决定。

### Q5. projection 为什么必须纯同步？

异步 fold 会撕裂一致性切点：事件可能在新状态算完前继续到达。纯同步 fold 保证每个事件的 state 是一个确定值。

---

## 9. 下一课：s17 · SDK / headless

s16 把状态送到浏览器。s17 会把 harness 变成进程外服务：

- JSON-RPC 帧如何编码？
- session/create / prompt / events 通知如何设计？
- stdout 为什么只能放协议帧？
- 取消/关闭如何传播？
- SDK 和 ACP 的差异？

先读：[`sdk/protocol`](../../../deepseek-harness/packages/sdk/protocol/src/index.ts)。
