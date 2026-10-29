# s07 · inbox / steering：运行中的 agent 如何接收输入

> 本课代码：`src/`（新增 `inbox.ts`；`agent.ts` 改成队列驱动，支持 followup / steer / inject / cancel / whenIdle）
>
> 测试：`tests/s07.test.ts`（10 个离线用例）+ s03-s06 回归（44 个）+ `tests/live.test.ts`（1 个真实模型用例）
>
> 模型：真实 DeepSeek，默认 `deepseek-flash`。

---

## 0. 先跑起来

```sh
cd course/lessons/s07-inbox-steering

cp env.example .env
# 编辑 .env，至少填入 DEEPSEEK_API_KEY

node src/demo.ts
node --test tests/s07.test.ts
node --test tests/s06-regression.test.ts tests/s05-regression.test.ts tests/s04-regression.test.ts tests/s03-regression.test.ts
node --test tests/live.test.ts     # 需要 key
```

Demo 会：

1. `inject` 一条上下文，确认 agent 仍是 idle、没有事件；
2. `start` 一个真实模型任务（调用 `wait` 工具 600ms）；
3. 在工具执行期间 `steer` 一条补充；
4. 观察 steering 在 `step/end` 之后、下一个 `step/start` 之前进入历史。

事件序列大致是：

```text
step/start
system/message
user/message  (injected context)
user/message  (prompt)
assistant/message → tool/call wait → tool/result
step/end
user/message  (steering)
step/start
assistant/message
step/end
turn/end
```

---

## 1. 这一课要回答的问题

1. `next-turn` 与 `next-step` 有什么区别？
2. `followup` / `steer` / `inject` 分别落在哪个队列、是否唤醒？
3. claim 为什么是纯删除？轮次边界和步骤边界分别领取什么？
4. 取消时 `keepInbox` 保留什么？为什么取消后的唤醒要改投下一轮？
5. 为什么 steering 在 `step/end` 之后才进入历史？
6. `whenIdle` 为什么要跨越多个排队轮次？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`inbox.ts`](../../../deepseek-harness/packages/core/agent-loop/src/inbox.ts) | 两条队列、claim、纯删除如何实现？ | Q1 / Q2 / Q9 |
| 2 | [`agent.ts` → `send` / `followup` / `steer` / `inject`](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L170) | 三种输入的路由和唤醒差异？ | Q3 / Q4 |
| 3 | [`agent.ts` → `wakeDriver`](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L230) | 唤醒为什么需要收敛/闩锁？ | Q6 |
| 4 | [`agent.ts` → `cancel`](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L191) | 取消如何清空/保留队列？ | Q5 |
| 5 | [`agent.ts` → `whenIdle`](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L253) | 为什么它观察整个 agent，而不是单个轮次？ | Q8 |
| 6 | [`core.zh.md` 的 inbox 段](../../../deepseek-harness/docs/subsystems/core.zh.md) | claim 与持久投影的关系？ | Q2 / Q10 |
| 7 | [`agent-lifecycle.zh.md`](../../../deepseek-harness/docs/agent-lifecycle.zh.md) | steering 的领取发生在时序的哪一步？ | Q7 |

读完后，你应该能画出：

```text
followup ──▶ next-turn ─┐
steer    ──▶ next-step ─┤
inject   ──▶ next-step ─┘
                         │
turn boundary: claim all next-step + one next-turn
step boundary: claim all next-step
```

---

## 3. 核心概念

### 3.1 两条队列

- `next-turn`：每条消息独占一个新轮次（`followup`）；
- `next-step`：在下个步骤边界消费（`steer` / `inject`）。

轮次边界领取**全部 next-step + 一条 next-turn**；步骤之间只领取 **next-step**。

### 3.2 claim 是纯删除

claim 不是「消费后通知」，而是「从队列删除，然后逐条发 claimed」。队列本身只保存待处理消息；一旦 claim，消息就离开队列。

这样：
- 同一消息不会被两个步骤领取；
- 取消时清空队列即可；
- 消费方通过 claimed 通知拿消息，而不是依赖队列里还在。

### 3.3 三种输入

| 方法 | 目标 | 是否唤醒 idle |
|---|---|---|
| `followup` | next-turn | 是 |
| `steer` | next-step | 是 |
| `inject` | next-step | 否 |

`inject` 用于「运行时上下文」：它不应该让一个空闲 agent 凭空开始工作，只在下一次有人唤醒时被领取。

### 3.4 取消与 keepInbox

```ts
agent.cancel({ kind: 'user' })                 // 清空 pending + 中止当前活动
agent.cancel({ kind: 'user' }, { keepInbox: true }) // 只中止，保留待处理输入
```

保留的输入不会被自动重放；需要下一次 wake（followup/steer）才能继续。

### 3.5 唤醒收敛

如果当前活动已经中止，`followup/steer` 不应把新输入塞进正在死亡的活动；它们应该等到活动收敛后再启动下一轮。真实 DSH 用 `wakeRequested` 闩锁处理这件事；s07 用单个 `#activity` promise + 循环简化。

### 3.6 whenIdle

`whenIdle()` 等待整个 agent 回到 idle，可能跨越：
- 当前轮次；
- 排队中的后续轮次；
- 由 steering 触发的额外步骤。

它不是「等待某条消息的回复」，而是「等待没有活动」。

---

## 4. 本课实现

### 4.1 文件地图

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/inbox.ts`](src/inbox.ts) | 两条队列、claim、append/prepend/replace/remove/clear | `agent-loop/src/inbox.ts` |
| [`src/agent.ts`](src/agent.ts) | followup/steer/inject、驱动循环、cancel、whenIdle | `agent-loop/src/agent.ts` |
| [`src/demo.ts`](src/demo.ts) | inject + start + steer + wait 工具 | — |

### 4.2 驱动循环

```ts
async run(prompt) {
  this.#inbox.append('next-turn', msg)
  this.#wake()
  await this.whenIdle()
  return this.#lastResult
}

#drive(signal) {
  while (!signal.aborted) {
    const claimed = this.#inbox.claim('turn')
    if (claimed.length === 0) return
    this.#lastResult = await this.#runTurn(claimed, signal)
    if (signal.aborted || !this.#inbox.hasPending) return
  }
}
```

### 4.3 轮次内部

```ts
turn/start
  step/start
    system 准入
    首次领取的 user 消息
    context
    assistant / tools
  step/end
  领取 steering（next-step）→ 写入 user/message
  step/start（如果有 steering）
  ...
turn/end
```

steering 在 `step/end` 之后、下一个 `step/start` 之前进入历史，保证它不被算进刚结束的步骤。

### 4.4 取消

```ts
cancel(cause, { keepInbox }) {
  if (!keepInbox) this.#inbox.clear()
  this.#controller?.abort(cause)
}
```

活动信号中止 → 当前轮次以 `aborted` 关闭；`#drive` 看到 signal 中止后退出。

---

## 5. 验收

离线（`tests/s07.test.ts`）：

| 测试 | 证明 |
|---|---|
| inbox turn claim | 全部 next-step + 一条 next-turn |
| inbox step claim | 只消费 next-step；unique/replace/remove |
| followup | idle 唤醒并运行一轮 |
| inject | idle 不唤醒；下一次 run 先领取 |
| steer | 在下一步骤被消费，第二次请求包含它 |
| followup while running | 启动第二轮，whenIdle 等两轮 |
| cancel | 默认清空；keepInbox 保留 |
| cancel active | 轮次 aborted，回到 idle |
| start | fire-and-forget + whenIdle |
| queue order | next-step 在 next-turn 之前 |

回归：s03-s06 共 44 个用例全部保留。

真实模型：prompt + pipeline + batch + inbox 的完整一轮，stream/重放/压缩。

---

## 6. 刻意简化了什么

| 真实 DSH | s07 | 影响 |
|---|---|---|
| inbox 是持久投影 + `agent/inbox/*` 事件 | 内存队列 | s09/s11 |
| pre-step 可拒绝/改写输入 | 无 | 后续 |
| wake 闩锁与 maintenance | 单 activity + 循环 | 教学够用 |
| `runMaintenance` / `status` 事件 | 只有 `status` getter | s11 |
| 取消原因的完整 `turn/end` 复制 | 只保留 kind | 真实实现复制原因 |
| 多 agent 并发 | 单 agent | s14 |

---

## 7. 练习

### 1. 给 inbox 加持久化

把每次 append/claim 写成 `inbox/spliced` 事件（surface 之外），重启后重放：

- append → 插入；
- claim → 纯删除；
- 验证 pending 恢复一致。

提示：s02 的事件信封可以直接复用。

### 2. steering 的中途取消

在 steer 之后、下一步 claim 之前取消：

- 默认应丢弃 steering；
- keepInbox 应保留；
- 验证不会进入模型历史。

### 3. 优先级

目前 claim 先 next-step 后 next-turn。要求：

- 加一个 `priority` 字段；
- 同一队列内按优先级稳定排序；
- 思考：为什么模型可见顺序必须确定？

### 4. whenIdle 的边界

要求：

- run 返回后，立刻 followup；
- whenIdle 应该等待第二轮；
- 验证返回的 lastResult 是最后一轮。

### 5. inject 的上下文合并

要求：

- 多个 inject 在同一个步骤被领取；
- 合并成一条 user 消息还是多条？分别有什么影响？
- 实现其中一种并写测试。

---

## 8. 思考题（附源码位置与答案）

### Q1. next-turn 与 next-step 有什么区别？

- next-turn：一条消息开启一个新轮次，独占该轮次的初始输入；
- next-step：在最近的步骤边界被领取，可在一个轮次内多次消费。

区别决定「这句话是新一轮任务，还是对当前任务的补充」。

见 [`InboxTarget`](../../../deepseek-harness/packages/core/agent/src/types.ts#L344)。

### Q2. claim 为什么是纯删除？轮次/步骤边界分别领取什么？

claim 从队列移除消息，然后逐条发 claimed 通知。这样消息不会留在队列里被重复领取；消费方通过通知拿到已领取的事实。

轮次边界领取全部 next-step + 一条 next-turn；步骤之间只领取 next-step。

见 [`inbox.ts`](../../../deepseek-harness/packages/core/agent-loop/src/inbox.ts)。

### Q3. followup / steer / inject 的区别？

- followup → next-turn，唤醒；
- steer → next-step，唤醒；
- inject → next-step，不唤醒。

「唤醒」决定空闲 agent 是否因为这条输入开始工作。

### Q4. 为什么 inject 不唤醒？

注入上下文是「补充信息」，不是「新任务」。如果它唤醒 idle agent，会产生没有用户意图的模型轮次。它应该等下一次真实输入（followup/steer）一起被领取。

### Q5. 取消时 keepInbox 保留什么？

保留两条队列中的待处理消息，只中止当前活动。保留下来的消息不会自动重放；需要下一次 wake。

默认取消会清空队列，因为用户通常想「停下来并丢弃未开始的工作」。

见 [`cancel()`](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L191)。

### Q6. 为什么唤醒需要收敛/闩锁？

如果当前活动已经中止，新输入不能塞进正在死亡的活动；否则它可能被 abort 吞掉。唤醒应该等当前活动收敛后再启动下一轮。

真实 DSH 用 `wakeRequested` 闩锁；s07 用单 activity promise + `#drive` 循环简化。

### Q7. 为什么 steering 在 step/end 之后才进入历史？

step 是「一次模型请求 + 它请求的工具」。steering 是在这个步骤之后才被消费的新输入，应该属于下一步，而不是刚结束的步骤。放在 `step/end` 之后能保持步骤边界清晰。

见 [`agent-lifecycle`](../../../deepseek-harness/docs/agent-lifecycle.zh.md) 的 claim 时序。

### Q8. whenIdle 为什么要跨越多个排队轮次？

`whenIdle` 观察的是整个 agent 的活动，而不是单条消息的回复。一个 followup 可能在当前轮次之后又开启一轮；只有所有排队工作和维护任务都结束，才真正 idle。

见 [`whenIdle`](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L253)。

### Q9. 为什么消息需要稳定 id？

inbox 支持 replace/remove/claim，消费方需要跨队列定位同一条待处理消息。稳定 id 还用于 `agent/inbox/claimed` 等通知，让 UI 能把「排队中」和「已领取」对应起来。

见 [`MessageId`](../../../deepseek-harness/packages/core/agent/src/types.ts) 与 inbox 的 `#assertUnique`。

### Q10. 为什么真实 DSH 的 inbox 是持久投影？

因为进程重启后，待处理输入不能丢。真实 inbox 把每次 splice 写成 session 事件，投影 fold 出当前队列；claim 也是 splice。s07 为了聚焦语义先做内存版，s09 会处理持久化。

见 [`core.zh.md` 的 inbox 段](../../../deepseek-harness/docs/subsystems/core.zh.md)。

---

## 9. 下一课：s08 · LLM seam

s07 解决了输入路由。s08 会转向模型适配器 seam：

- `prepareCall` 到底绑定什么？
- `systemPromptUpdate` / `toolUpdate` 能力如何影响提示词与工具增量？
- 重试应该发生在哪一层？
- 如何在不改 loop 的情况下换 provider？
- DeepSeek 的 Messages 与 Chat Completions 有什么差异？

先读：[`llm/llm/src/call-config.ts`](../../../deepseek-harness/packages/llm/llm/src/call-config.ts) 与 [`llm-deepseek`](../../../deepseek-harness/packages/llm/llm-deepseek/)。
