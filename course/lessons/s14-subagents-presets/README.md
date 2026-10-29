# s14 · subagents / presets：委派与隔离

> 本课代码：`src/subagent.ts`（LocalSubagentBackend、SubagentManager、subagent 工具、preset）
>
> 测试：`tests/s14.test.ts`（3 个离线用例）+ s13 回归
>
> 模型：真实 DeepSeek，默认 `deepseek-flash`。

---

## 0. 先跑起来

```sh
cd course/lessons/s14-subagents-presets
cp env.example .env
node src/demo.ts
node --test tests/s14.test.ts
```

Demo 委派一个「用 calc 算 6*7」的子 agent，并演示深度上限。

---

## 1. 这一课要回答的问题

1. 子 agent 是「再开一个 loop」这么简单吗？
2. spawn 与 fork 的语义差异？
3. 深度预算和并发预算分别防什么？
4. 子会话为什么需要持久化？
5. preset 如何给不同 agent 不同工具/提示词？
6. 子 agent 的失败如何回到父 agent？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`subagent` README](../../../deepseek-harness/packages/subagent/subagent/README.md) | spawn/fork/ACP 的共享契约？ | Q1 / Q2 |
| 2 | [`manager.ts`](../../../deepseek-harness/packages/subagent/subagent/src/manager.ts) | 深度、并发、取消、完成通知？ | Q3 / Q6 |
| 3 | [`tool-subagent`](../../../deepseek-harness/packages/subagent/tool-subagent/src/index.ts) | 工具如何返回 child id？ | Q5 |
| 4 | [`preset`](../../../deepseek-harness/packages/preset/agent-preset-registry/README.md) | preset 如何按会话组装能力？ | Q5 |
| 5 | [`session-projection`](../../../deepseek-harness/packages/session/session-projection/README.md) | 子会话如何展示？ | Q4 |

---

## 3. 核心概念

### 3.1 spawn vs fork

- **spawn**：新会话，只带任务 + 继承的权限/来源；适合独立子任务。
- **fork**：复制父会话前缀，再继续；适合「从当前上下文分叉」。

s14 只实现 spawn；fork 可以复用 s09 的存储 fork。

### 3.2 预算是安全边界

- `maxDepth`：防止无限递归委派（0 = 禁止，1 = 只允许直接子级）。
- `maxActive`：限制同时存活的子 agent，防止资源耗尽。

预算在 manager 层检查，不能只靠工具描述。

### 3.3 preset

preset 是「按会话的能力组合」：

- 不同的提示词/persona；
- 不同的工具子集；
- 可选的模型/scope。

它让同一个进程里不同 agent 拥有不同能力，而不是全局一刀切。

### 3.4 子会话持久化

子会话也是正常 session：有事件日志、工具调用、可恢复。父 agent 通过 child id 引用它；完成通知通过父 agent 的 inbox 或结果返回。

---

## 4. 本课实现

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/subagent.ts`](src/subagent.ts) | backend、manager、工具、preset | `subagent/*` |
| [`src/demo.ts`](src/demo.ts) | 真实模型委派 | — |

```ts
const manager = new SubagentManager({ backend, maxDepth: 2, maxActive: 2 })
const result = await manager.spawn({ task, parentSessionId, depth: 0, preset })
```

---

## 5. 验收

| 测试 | 证明 |
|---|---|
| depth | 超过 maxDepth 拒绝 |
| active | 并发上限拒绝，完成后释放 |
| tool | 工具委派并渲染 child answer |
| preset | 工具子集过滤、persona 注入 |

---

## 6. 刻意简化了什么

| 真实 DSH | s14 | 影响 |
|---|---|---|
| 持久 child session / 可继续 | 内存会话 | s09 可接 |
| fork / ACP / SDK provider | 只有本地 spawn | 接口相同 |
| 完成通知回父 inbox | 结果直接返回 | 后续 |
| preset revision / isolate scope | 简化工具子集 | s11 可扩展 |
| 取消传播 | 只有 signal 透传 | 后续 |

---

## 7. 练习

1. **fork 子 agent**：复用 s09 的 `SessionStore.fork`，让子 agent 继承父历史。
2. **完成通知**：子 agent 完成后向父 inbox 注入一条结果消息。
3. **可继续子 agent**：实现 `sendMessage(childId, text)`，让子会话继续。
4. **preset 隔离**：用 s11 scope 让两个 preset 的工具同名但不互相覆盖。
5. **预算矩阵**：深度、并发、总 token 三种预算同时生效。

---

## 8. 思考题（附源码位置与答案）

### Q1. 子 agent 是「再开一个 loop」吗？

是，但不止：它需要独立会话、继承的权限/来源、深度/并发预算、完成通知、可继续句柄、持久化。直接 `new Agent` 只是最小骨架。

见 [`manager.ts`](../../../deepseek-harness/packages/subagent/subagent/src/manager.ts)。

### Q2. spawn 与 fork 的差异？

spawn 从空历史开始，只带任务；fork 复制父前缀，子会话继承上下文。fork 需要 seed 边界和 closer，spawn 不需要。

### Q3. 深度/并发预算防什么？

深度防无限递归委派；并发防资源耗尽（进程、连接、token）。两者都在 manager 层强制。

### Q4. 子会话为什么持久化？

完成后父 agent 可能继续引用；用户可能查看/继续；崩溃后可恢复。子会话是正常 session，不是临时对象。

### Q5. preset 如何给不同 agent 不同能力？

preset 在会话创建时组装提示词、工具、模型和 scope；工具/提示词注册可以挂在该 agent 的 scope 上，从而只对它可见。

### Q6. 子 agent 失败如何回父 agent？

工具返回结构化错误或结果；父 agent 把失败作为 tool result 看到，决定重试/改写任务/放弃。不能静默吞掉。

---

## 9. 下一课：s15 · MCP / skills / commands

s14 解决了委派。s15 会接入外部能力：

- MCP 工具如何发现、命名、执行？
- skill 目录如何注入、按需加载？
- slash command 为什么不走模型？
- 外部工具的错误如何映射成模型可见结果？

先读：[`mcp`](../../../deepseek-harness/packages/mcp/README.md)、[`skill`](../../../deepseek-harness/packages/skill/README.md)。
