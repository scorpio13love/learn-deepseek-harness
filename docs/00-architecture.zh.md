# DeepSeek Harness 源码架构阅读笔记

> 对应源码：`deepseek-harness/`，版本 `0.2.2-alpha.2`（commit `f3803c9`）。行号会随版本漂移，定位以函数名为准。
>
> 阅读前提：熟悉 TypeScript、async/await、AbortSignal；了解「事件溯源」和「依赖注入」的基本概念即可。Cordis 不需要提前学，第 4 节会讲。

## 0. 这份文档怎么用

读一个 7000+ 文件、80+ workspace 包的 monorepo，最容易迷路。建议始终沿着三条线读，不要按目录顺序从头啃：

| 阅读线 | 要回答的问题 | 本文对应章节 |
|---|---|---|
| **运行时线** | 一个 `dsh` 进程是怎么被组装出来的？ | 2、4、12 |
| **数据线** | 用户说一句话之后，数据如何变成模型请求、工具调用、最终回答，并被记录下来？ | 5、6、7、8 |
| **扩展线** | 想加一个工具 / 模型 / UI / 沙箱，代码挂在哪里？ | 9、10、11、13、14、15 |

全文反复出现三个词，先约定含义：

- **session event**：追加到会话日志的持久事实，重载后仍在。它是唯一真源。
- **agent event**（`agent/*`）：进程内的实时协调事件，不持久化，用于拦截、观察、steering。
- **capability event**（`fs/*`、`tools/*`、`telemetry/*`）：能力 seam 上的策略钩子，让插件无需互相 import。

---

## 1. 一句话架构

> DeepSeek Harness 是一个**全插件**的 agent 运行时：模型适配器、工具、提示词、会话日志、沙箱、UI、甚至 agent loop 本身都是插件。一次 agent 轮次只做四件事——**领取输入 → 组装请求 → 流式调用模型 → 执行模型请求的工具 → 重复**——而所有模型可见内容都必须能从 append-only 的会话日志重建。

这句话里有三个设计承诺，贯穿整个代码库：

1. **没有特权内核**。不存在一个「核心」可以绕过插件系统；扩展 = 把插件挂到别的插件旁边。
2. **注册即副作用**。工具、提示词段、事件监听器都通过 `ctx.effect()` / `ctx.on()` 安装，插件卸载时自动撤销，因此 HMR / 热插拔是默认能力而不是补丁。
3. **模型可见即已记录**（model-visible ⟺ logged）。任何进入模型请求的输入，都必须能从会话日志重建；新增一种模型可见输入，就必须新增一种 session event。

---

## 2. 运行时全景：从 `dsh` 命令到插件树

### 2.1 入口

CLI 入口在 [`apps/cli/src/bin.ts`](../deepseek-harness/apps/cli/src/bin.ts)，解析 `--profile` 后交给 profile runner。支持的 profile 是 `web`、`headless`、`sdk`、`sdk-minimal`、`acp`：

```sh
dsh                      # 默认 web
dsh --profile headless "解释这个仓库"
dsh --profile web --dump-config
```

`--dump-config` 会打印最终组合出来的完整条目树。**这是读这个仓库最好用的入口**：你能直接看到运行时到底挂了哪些插件、顺序如何、配置是什么。

### 2.2 profile、bundle、patch 三层

一个运行中的 dsh 是一棵插件树，由启动时按序叠加的层组成：

```text
空根
  → profile 中列出的有序 bundle（每个 bundle 提供 patch 文件）
  → profile 自己的 cordis.patch.yml
  → Harness home 的 cordis.patch.yml
  → 命令行 --patch overlay
  → Loader 按条目 id 应用：替换整个 config，或插入新条目
```

- **profile**：命名组装，存放在 `$DSH_HOME/profiles/<name>`，声明它叠加哪些 bundle，并保存用户 patch。
- **bundle**：可分发的「Cordis 配置 + 挂载代码」包。`dsh-base` 是所有 base-backed profile 的第一层；`dsh-web-app`、`dsh-headless`、`dsh-sdk-app`、`dsh-acp-app` 各自追加自己的入口层。
- **patch**：按 id 定位条目，替换整个 config 或插入新条目。层优先级是后者覆盖前者。

关键源码：

- [`packages/boot/app-boot/README.md`](../deepseek-harness/packages/boot/app-boot/README.md)——profile 加载、patch 组合、启动失败矩阵。
- [`packages/bundle/base/cordis.patch.yml`](../deepseek-harness/packages/bundle/base/cordis.patch.yml)——base 层到底挂了什么（LLM、session、tools、agent、jobs、compaction、approval……）。
- [`packages/bundle/headless/`](../deepseek-harness/packages/bundle/headless/)——不带 HTTP / 浏览器的一次性运行器。

```text
┌──────────────────────────── dsh process ────────────────────────────┐
│  Cordis root Context                                                │
│  ├─ LLM seam          ctx.llm            adapter(s)                 │
│  ├─ Session           ctx.sessions        event log + store         │
│  ├─ Tools             ctx.tools           registry + executor       │
│  ├─ System prompt     ctx.systemPrompt    sections + tools schema   │
│  ├─ Agents            ctx.agents          registry + initiator      │
│  ├─ Agent loop        ctx.agentLoop       driver (AgentFactory)     │
│  ├─ Persistence       ctx.sessionPersistence                        │
│  ├─ Sandbox/FS/Shell  ctx.sandbox / ctx.fs / ctx.shell              │
│  ├─ Approval          ctx.approval                                  │
│  ├─ Subagents         ctx.subagents                                 │
│  └─ Transport         web / SDK JSON-RPC / ACP / headless           │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.3 桌面与远程

Electron 桌面应用（[`apps/desktop`](../deepseek-harness/apps/desktop/)）在签名资源里携带一份 dsh 生产运行时，启动私有 Desktop Host，再调用同一个 profile runner 和完整 Web 应用。窗口先加载打包好的 Web 资源，等待启动注入后在同一文档里激活客户端插件；Node IPC 承载启动、就绪、错误与关闭。

---

## 3. 包地图

完整分组见 [`packages/README.zh.md`](../deepseek-harness/packages/README.zh.md)。先记住主干与 ctx key：

| 包 | 职责 | ctx key |
|---|---|---|
| `core/session` | 仅追加的 `SessionEvent` 日志、内存 store、`deriveMessages()` | `ctx.sessions` |
| `core/system-prompt` | 提示词段落、变量、工具 schema 组装 | `ctx.systemPrompt` |
| `core/tools` | 工具注册表 + 受保护的执行流水线 | `ctx.tools` |
| `core/agent` | `Agent` 接口、活跃 agent 注册表、`agent/*` 事件、发起者作用域 | `ctx.agents` |
| `core/agent-loop` | 默认 driver，实现 `Agent` 契约与 `AgentFactory` | `ctx.agentLoop` |
| `core/scope` | 按 agent 划分作用域的注册原语（无 ctx key） | — |
| `llm/llm` | 消息 / 流式 / 请求词汇表与适配器 seam | `ctx.llm` |
| `session/session-persistence*` | 持久化 seam + JSONL 后端、格式迁移 | `ctx.sessionPersistence` |
| `session/session-projection` | 从事件日志折叠出客户端可读的领域状态 | `ctx.sessionProjections` |
| `fs/*`、`shell/*`、`subprocess/*`、`sandbox/*` | 执行世界的能力 seam 与本地/远程提供方 | `ctx.fs`、`ctx.shell`、`ctx.subprocess`、`ctx.sandbox` |
| `interaction/*` | 审批、权限预设、用户提问、命令 | `ctx.approval`、`ctx.userQuestions`、`ctx.commands` |
| `subagent/*` | 委派 seam、spawn/fork 提供方、`subagent` 工具 | `ctx.subagents` |
| `compaction/*` | 上下文压缩 seam + 基础实现 | `ctx.compaction` |
| `mcp/*` | 外部 MCP 服务器接入为原生工具 | `ctx.mcp` |
| `boot/*`、`bundle/*` | 启动、profile 组合、插件管理 | — |
| `sdk/*`、`acp/*` | JSON-RPC / ACP 进程外协议 | — |
| `host/*`、`client/*` | Web GUI 宿主与浏览器半侧 | — |

依赖方向有一条硬规则：**扩展插件依赖 Service Definition，绝不依赖具体提供方**。例如 UI、钩子、工具都依赖 `dsh-agent`，而不是 `dsh-agent-loop`；因此 loop 可以被替换。

---

## 4. Cordis：60 秒理解插件内核

Cordis 通过 `vendor/` 引入，核心源码只有 ~2700 行（[`vendor/cordis/src`](../deepseek-harness/vendor/cordis/src)）。读它的顺序：`context.ts` → `registry.ts` → `fiber.ts` → `events.ts` → `service.ts`。

### 4.1 五个概念

- **插件是实现 Service 的对象**：一个带 `apply(ctx)` 的函数，或一个 `Service` 子类。
- **Context 是服务容器**：一个服务占据稳定的 `ctx.<key>`，其他插件按 key 查找，而不是 import 实现。
- **`inject` 声明依赖**：插件等待所需服务就绪才启动，加载顺序由依赖表达，而不是手写启动序列。
- **类型化事件**：通过 TypeScript 声明合并注册事件名，再以五种模式分发。
- **注册是可逆副作用**：`ctx.effect()` / `ctx.on()` 返回 disposer，插件卸载时撤销。

### 4.2 五种事件分发模式

| 模式 | 是否 await | 顺序 | 返回值 | 典型用途 |
|---|---|---|---|---|
| `emit` | 否 | 注册顺序观察 | 无 | 状态广播、遥测 |
| `waterfall` | 否 | 注册顺序，环绕 | 有 | 中间件：pre-step、LLM 调用、工具策略 |
| `parallel` | 是 | 并行 | 无 | 扇出通知 |
| `serial` | 是 | 注册顺序 | 有 | 有序检查点（`agent/turn-stopping`） |
| `bail` | 否 | 注册顺序，首个 bail 值停止 | 有 | 短路查找 |

**waterfall 是环绕中间件**：监听器收到 `(...args, next)`，调用 `next()` 执行下游；下游返回值通过 `next()` 返回，可以包装后再返回；不调用 `next()` 直接返回就是短路。

这条语义解释了大量 DSH 代码：

- `agent/pre-step`：监听器可以 reject、改写消息，或调用 `next()` 委托。
- `tools/pre-execute`：策略监听器可以 allow / deny / ask / cancel。
- `llm/stream`：适配器或中间件可以包装整个流。

### 4.3 effect 与 Fiber

每个插件挂载都会产生一个 Fiber；插件里注册的一切都归属这个 Fiber。释放 Fiber 会按逆序撤销：

```ts
export function apply(ctx: Context) {
  ctx.tools.register(myTool)        // 注册即副作用
  ctx.on('session/event', handler)  // 监听即副作用
  ctx.effect(() => ctx.agents.setFactory(this), 'agentLoop.setFactory()')
}
```

这不是「优雅」，而是正确性要求：HMR、插件市场、会话级 preset 都依赖「卸载即干净」。

### 4.4 Scope

[`core/scope`](../deepseek-harness/packages/core/scope) 提供 `createScope` / `scopeOf` / `scopeTarget`，把注册限制到单个 agent。`agent.ctx` 是 agent 作用域上下文：在这里注册的工具/提示词只对该 agent 生效，同名时遮蔽全局。这是 subagent、per-session preset 的基础。

---

## 5. 核心对象模型

```text
AgentRegistry (ctx.agents) ──creates──▶ AgentHandle { agent, dispose() }
        │                                      │
        │                                      ├─ Agent
        │                                      │   ├─ id / options / status
        │                                      │   ├─ session ──▶ Session (event log)
        │                                      │   ├─ model   ──▶ Model (selection)
        │                                      │   ├─ inbox   ──▶ Inbox (next-turn/next-step)
        │                                      │   └─ ctx     ──▶ Context (agent scope)
        │                                      │
        └─ AgentFactory ◀── implements ── AgentLoop (ctx.agentLoop)
                                              └─ ReactLoopAgent (driver)

ToolRegistry (ctx.tools) ── ToolDefinition { schema, output, execute, ... }
LLM (ctx.llm) ── adapter(provider) ── PreparedLlmCall ── stream(chunks)
SystemPrompt (ctx.systemPrompt) ── sections + variables + contexts + tool schemas
Session (ctx.sessions) ── SessionEvent[] ── deriveMessages() ── Message[]
```

### 5.1 Agent 句柄

[`packages/core/agent/src/types.ts`](../deepseek-harness/packages/core/agent/src/types.ts) 的 `Agent` 是 UI、钩子、orchestrator 面向编程的唯一 surface：

- `send / followup / steer / inject`：投递输入到两个 inbox 边界之一，并可选择是否唤醒 driver。
- `cancel(cause, { keepInbox })`：取消当前活动；`keepInbox` 保留排队工作。
- `whenIdle()`：等待整个 agent 活动达到静止（可能跨越多个连续轮次）。
- `runMaintenance(task)`：在真正空闲的阶段跑一个非轮次维护任务。

创建返回 `AgentHandle`，dispose 是**能力**（capability）：只有持有者能拆掉这个 agent。配置声明的 agent 由 loop fiber 拥有，不需要句柄。

### 5.2 Session

Session 是一份类型化 `SessionEvent` 的**仅追加日志**。每个事件有单调 `seq`、`time`、`type` 判别的 `data`。消息历史不单独存储，而是由 `deriveMessages()` 从日志投影出来。

核心事件（[`core/session/src/types.ts`](../deepseek-harness/packages/core/session/src/types.ts)）：

| 事件 | 是否进入模型历史 | 作用 |
|---|---|---|
| `turn/start` / `turn/end` | 否 | 轮次边界与结束原因 |
| `step/start` / `step/end` | 否 | 步骤边界（一次模型请求 + 工具） |
| `system/message` | 是 | 渲染后的系统提示词（surface node 0） |
| `user/message` | 是 | 人、注入上下文、steering、goal 续跑 |
| `developer/message` | 是 | 工具增删等增量变更 |
| `assistant/message` | 是 | 模型输出 + 嵌入的完整流 + usage |
| `assistant/attempt` | 否 | 失败/重试/取消/流错误的持久结算 |
| `tool/call` / `tool/result` | result 是 | 工具调用与结果 |
| `request/header` | 否 | 请求信封快照（config + tools） |
| `request/context` | 否 | 路由元数据（contextWindow、prompt 更新模式） |
| `session/end-seed` | 否 | fork / restore 的继承边界标记 |

### 5.3 Inbox

两条有序待处理队列（[`agent-loop/src/inbox.ts`](../deepseek-harness/packages/core/agent-loop/src/inbox.ts)）：

- `next-turn`：每个消息独占一个新轮次（`followup`）。
- `next-step`：在下个步骤边界消费（`steer` / `inject`）。

在轮次边界，driver 原子地领取**全部 next-step + 一条 next-turn**；在步骤之间只领取 next-step。领取是「纯删除」，不会发 discarded；领取成功后逐条发 `agent/inbox/claimed`。

### 5.4 ToolDefinition

[`core/tools/src/contracts.ts`](../deepseek-harness/packages/core/tools/src/contracts.ts)：

- `name / description / parameters`：模型可见的 schema。
- `output.schema + render`：工具只返回规范 JSON 值，渲染成模型内容由声明负责。
- `execute(args, exec)`：参数已校验、已冻结，`exec.signal` 必须被观察。
- `projectContent / finalizeContent`：在 post-execute 前后改写内容。
- `isConcurrencySafe(args)`：只有返回 `true` 才允许与兄弟调用并发。
- `presentCall / presentResult`：纯函数 UI 展示投影。

### 5.5 LLM 词汇表

[`llm/llm/src/types.ts`](../deepseek-harness/packages/llm/llm/src/types.ts)：

- `ContentBlock`：text / reasoning / image / file / tool-call / tool-addition / tool-removal，可扩展。
- `StreamChunk`：`block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage`、`finish`。块索引关联交错的 delta。
- `GenerateOptions`：一次完整请求；loop 构造的请求把系统提示词放在 `messages` 的 system 节点里，**不设 `system` 字段**。
- `TokenUsage`：输入/输出/cache 计数是**不相交**的；缓存命中单独计。

---

## 6. 一次 turn 的完整时序

这是全仓库最值得背下来的一张图。源码级细节见 [`docs/agent-lifecycle.zh.md`](../deepseek-harness/docs/agent-lifecycle.zh.md) 与 [`docs/architecture.zh.md`](../deepseek-harness/docs/architecture.zh.md#turn-flow)。

```text
turn/start
  领取 next-step 全部 + 一条 next-turn
  快照 model selection；组装 prompt sections + 本步准入的 tool schemas
  -> agent/pre-step（waterfall）
        reject        → 关闭轮次，不产生步骤
        enter(msgs)   → 继续
  step/start
  agent/request（waterfall，可改采样等控制参数）
  ctx.llm.prepareCall(config, signal)     ← 绑定适配器、解析默认值
  同步准入：system/message 对账 + user/message 逐条追加 + request/header/context
  从日志派生并冻结请求
  llm/stream → agent/assistant-stream start/chunk*/end
       assistant/message（成功） 或 assistant/attempt（失败/取消/重试）
  若有 tool-call：
       tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
       （工具体可并发；策略与结果按模型顺序提交）
  step/end
  若工具要求继续，或 next-step 有新输入 → 下一步
  否则 agent/turn-stopping（serial）
turn/end
```

### 6.1 turn 与 step 的区别

- **step** = 一次模型请求 + 它请求的工具。
- **turn** = 0 个或多个 step。轮次在领取首条输入之前打开，在不再欠任何工作时关闭。

一个 turn 可以没有 step（pre-step reject、输入被改写为空、取消）。一个 step 失败后 turn 也可能继续（例如 `agent/request-error` 返回 retry）。

### 6.2 三个关键不变量

1. **模型可见即已记录**。每个请求必须能从日志重建。请求 = `header.config` + `deriveMessages()` + `header.tools`，没有独立的 system 字段。
2. **取消是协作的，且不丢已交付内容**。取消发生在 `prepareCall` / `agent/request` 期间时，system 和 user 消息都尚未提交；流中途取消时，已交付的文本会以 `interrupted: true` 的 `assistant/message` 结算，下一次请求能看到用户已经看到的内容。
3. **工具结果按模型顺序提交**。工具体可以乱序完成，但策略、结果、结果附带的上下文严格按模型给出的调用顺序提交；独占工具形成屏障。

### 6.3 为什么 `agent/pre-step` 是唯一请求前 waterfall

`agent/pre-step` 在请求派生之前运行，是插件改写/拒绝本轮输入的唯一位置。`agent/request` 在 `step/start` 之后、`prepareCall` 之前运行，只能调整控制参数，不能改 provider/model/reasoning effort（否则报错，提示你改用 `agent.model.select()`）。

---

## 7. 会话日志：唯一真源

### 7.1 信封与序号

```ts
interface SessionEvent<K> {
  type: K
  seq: SessionSeq          // 单调、连续
  time: number             // Unix epoch ms
  data: SessionEventMap[K]
  ignorable?: true         // 未知类型是否可安全跳过
  // surface 事件还有 surfaceOp / sourceEventSeqs
}
```

`ignorable` 的默认值是「不可忽略」：读到不认识的必需事件，必须拒绝重建会话，而不是静默丢弃。这是防「静默丢历史」的保守设计。

### 7.2 Surface：派生历史的唯一入口

不是所有事件都进入模型历史。只有 **surface events**（`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`）携带 `surfaceOp`：

- `'append'`：追加到尾部。
- `{ op: 'replace', startSeq, endSeq }`：替换一段 surface 节点（compaction 用它把旧历史折叠成摘要）。

`deriveMessages()` 读取折叠后的 surface，而不是原始事件流。这带来一个重要能力：**压缩可以替换历史，但不删除日志**。原始事件仍在，审计/回放/遥测可以看完整历史，模型只看到折叠结果。

### 7.3 请求元数据

- `request/header`：完整请求信封的快照，包括 `config`（provider/model/采样/maxTokens）、`adapterDefaults`、`tools`。只在首次、变化、显式新序列时追加。
- `request/context`：路由元数据（`contextWindow`、`systemPromptUpdate`），只在变化时追加。
- 两者都是 log-only，不进模型历史。

### 7.4 assistant 结算

- 成功的调用追加 `assistant/message`，并**嵌入精确的紧凑 stream**（带时间戳、不合并 delta 边界）。
- 失败、重试、取消、流错误的 attempt 追加 `assistant/attempt`，保留 stream 但不进入模型历史。
- 空内容的 assistant/message 也不会进入派生历史。
- 进程在结算前硬中断，不会留下持久 attempt stream。

### 7.5 持久化

[`session/session-persistence*`](../deepseek-harness/packages/session)：

- JSONL，每个 session 一个 append-only 文件；当前格式 v4，历史上每个 generation 以 `session.vN.jsonl[.zstd]` 命名，已提交的 generation 绝不重命名/覆盖/删除。
- `session/flush` 是持久性屏障；写入前 checkpoint 由 `session-checkpoint-policy` 负责。
- 恢复时选择最高规范 generation；需要时组合相邻迁移链（v0→v1→v2→v3→v4），返回校验后的当前逻辑事件。
- 崩溃留下的「未闭合 turn」由 handle 消费方修复；`agent-loop` resume 时会追加 `interruptedTurnClosers`，语义修复归 agent 层，不归存储入口。
- fork 通过 `session/end-seed` 标记继承前缀；子会话拥有自己的标记。

---

## 8. Agent loop 深读

源码：[`core/agent-loop/src/agent.ts`](../deepseek-harness/packages/core/agent-loop/src/agent.ts)。建议按以下顺序读：

| 顺序 | 位置 | 看什么 |
|---|---|---|
| 1 | `Phase` + `wakeDriver` | 三态机：idle / running / maintenance；唤醒收敛 |
| 2 | `turn()` | 轮次边界、领取、turn/end 的 finally |
| 3 | `preStep()` | 领取、模型选择、工具解析、提示词组装、pre-step waterfall |
| 4 | `step()` | 请求准备、system 对账、user 准入、流式、结算、工具分发 |
| 5 | `prepareRequest()` | `agent/request`、`prepareCall`、路由能力 |
| 6 | `buildRequest()` | header 记录、developer/message 增删、请求冻结 |

### 8.1 相位与唤醒收敛

```ts
type Phase =
  | { kind: 'idle'; lastTurn }
  | { kind: 'maintenance'; abort; lastTurn; wakeRequested }
  | { kind: 'running'; abort; turn; step; wakeRequested }
```

- `send(..., wakeup)` 在**已中止的活动**上投递唤醒输入时，会改投 `next-turn`：中止中的活动不能接纳新工作，必须等它收敛。
- maintenance 或已中止 driver 收到唤醒时，只设置 `wakeRequested`，在收敛点重放。
- `disposed` 取消从不latch，teardown 不会被模型轮次拖住。
- `kick()` 用一个 `while (await this.turn()) {}` 驱动连续轮次，并在 driver 边界兜住所有失败。

### 8.2 领取与 pre-step

```ts
const claimed = this.inbox.claim(target, position.turn)
const selection = this.model.current()
const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal })
const assembly = await this.loopCtx.systemPrompt.assemble({ ...assembleContextFor(this, signal), modelSelection, toolSet })
const decision = await this.dispatch.waterfall('agent/pre-step', { messages: claimed, ...position, signal, modelSelection }, fallback)
```

- 没有 provider/model 时直接抛错。
- toolSet 是**步骤级准入**：条件工具在这里求值一次，后续重试复用；步骤结束 dispose。
- fallback 会投影 runtime context（工作目录、注入的运行时事实），作为额外的 user 消息。

`PreStepDecision`：

```ts
type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

reject 不打开步骤；首次领取被 reject 或 enter 改写为空时，轮次关闭且不消耗模型请求。

### 8.3 请求准备与提示词准入

`prepareRequest()`：

1. 从上一份 header 派生 proposal，并移除适配器默认字段（让当前路由重新解析）。
2. 运行 `agent/request` waterfall。
3. 校验 provider/model/reasoningEffort 未被改动。
4. `ctx.llm.prepareCall(proposedConfig, signal)` 绑定适配器，拿到 `config`、`contextWindow`、`systemPromptUpdate`、`toolUpdate`、`retryPolicy`、`stream`。
5. 如果 middleware 没有注册适配器，允许 `NO_ADAPTER` 继续（由后续中间件服务）。

`step()` 里的准入顺序很讲究：

```text
prepareRequest → refreshContext → SystemPromptProjection.project(...) → system/message
              → user/message（首次尝试才提交）→ request/header/context → 冻结请求 → stream
```

- **system 对账**：根据路由能力决定是「改写 head」还是「在历史中追加」。`systemPromptUpdate: 'in-history'` 的路由可以保留缓存前缀，把新提示词追加在历史之后。
- **user 只提交一次**：重试复用同一份已渲染 assembly，不重复组装、不重复 pre-step、不重复提交用户消息。
- **请求冻结**：消息身份首次进入请求时深度冻结，同一 agent 内复用该冻结证据；取消信号保持 live。

### 8.4 流式、结算与重试

- `AssistantStreamAttempt` 负责进程内 start/chunk/end 发布；chunk 只在对应的持久帧结算后才发出。
- 成功：`assistant/message` + `agent/assistant-stream` committed end。
- 失败/取消：先结算 `assistant/attempt`（或带 `interrupted: true` 的 partial message），再进入 `agent/request-error` waterfall；监听器返回 `{ kind: 'retry' }` 且不调用 `next()` 时重试。
- `max-tokens` 是**粘性**的：一旦某步触顶，后续正常完成的步骤不能把轮次结果降级。

### 8.5 工具批次与恢复

```ts
const result = await this.loopCtx.tools.execute({ calls, signal, agent: this, log: { turn, step }, maxParallelToolCalls, toolSet })
```

- 完整的原始调用批次交给 `ctx.tools.execute()`；执行器负责调度、并发、取消和日志。
- 工具返回 `additionalContexts` 时，loop 把它们插到 `next-step`，在已记录的 tool result 之后注入。
- `concluded: true` 表示工具主动结束轮次。
- 步骤失败时，`ToolCallRecovery` 为每个未回答的工具调用补一条错误结果：已记录 call 的写 `TOOL_OUTCOME_UNKNOWN`，没有 call 记录的写 `TOOL_NOT_STARTED`；已提交结果保持不变。

### 8.6 取消

- `cancel(cause, { keepInbox })`：清空 inbox（除非 keepInbox），中止活动信号。
- `turn/end` 记录 `{ kind: 'aborted', reason }`；reason 只复制 `turn/end` 需要的字段（避免把 fetch 塞进 AbortSignal.reason 的 stack 写进日志）。
- 取消后未分发的工具调用会得到合成的 `tool/call` + `ABORTED_BEFORE_DISPATCH` 结果，保证回放时工具历史仍然配对。

---

## 9. 工具系统

### 9.1 注册与作用域

[`core/tools/src/index.ts`](../deepseek-harness/packages/core/tools/src/index.ts)：

- `register(definition, { when })`：条件工具每个模型步骤求值一次；`false` 从声明、执行器、PTC 绑定中同时移除。
- `resolve({ agent, modelSelection, signal })`：返回步骤级 `ResolvedToolSet`；重试复用，步骤结束 dispose。
- `restrict(filter)`：对全局工具做 allow/deny 掩码；多个掩码取交集；agent 作用域注册不受影响。
- `schemas(scope, toolSet)`：只物化模型可见投影（name/description/parameters），不泄露 `execute`。

### 9.2 执行流水线

完整图见 [`docs/tool-execution-pipeline.zh.md`](../deepseek-harness/docs/tool-execution-pipeline.zh.md)：

```text
tool/call（先记录）
  → UI pending 卡片
  → tools/pre-execute（waterfall：hook / 权限 / 沙箱）
  → 单调守卫 guard（deny 或 abstain，不能把 deny 翻回 allow）
  → ctx.approval（ask 时一次性询问；不可用则拒绝）
  → tools/execute（around dispatch：超时、重试、指标）
  → 工具 execute() 体
  → projectContent → tools/post-execute（accept/block/replace/附加上下文）
  → finalizeContent（最后一次仅内容变换）
  → tools/result（同步观察冻结结果）
  → tool/result（持久化，单一模型可见结果）
  → UI completed 卡片
```

几个不显然的点：

- **守卫是单调的**：`ToolGuard` 只返回拒绝原因或 `undefined`，没有 allow，所以监听器顺序不能把拒绝翻回允许。
- **规范化**：工具抛错、schema 校验失败、render 失败都会先收敛成 `isError`，再进入 post-execute，避免策略看到半成品。
- **快照**：注册表对候选结果做无损 JSON 快照；失败先规范化，再由快照固定的 `finalizeContent` 强制执行同步、仅内容的不变式。
- **工具结果不是 UI**：`output.render` 产出模型内容；`presentationMeta` 产出可回放的卡片数据。两者不能混。

### 9.3 批次调度

[`core/tools/src/batch.ts`](../deepseek-harness/packages/core/tools/src/batch.ts)：

- 独占调用（`exclusive`）形成屏障，单独运行。
- 并发安全调用（`parallel`）进入有界滚动池，默认并发上限来自 `agent-loop` 的 `maxParallelToolCalls`（默认 10）。
- 后续调用在**启动前**重新分类；运行中注册表变化会影响未启动的调用。
- 工具体可以乱序完成，但结果和上下文按模型顺序提交。
- 中止时停止补充新调用、排空已启动调用、为跳过的调用合成错误结果，保证回放合法。

### 9.4 PTC 模式

PTC（programmatic tool calling）把工具暴露成一个生成 SDK，模型写代码调用 `await tools.read_file(...)`。`run_code` 是保留传输名；子调用携带父 token、记录 `tool/ptc-dispatch`、拒绝表现为有约束力的驳回、省略 `additionalContexts` 以保持调用与结果相邻。它和 Native executor 是同一 seam 的两个提供方。

---

## 10. 提示词系统

源码：[`core/system-prompt/src/index.ts`](../deepseek-harness/packages/core/system-prompt/src/index.ts)。四个输入：

1. **sections**：静态或上下文解析的文本，带 `order`；升序拼接，同序按名称的 code-unit 顺序。`complete: true` 的 section 成为唯一完整提示词，多个生效则组装失败。
2. **variables**：`{{name}}` 引用，每次组装解析；agent 作用域变量遮蔽同名全局。
3. **contexts**：动态运行时事实，最终成为带 source 的 user 角色快照（工作目录、时间、AGENTS.md、技能目录……）。
4. **tools**：工具 schema 是组装的一部分——「模型被告知它能做什么」是一个整体，即使适配器把 schema 放在单独的 wire 字段。

三个阶段：

- `assemble(ctx)`：合并全局层与作用域层，按 order 规范化，跑 `system-prompt/assemble` waterfall，恢复 complete section，应用 runtime-context 抑制器；返回**已解析但未插值**的文本、工具 schema 和变量。
- `renderPrompt(assembly)`：插值 `{{}}`、丢弃空 section、用空行连接。未知引用、已注册但无值的引用、格式错误的 complete group 都**抛错**——一个格式错误的 prompt 比一个响亮失败更糟。
- `refreshContext(assembly, ctx)`：pre-step 和路由准备之后刷新运行时事实，保留已准入的 sections/tools/variables，只重建 context。

### 10.1 提示词准入与 KV Cache

loop 侧的 `SystemPromptProjection` 决定如何把渲染结果写进日志：

- 路由支持 `systemPromptUpdate: 'in-history'`：提示词变化可以**追加**在缓存历史之后，前缀缓存继续复用。
- 路由不支持，或开始一个新的请求序列且有效文本不同：把文本**规范化到第一个 system 节点**，后续非空节点逐条写空替换。
- 空渲染：清空所有活跃 system 节点，不留下旧指令。
- 同一序列里未变化的提示词：不写事件。

这就是为什么 session 里能看到多个 `system/message`，以及为什么「提示词」不是一个请求字段，而是派生历史的一部分。

---

## 11. LLM seam

### 11.1 适配器契约

`ctx.llm` 持有 provider 路由。适配器负责：

- `listModels / resolveModel`：模型目录与精确路由元数据（contextWindow、defaultMaxTokens、reasoning efforts、systemPromptUpdate、toolUpdate）。
- `prepareCall(config, signal)`：校验适配器字段、解析 reasoning effort 与 output token 默认值，返回 `PreparedLlmCall`（`config`、`adapterDefaults`、`context`、`systemPromptUpdate`、`toolUpdate`、`retryPolicy`、`stream`）。
- `stream(request)`：把 `GenerateOptions` 翻译成 provider wire 请求，产出 `StreamChunk`。

`prepareCall` 绑定的是**适配器实例**，不是路由字符串；loop 在解析、header 记录、dispatch 全程保留这个实例，避免中途换实现。

### 11.2 能力协商

能力不是猜测，而是由适配器声明：

| 能力 | 影响 |
|---|---|
| `contextWindow` | 压缩阈值、token meter |
| `systemPromptUpdate: 'in-history'` | 提示词可以追加而非改写 head，保留 KV cache |
| `toolUpdate: 'in-history' \| 'addition-only'` | 工具变更可以走 developer/message 增量，而非重写完整声明 |
| `reasoning` efforts + default | 选择器、默认值物化 |
| `defaultMaxTokens` | 请求未指定时的输出上限 |

### 11.3 流式与结算

`LlmRuntime.stream()` 会把适配器抛出的异常规范化为终止的 `error` / `aborted` finish，而不是把异常直接抛给 loop。loop 的 `AssistantStreamAttempt` 负责把 chunk 组装成 block、记录 usage、在结算前发布 live 帧。

### 11.4 重试

`llm-retry` 和 `agent/request-error` 是两层：

- `llm-retry` 在适配器/传输层按 retryPolicy 重试。
- `agent/request-error` 在步骤层处理终止失败，可以返回 `{ kind: 'retry' }` 修复持久状态后重试（例如压缩后重试）。

`LlmError` 保留结构化失败事实（code、status、providerRetryAfterMs、requestId）；其他错误在 turn/end 里扁平化为 `{ message: errorChain(error), code: 'UNKNOWN' }`。

---

## 12. 能力 seam

一个 **seam** 有三个角色，缺一不可：

- **Service Definition**：声明接口。
- **Service Provider**：实现接口。
- **Consumer**：使用接口（通常是面向模型的工具）。

单个包可以兼任多个角色，但「只加一个 provider」不构成 seam。DSH 的替换能力来自这个结构：

| seam | Definition | 本地 provider | 远程/其他 provider | Consumer |
|---|---|---|---|---|
| 文件系统 | `ctx.fs` | `fs-local` | SSH | `tool-fs`、`tool-fs-search` |
| 子进程 | `ctx.subprocess` | 本地进程树 | SSH | `shell`、`terminal` |
| Shell | `ctx.shell` | `bash-local` | `bash-sandbox`、pwsh | `tool-bash` |
| 沙箱 | `ctx.sandbox` | `sandbox-local` | Seatbelt / Landlock / bwrap | 进程启动前包装 argv |
| 审批 | `ctx.approval` | `user-approval` | 权限预设 | 工具流水线 `ask` |
| LLM | `ctx.llm` | `llm-deepseek` | 其他适配器 | loop |
| 委派 | `ctx.subagents` | `spawn-in-process` | fork / ACP / SDK / Codex / Claude Code | `tool-subagent` |
| 压缩 | `ctx.compaction` | `compaction-basic` | 其他策略 | loop / 命令 |

这条设计的直接收益：把 `ctx.fs`、`ctx.subprocess` 指向远程沙箱，Bash、PTY、LSP 会一起搬过去，不需要为每个工具写远程分支。

### 12.1 安全边界

- **沙箱**在启动进程前包装 argv，不是工具自己判断。
- **审批**是一等 seam：`tools/pre-execute` 返回 `ask` 后，只有审批返回 `allowed-once` 才执行；审批不可用则拒绝（fail closed）。
- **文件工具**的先读后编辑、写意图检查通过 `fs/*` 事件实现，位于 `tool-fs` 之下。
- **模型可见内容**必须可序列化；`Session.append` 运行时校验 JSON，防止把函数/循环引用写进日志。

---

## 13. 扩展面：新行为挂在哪里

| 想要 | 机制 | 入口 |
|---|---|---|
| 加模型提供方 | 注册 `ctx.llm` 适配器 | `llm/*` |
| 加面向模型的能力 | `ctx.tools.register` | `defineTool` |
| 加提示词段落 / 变量 / 上下文 | `ctx.systemPrompt.section/variable/context` | `core/system-prompt` |
| 加 shell 后端 | 注册 `ctx.shell` | `shell/*` |
| 加持久终端 | `ctx.terminals` + `dsh-tool-terminal` | `terminal/*` |
| 加用户命令 | `ctx.commands` | `interaction/commands` |
| 管理后台任务 | `ctx.jobs` | `jobs/*` |
| 从 webhook 启动会话 | `ctx.webhookRuntime` | `experimental` |
| 拦截请求 / 工具 / 轮次 | `agent/*`、`tools/*` 事件 | 见 6、9 |
| 注入模型可见上下文 | `agent.inject()` | `core/agent` |
| 加 UI / 编辑器集成 | 驱动 `ctx.agents`，从 `session/event` 渲染 | `client/*`、`host/*` |
| 加持久客户端状态 | `ctx.sessionProjections` 注册纯 fold | `session/session-projection` |
| 加技能 | `ctx.skills` 注册提供方 | `skill/*` |
| 加外部工具 | MCP 客户端 | `mcp/*` |
| 加会话级目标 | `ctx.goals` + `agent/*` 续跑 | `goal/*` |
| 定时跟进 | `ctx.schedule` | `schedule/*` |
| 委派子 agent | `ctx.subagents` + 工具 | `subagent/*` |
| 按会话组装不同能力 | agent preset（`isolate` realm） | `preset/*` |
| 运行时自我修改 | 扩展插件 / 插件管理 | `extensions/*`、`boot/plugin-manager` |

---

## 14. 长会话：上下文工程

- **token-meter**：按精确路由估算请求 token（含图片定价），供压缩阈值使用。
- **compaction-basic**：当压力超过 `floor(min(W×thresholdRatio, W−O−headroom))` 时，把最老的平衡片段替换成一条摘要，保留最近 `retainRatio` 的尾巴。压缩通过 `surfaceOp: replace` 实现，日志不删除。
- **tool-result-pruner**：先裁剪过大的工具输出，再决定是否摘要。
- **image-offload**：路由报告 `IMAGE_OFFLOAD_REQUIRED` 时，把最老的图片替换成占位文本并重试。
- **spill**：工具结果超限时落盘，模型看到引用路径。
- **session projections**：客户端不重放原始事件，而是接收按领域折叠好的完整 JSON 状态（todo、goal、统计、outline），并带有对应的 seq 切点。

压缩的一个关键约束：**恢复发生在仍然打开的步骤内**。压缩/裁剪推进 surface replacement generation 时，重试才允许；否则保持原始请求错误。每次重试都会重新准备调用，但不会重复组装、pre-step 或用户消息准入。

---

## 15. 传输与产品化

### 15.1 Web

- [`host/webserver`](../deepseek-harness/packages/host/webserver)：`node:http` 服务器，插件注册命名路由、升级路由、索引输入和一个 fallback。
- [`api/gateway`](../deepseek-harness/packages/api/gateway)：Typert RPC 网关，方法级访问控制。
- [`api/session-controller`](../deepseek-harness/packages/api/session-controller)：会话历史尾页、`session/projection` 推送帧。
- [`client/connection`](../deepseek-harness/packages/client/connection)：浏览器侧连接、重连、流恢复。
- [`client/ui-*`](../deepseek-harness/packages/client)：每个 UI 能力是一个客户端插件，通过 slot 组合。

传输层只搬运原始事件和投影值；渲染归 slot 体系，领域不写 UI。

### 15.2 SDK / ACP / Headless

- [`sdk/protocol`](../deepseek-harness/packages/sdk/protocol)：JSON-RPC 2.0，newline-delimited，stdio。
- [`sdk/server`](../deepseek-harness/packages/sdk/server)：一个 `sessionId` 一个会话，排队用户提示，回传所有 session event 与 agent status。
- [`sdk/client`](../deepseek-harness/packages/sdk/client)：TypeScript 客户端，管理子进程与流。
- [`acp`](../deepseek-harness/packages/acp)：仅自动化的 ACP 服务器。
- [`bundle/headless`](../deepseek-harness/packages/bundle/headless)：不带 HTTP / 浏览器的 one-shot runner。

SDK 和 Python SDK 都投影同一套 loop 语义；改 `SessionEventMap` 时两个 SDK 的期望输出要在同一个 PR 更新。

---

## 16. 横切关注点

- **错误处理**：结构化失败（`LlmFailure`、`ToolFailure`、`HarnessError`）优先；turn/end 记录结构化原因；插件失败结束轮次，而不是让 loop 崩溃。
- **取消**：协作式；每个长操作观察 `AbortSignal`；取消原因持久化；部分输出保留。
- **持久化兼容**：`SESSION_FORMAT_VERSION` 只在「现有判别式无法防止不安全解释」时升级；已提交 generation 不可变；相邻迁移链可组合。
- **安全**：沙箱在进程启动前生效；审批 fail closed；文件写意图有独立事件；跨进程/wire 边界做输入校验，同进程类型边界信任 TypeScript。
- **测试**：单元测试 + keyless recorded-session snapshot + real-API e2e；快照在 macOS/Linux 回放；每个包 README 记录 Model Experience（模型看到什么、token 影响、KV cache 影响）。
- **可观测**：OTel 遥测、session telemetry、结构化日志；遥测不阻塞主流程。
- **性能**：长会话 bench、流式重连 bench、session 打开 bench；冻结证据复用；请求构造避免重复分配。

---

## 17. 最值得借鉴的设计模式

1. **Model-visible ⟺ logged**：把「模型看到了什么」变成可审计、可回放、可迁移的一等公民。
2. **Append-only + fold**：日志只追加，状态靠 fold；压缩用 surface replace 而不是删除。
3. **Surface 抽象**：模型历史是日志的一个投影，不是日志本身。
4. **Waterfall 中间件**：用环绕事件做策略，而不是把策略写进 loop。
5. **能力 seam 三角色**：Definition / Provider / Consumer 一起设计。
6. **Effect-scoped registration**：注册即副作用，卸载即撤销，HMR 免费。
7. **Branded ID**：`SessionId`、`ToolCallId` 等在类型层不可互换。
8. **Map→derived union**：用声明合并扩展闭集，插件不改核心包。
9. **Claim 语义**：inbox 的「领取」是纯删除 + claimed 通知，不是消费即销毁。
10. **Capability negotiation**：路由声明 `systemPromptUpdate` / `toolUpdate`，loop 据此选择缓存友好的写入策略。
11. **Settle before notify**：先持久结算，再发 live end frame；UI 永远能看到已提交事实。
12. **Fail loud at load**：配置错误在最早可解析点失败，不静默跳过。
13. **Canonical value vs rendered content**：工具返回结构化值，渲染是声明；程序化调用和模型内容解耦。
14. **Bounded concurrency with barriers**：并发安全工具滚动池，独占工具屏障，结果模型序。
15. **Recovery results**：失败步骤为未回答的工具调用补结构化错误，保证下一次请求的工具历史仍然配对。
16. **Source plane vs artifact plane**：静态检查走 `src`，运行时/构建消费 `lib`，两者不混。

---

## 18. 18 课阅读路线

| 课 | 主题 | 先读 |
|---|---|---|
| s01 | agent loop：turn/step、流式、工具循环、取消 | `agent-loop/src/agent.ts`、`docs/agent-lifecycle.zh.md` |
| s02 | session log：事件、surface、派生、重放 | `core/session/src/{types,index,surface}.ts` |
| s03 | streaming：chunk、组装、结算、attempt | `llm/llm/src/{types,assembler,assistant-stream}.ts` |
| s04 | tools：registry、schema DSL、scoped/conditional | `core/tools/src/{contracts,schema}.ts` |
| s05 | tool pipeline：策略、并发、超时、恢复 | `core/tools/src/{pipeline,batch,executor}.ts` |
| s06 | system prompt：组装、准入、KV cache | `core/system-prompt/src/index.ts` |
| s07 | inbox/steering：next-turn/next-step、claim、取消 | `agent-loop/src/{inbox,agent}.ts` |
| s08 | LLM seam：adapter、prepareCall、能力协商、重试 | `llm/llm/src/{call-config,assembler,retry-policy}.ts` |
| s09 | persistence：JSONL、generation、resume、fork、修复 | `session/session-persistence*`、`core/session/src/{repair,fork}.ts` |
| s10 | compaction：token 预算、裁剪、摘要、surface replace | `compaction/*`、`llm/token-meter` |
| s11 | plugin kernel：Context/Service/Fiber/effect/events/scope | `vendor/cordis/src/*` |
| s12 | composition/boot：profile、bundle、patch、config、CLI | `boot/app-boot`、`bundle/base`、`apps/cli` |
| s13 | capability seams：fs/shell/subprocess/sandbox/approval | `fs/*`、`shell/*`、`sandbox/*`、`interaction/*` |
| s14 | subagents/presets：委派、子会话、深度、隔离 | `subagent/*`、`preset/*` |
| s15 | MCP/skills/commands：外部能力接入 | `mcp/*`、`skill/*`、`interaction/commands` |
| s16 | web：projection、HTTP/SSE、重连、UI 插件 | `session/session-projection`、`host/webserver`、`api/session-controller` |
| s17 | SDK/headless/ACP：JSON-RPC、进程外协议 | `sdk/*`、`bundle/headless`、`acp` |
| s18 | observability/eval：遥测、快照回放、故障注入、性能 | `telemetry/*`、`docs/testing.zh.md`、`benchmarks/*` |

课程工程与每课任务见 [`docs/01-course-design.zh.md`](01-course-design.zh.md)。

---

## 19. 关键文件索引

| 文件 | 一句话 |
|---|---|
| `apps/cli/src/bin.ts` | CLI 入口，profile 选择 |
| `packages/boot/app-boot/src/index.ts` | profile/patch/loader 启动 |
| `packages/bundle/base/cordis.patch.yml` | base 组合的完整条目表 |
| `packages/core/session/src/types.ts` | `SessionEventMap`、surface、header |
| `packages/core/session/src/index.ts` | `Session`、`append`、`deriveMessages`、`requestHeader` |
| `packages/core/session/src/surface.ts` | surface fold 与 replace 语义 |
| `packages/core/agent/src/types.ts` | `Agent`、`AgentHandle`、inbox、决策类型 |
| `packages/core/agent/src/index.ts` | `AgentRegistry`、initiator、factory |
| `packages/core/agent-loop/src/agent.ts` | 默认 driver，turn/step 状态机 |
| `packages/core/agent-loop/src/index.ts` | `AgentLoop` 服务、配置、创建/恢复 |
| `packages/core/agent-loop/src/inbox.ts` | 持久 inbox 投影与领取 |
| `packages/core/tools/src/contracts.ts` | `ToolDefinition`、pipeline 类型 |
| `packages/core/tools/src/pipeline.ts` | 单次调用流水线 |
| `packages/core/tools/src/batch.ts` | 批次调度、并发与屏障 |
| `packages/core/system-prompt/src/index.ts` | 提示词组装与渲染 |
| `packages/llm/llm/src/types.ts` | 消息/流/请求词汇 |
| `packages/llm/llm/src/assembler.ts` | 流组装 |
| `packages/llm/llm/src/call-config.ts` | `prepareCall` 与能力 |
| `packages/llm/llm-deepseek/src/index.ts` | DeepSeek 适配器 |
| `packages/session/session-persistence/src/index.ts` | 持久化 seam |
| `packages/session/session-persistence-jsonl/src/index.ts` | JSONL 后端 |
| `packages/session/session-projection/src/index.ts` | 投影注册表 |
| `packages/compaction/compaction-basic/src/index.ts` | 基础压缩 |
| `packages/subagent/subagent/src/manager.ts` | 委派生命周期 |
| `vendor/cordis/src/context.ts` | Cordis Context |
| `vendor/cordis/src/fiber.ts` | Fiber 生命周期 |
| `vendor/cordis/src/events.ts` | 五种事件分发 |
| `docs/architecture.zh.md` | 官方架构总览 |
| `docs/subsystems/*.zh.md` | 各子系统类型与 API 参考 |
| `docs/module-graph.zh.md` | 完整依赖图 |

---

## 20. 三个建议的阅读习惯

1. **先看 README 的 Model Experience 段**。每个包都记录「模型看到什么、token 影响、KV cache 影响」，这比看实现更快理解契约。
2. **用 `--dump-config` 反推运行时**。读 composition 时，直接跑 `dsh --profile headless --dump-config`，对照 YAML 看插件如何叠加。
3. **沿一次 turn 打日志**。选一个最简单的 headless 任务，在 `agent-loop/src/agent.ts` 的 `turn()`、`step()`、`buildRequest()` 打断点/日志，观察事件顺序；比读十篇文档有效。
