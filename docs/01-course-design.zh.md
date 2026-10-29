# 课程设计：18 课重写一个 Mini DeepSeek Harness

> 目标读者：已经能写 TypeScript、用过至少一个 agent 产品（Claude Code / Cursor / DSH），想搞清楚「一个生产级 coding agent 到底怎么运转」的工程师。
>
> 课程不是 API 教程，也不教 prompt 技巧。它沿着 DSH 的真实架构，**用零依赖 TypeScript 从空目录重建一个可运行的 mini harness**，每一课只增加一个架构能力，并对照真实源码解释「为什么生产实现要这么做」。
>
> 状态：s01-s18 已全部完成并验证。

---

## 1. 设计原则

### 1.1 以真实源码为纲，而不是以功能清单为纲

很多「build your own agent」课程最后变成「调 API + 拼 prompt」。本课程每课都绑定 DSH 的真实模块与不变量：

- 讲 loop，就讲 `turn/step` 状态机、inbox claim、pre-step waterfall、取消收敛。
- 讲日志，就讲 append-only、surface replace、`deriveMessages`、`request/header`。
- 讲工具，就讲 capability seam、pipeline、并发屏障、恢复结果。

每课 README 都有「真实源码对照」小节，标出该读的文件与函数，以及 mini 实现刻意简化了什么。

### 1.2 零运行时依赖，直接使用真实模型

- Node ≥ 24（原生 TypeScript type stripping），无需 `tsc`、`tsx`、`vitest`。
- 测试用内置 `node:test`；离线单元测试不访问网络，真实模型测试在缺少 key 时自动跳过。
- 模型一律使用**真实 DeepSeek**：每课提供 `env.example`，复制成 `.env` 并填入 `DEEPSEEK_API_KEY`。
- 传输用 `node:http` / `node:readline`，不引框架。

这样课程既能在没有 key 时跑纯逻辑测试，也能在有 key 时观察真实模型的流式输出、工具调用和 token 账单。

### 1.3 每课一个自包含文件夹

```text
course/lessons/s01-agent-loop/
  README.md        # 讲义：问题、源码、实现、验收、练习
  env.example      # 复制成 .env
  package.json
  tsconfig.json
  src/             # 本课完整代码
  tests/           # 离线测试 + 真实模型测试
```

后一课复制前一课并增量修改，因此任意一课都能单独打开、运行、阅读。重复的是少量核心代码，换来的是「每课都是一个可运行快照」；讲义会明确列出本课新增/修改的文件。

### 1.4 难度曲线：前 5 课打内核，中 5 课打上下文，后 8 课打工程化

- 前 5 课：**不看 Cordis**，用普通类把 loop、日志、流、工具、流水线写出来。先理解本质。
- 第 11 课：**把前 10 课重构成插件**，引入 Context / Service / Fiber / effect。这时你才会真正理解「为什么 DSH 全是插件」。
- 后 7 课：组合、能力 seam、委派、外部能力、传输、协议、可观测。每一课都对应 DSH 的一个真实产品面。

这个顺序是刻意的：如果第一课就讲 Cordis，agent loop 会被框架细节淹没；如果一直不讲 Cordis，又无法理解 DSH 的扩展模型。先本质、再工程化，是更有效的路径。

---

## 2. 课程地图

| 课 | 主题 | 对应真实源码 | 产出 | 难度 |
|---|---|---|---|---|
| s01 | agent loop | `core/agent-loop/src/agent.ts` | turn/step 状态机、流式、工具循环、取消 | ★★☆ |
| s02 | session log | `core/session/src/*` | 追加日志、surface、`deriveMessages`、重放 | ★★★ |
| s03 | streaming | `llm/llm/src/{types,assembler}.ts` | chunk 协议、块组装、结算、attempt、usage | ★★★ |
| s04 | tools | `core/tools/src/{contracts,schema}.ts` | `defineTool` DSL、校验、输出 schema、作用域 | ★★★ |
| s05 | tool pipeline | `core/tools/src/{pipeline,batch}.ts` | pre/guard/execute/post/result、并发、恢复 | ★★★★ |
| s06 | system prompt | `core/system-prompt/src/index.ts` | sections/variables/contexts、waterfall、准入 | ★★★★ |
| s07 | inbox/steering | `agent-loop/src/{inbox,agent}.ts` | next-turn/next-step、claim、注入、取消 | ★★★ |
| s08 | LLM seam | `llm/llm/src/*`、`llm-deepseek` | adapter、prepareCall、能力协商、重试、真 API | ★★★★ |
| s09 | persistence | `session/session-persistence*` | JSONL、flush、generation、resume、fork、修复 | ★★★★ |
| s10 | compaction | `compaction/*`、`token-meter` | token 预算、裁剪、摘要、surface replace | ★★★★ |
| s11 | plugin kernel | `vendor/cordis/src/*` | Context/Service/Fiber/effect/events/scope | ★★★★★ |
| s12 | composition/boot | `boot/app-boot`、`bundle/base` | profile/bundle/patch、config、CLI、reload | ★★★★ |
| s13 | capability seams | `fs/*`、`shell/*`、`sandbox/*` | read/write/bash、沙箱、审批、工作区边界 | ★★★★★ |
| s14 | subagents/presets | `subagent/*`、`preset/*` | 委派、子会话、深度、隔离、可继续 | ★★★★★ |
| s15 | MCP/skills/commands | `mcp/*`、`skill/*`、`commands` | JSON-RPC 客户端、技能目录、斜杠命令 | ★★★★ |
| s16 | web | `session-projection`、`host/webserver` | 投影、SSE、重连、事件回放 | ★★★★ |
| s17 | SDK/headless | `sdk/*`、`bundle/headless` | JSON-RPC、stdio、headless runner | ★★★★ |
| s18 | observability/eval | `telemetry/*`、`docs/testing` | 遥测、快照回放、故障注入、性能 | ★★★★ |

> 编号内共 18 课，留 2 课余量给可选的「skills & commands 深入」和「PTC / workflow」专题。

---

## 3. 每课详情

每课的讲义统一包含：**问题 → 真实实现 → mini 实现 → 运行/验收 → 练习 → 思考题**。下面是设计要点。

### s01 · agent loop：把「模型调用工具再回答」写成状态机

**问题**：为什么 agent loop 不是 `while (true) { call model; if (tool) execute; }` 这么简单？

**真实实现**：`turn()` 打开轮次，`preStep()` 领取输入并组装，`step()` 发请求、流式、结算、分发工具；`turn/end` 在 `finally` 里保证一定关闭；取消和唤醒有收敛语义。

**mini 产出**：

- `Session`：最小事件日志 + `deriveMessages()`。
- `DeepSeekModel`：真实 DeepSeek HTTP + SSE 适配器（text / reasoning / tool-call / usage / error）。
- `ToolRegistry`：最小工具注册与执行。
- `Agent`：turn/step 循环、maxSteps、工具结果写回、取消保留 partial。
- CLI demo + 16 个离线测试 + 2 个真实模型测试。

**验收**：单轮回答；工具往返；未知工具；工具抛错；maxSteps；流中取消；一次多工具；日志重放一致；真实 API 下工具调用正确配对。

**思考题**：如果模型返回空内容怎么办？如果工具调用后模型不再调用工具，轮次何时结束？取消时为什么还要写 partial message？

---

### s02 · session log：把「消息数组」换成「事件日志」

**问题**：为什么 DSH 不存 `messages: Message[]`，而要存事件？

**真实实现**：`SessionEventMap`、surface fold、`surfaceOp: replace`、`sourceEventSeqs`、`request/header`、`request/context`、`assistant/attempt`、`session/end-seed`。

**mini 产出**：

- 事件信封：`seq/time/type/data/ignorable`。
- `append` 校验、surface append/replace。
- `deriveMessages()` 完整规则（system/user/developer/assistant/tool，忽略 attempt 和边界）。
- `request/header` 快照与 `request/context`。
- JSON 导入/导出 + replay。

**验收**：从日志重建消息；surface replace 后旧消息从派生历史消失但原始事件仍在；header 变化只写一次；重放与实时一致。

**思考题**：为什么 `assistant/attempt` 不进历史？`request/header` 为什么不进历史？surface replace 和删除事件的区别是什么？

---

### s03 · streaming：把字节流变成可回放的块

**问题**：流式响应中途失败，用户已经看到一半文本，这段文本应该进历史吗？

**真实实现**：`StreamChunk`（block-start/text-delta/tool-call-delta/block-end/usage/finish）、`assembleStream`、`AssistantStreamAttempt`、`assistant/message` 嵌入 stream、`assistant/attempt`、`interrupted: true`。

**mini 产出**：

- chunk 类型与解析器。
- 按 block index 组装的 assembler（交错 delta、tool-call 参数 JSON 拼接）。
- 成功/失败/取消三种结算。
- usage 归一化（input/output/cache 不相交）。
- live 事件 vs 持久事件的区分。

**验收**：多块交错；tool-call 参数分片；流错误；取消保留前缀；usage 记录；attempt 不污染历史。

**思考题**：为什么 chunk 不能直接写日志？为什么成功消息要嵌入完整 stream？

---

### s04 · tools：把能力声明成 schema，而不是函数

**问题**：模型只能看到 JSON Schema，工具的「类型安全」从哪里来？

**真实实现**：`ToolDefinition`、`defineTool`、`ParameterSchemaSpec`/`ValueSchemaSpec`、`ToolOutputDefinition`、`ResolvedToolSet`、`when` 条件、`restrict`。

**mini 产出**：

- 参数 DSL（string/number/integer/boolean/null/array/object/oneOf）。
- `InferArgs` 类型推导 + 运行时校验。
- `output.schema` + `render`。
- 注册/注销（effect 风格）、作用域注册、条件工具。
- 工具结果注入（`additionalContexts`）的雏形。

**验收**：必填/可选/嵌套/联合校验；未知参数；非法输出；条件工具在步骤级只求值一次；注销后不可见。

**思考题**：为什么工具返回「规范值」而不是直接返回文本？为什么 schema 是提示词组装的一部分？

---

### s05 · tool pipeline：策略、并发与恢复

**问题**：工具执行不是「调用函数」，而是一条可插拔的流水线；并发和策略如何不打架？

**真实实现**：`tools/pre-execute` → 单调 guard → approval → `tools/execute` → `tools/post-execute` → 规范化 → `tools/result`；`batch.ts` 的独占屏障与有界滚动池；`ToolCallRecovery`。

**mini 产出**：

- 五个阶段的中间件（allow/deny/ask/cancel、replace/block、observe）。
- 单调 guard（只能拒绝，不能翻案）。
- 审批服务（一次性 allow，否则 deny）。
- 并发调度：exclusive barrier + parallel rolling pool + 模型序提交。
- 超时包装、取消合成结果、失败步骤恢复结果。

**验收**：deny 不执行；ask 未批准不执行；并发安全工具重叠执行；独占工具形成屏障；结果顺序 = 模型顺序；超时返回结构化错误；取消后回放合法。

**思考题**：为什么守卫没有 allow？为什么结果按模型顺序而不是完成顺序？如果工具忽略 signal 会怎样？

---

### s06 · system prompt：把「提示词」当成组装结果

**问题**：系统提示词为什么不是一个字符串常量？

**真实实现**：sections + order、variables、contexts、tool schemas、`assemble`/`renderPrompt`/`refreshContext`、`system-prompt/assemble` waterfall、`complete` section、toolOrder、prompt admission（in-history vs head reconciliation）。

**mini 产出**：

- section/variable/context 注册表。
- 变量插值与空段丢弃；未知变量 fail loud。
- 工具 schema 排序与 `<unlisted-tools>`。
- runtime context 作为 user 快照。
- 准入策略：支持 in-history 的路由追加，否则改写 head；空提示词清除。

**验收**：顺序稳定；作用域遮蔽；未知变量报错；工具变更触发新 header；in-history 追加不破坏前缀；空提示词清空。

**思考题**：为什么工具 schema 和提示词一起组装？为什么不把 `cwd` 做成内置变量？KV cache 与「改写 head」的关系是什么？

---

### s07 · inbox/steering：人在环中的输入如何进入一个正在运行的轮次

**问题**：用户在 agent 运行中又发了一条消息，应该中断、排队，还是注入下一步？

**真实实现**：`next-turn` / `next-step` 两条队列、`followup/steer/inject`、claim（纯删除）、`agent/inbox/*` 事件、cancel 的 `keepInbox`、唤醒收敛。

**mini 产出**：

- 两条队列 + 消息 id。
- `send` 路由、claim、`whenIdle`。
- 运行中 steering 在下一步被领取；inject 不唤醒。
- 取消清空 vs 保留；取消后唤醒改投 next-turn。
- inbox 持久化/重放。

**验收**：followup 每消息一轮；steer 在下步合并；inject 不唤醒；取消 keepInbox；中止中的 append 不丢；重放恢复 pending。

**思考题**：为什么 claim 是纯删除而不是消费？为什么取消后的唤醒要改投 next-turn？

---

### s08 · LLM seam：适配器、能力协商与重试

**问题**：换一个模型供应商，为什么不用改 loop？

**真实实现**：`ctx.llm`、adapter、`prepareCall`、`PreparedLlmCall`、`systemPromptUpdate`/`toolUpdate`、`defaultMaxTokens`、`reasoning` efforts、`retryPolicy`、`LlmError`/`LlmFailure`。

**mini 产出**：

- `Provider` 接口：`resolveModel`、`prepareCall`、`stream`。
- 两个真实 provider 变体（DeepSeek chat / reasoner，或 DeepSeek + 一个 OpenAI-compatible 端点）。
- 能力协商：contextWindow、in-history、toolUpdate、reasoning。
- 重试策略与终止错误分类。
- 适配器默认值物化与清除。

**验收**：同一 loop 切 provider；能力不同导致不同的提示词写入策略；429/5xx 重试；NO_ADAPTER；真实 API 冒烟（有 key 时）。

**思考题**：为什么 `prepareCall` 要绑定适配器实例？为什么提示词更新能力会影响日志写入？

---

### s09 · persistence：让会话活过进程重启

**问题**：崩溃后恢复，如何知道哪些工具调用「结果未知」？

**真实实现**：`SessionPersistence` seam、JSONL append、flush barrier、generation、`interrupted` turn closer、`ToolCallRecovery`、fork seed、`session/end-seed`。

**mini 产出**：

- 每会话一个 JSONL 文件，append + flush。
- header（id/cwd/version）。
- 加载/校验/重放；坏尾部截断。
- 未闭合 turn 修复；未回答 tool call 恢复。
- fork：复制前缀 + 标记 + 关闭打开 turn。

**验收**：写-读一致；进程 kill 后恢复到最后 flush；未闭合 turn 被修复；fork 子会话可继续；generation 不覆盖。

**思考题**：为什么 flush 是显式屏障？为什么语义修复归 agent 层而不是存储层？

---

### s10 · compaction：在有限上下文里继续工作

**问题**：历史超过 context window 时，应该删、截断，还是摘要？

**真实实现**：token meter、压力阈值、retain ratio、prune tool results、summarize、`surfaceOp: replace`、overflow retry、image offload。

**mini 产出**：

- token 估算（字符/4 + 工具 schema + 图片占位）。
- 压力检测与触发。
- 工具结果裁剪。
- 摘要请求（使用真实模型；压缩本身也是一次模型调用）。
- surface replace + 重试。

**验收**：超阈值触发；保留最近尾巴；摘要替换旧段；原始事件仍在；溢出错误后重试成功；无可压缩单元时不写日志。

**思考题**：为什么摘要也是模型请求？为什么压缩后不删除日志？

---

### s11 · plugin kernel：把前 10 课重构成插件

**问题**：为什么 DSH 连 agent loop 都是插件？

**真实实现**：`vendor/cordis/src/{context,registry,fiber,events,service}.ts`；Service/inject/effect；五种事件模式；scope。

**mini 产出**：

- `Context`：服务容器 + 插件挂载。
- `Service` + `inject` 依赖等待。
- `Fiber` + `effect` 逆序释放。
- `emit/waterfall/parallel/serial/bail`。
- `scope`：agent 级注册遮蔽。
- 把 s01-s10 的 loop/session/tools/llm 重构成服务。

**验收**：依赖未就绪不启动；卸载撤销注册；waterfall 短路；HMR 模拟（卸载再挂载）；作用域隔离。

**思考题**：为什么注册要绑定 Fiber？没有特权内核的代价是什么？

---

### s12 · composition/boot：一棵可替换的插件树

**问题**：`dsh --profile web` 到底做了什么？

**真实实现**：profile/bundle/patch 三层、`--dump-config`、配置 schema、required entries、启动失败矩阵、HMR。

**mini 产出**：

- 配置格式（JSON 作为 YAML 的等价物，或实现 YAML 子集）。
- 按 id 的 patch：replace/insert/disable。
- profile → bundle → 用户 patch 的叠加。
- CLI：`mini run`、`mini dump-config`、`mini --patch`。
- 配置校验与 fail loud。

**验收**：默认组合可跑；patch 覆盖；未知 id 警告；缺失必需条目启动失败；dump 出最终树。

**思考题**：为什么 patch 替换整个 config 而不是 merge？为什么 profile 要分层？

---

### s13 · capability seams：让 agent 真正能读写和执行

**问题**：给 agent 一个 `bash` 工具，和给它一个可沙箱、可审批、可远程的执行世界，差在哪里？

**真实实现**：`ctx.fs`/`ctx.shell`/`ctx.subprocess`/`ctx.sandbox`/`ctx.approval`；`tool-fs`、`tool-bash`；`fs/*` 事件；permission presets。

**mini 产出**：

- FS provider：read/write/edit/glob/grep。
- Shell provider：spawn、cwd、env、超时、输出上限。
- 沙箱包装：macOS `sandbox-exec` 或路径白名单。
- 审批：写/执行前 ask；工作区外拒绝。
- 工作目录与路径逃逸防护。

**验收**：读文件；写文件；路径逃逸拒绝；bash 输出/退出码；超时；审批拒绝；沙箱内允许/拒绝。

**思考题**：为什么沙箱要在进程启动前生效？为什么审批不可用要 fail closed？

---

### s14 · subagents/presets：委派与隔离

**问题**：子 agent 是「再开一个 loop」这么简单吗？

**真实实现**：`ctx.subagents`、spawn/fork、`maxDepth`、`maxActiveSubagents`、子会话、preset revision、`sendMessage`、continuable child。

**mini 产出**：

- `subagent` 工具：prompt、cwd、模型。
- spawn：新会话；fork：复制父历史。
- 深度预算、并发上限。
- 子会话完成通知（parent delivery）。
- 可继续子 agent（sendMessage）。
- preset：不同的工具/提示词组合，`isolate` 作用域。

**验收**：子 agent 独立运行；深度超限拒绝；并发上限；fork 继承历史；父收到通知；子 agent 可继续；preset 隔离。

**思考题**：为什么子 agent 的 session 要持久化？fork 和 spawn 的语义差异？

---

### s15 · MCP/skills/commands：不修改 loop 的扩展

**问题**：如何接入外部工具、可复用指令和用户命令，而不碰 agent loop？

**真实实现**：`mcp-client`（stdio JSON-RPC、`tools/list`、`tools/call`、命名 `mcp__server__tool`）、`skill`（目录、SKILL.md、按需加载）、`commands`（斜杠命令，不进模型请求）。

**mini 产出**：

- MCP stdio 客户端：initialize、tools/list、tools/call、错误映射。
- 把 MCP 工具注册进 `ToolRegistry`（前缀命名、schema 转换）。
- 技能目录：扫描、frontmatter、catalog 注入、按需 load。
- 命令：`/compact`、`/help`，直接分派，不产生模型轮次。

**验收**：连接 mock MCP server；列出/调用工具；错误；断线重连；技能目录注入；命令不触发模型。

**思考题**：MCP 工具的错误如何映射成模型可见结果？为什么命令不该走模型？

---

### s16 · web：把会话状态送到浏览器

**问题**：浏览器如何在不重放全部事件的情况下显示实时状态，并在断线后恢复？

**真实实现**：`session/projection`（纯 fold、快照 + 变更）、`host/webserver`、`api/session-controller`（历史尾页 + 推送帧）、`client/connection`（重连）、`client/ui-*`。

**mini 产出**：

- 会话投影：消息列表、turn/step 状态、token 统计、todo。
- HTTP server：`/api/session`、`/api/events`（SSE）。
- 快照 + `sinceSeq` 增量。
- 断线重连与去重。
- 极简 HTML 客户端（无框架）。

**验收**：首屏快照；增量事件；断线后从 seq 恢复；投影与日志一致；多客户端。

**思考题**：为什么客户端不应该自己 fold 事件？快照和增量的切点如何保证一致？

---

### s17 · SDK/headless：把 harness 变成进程外服务

**问题**：如何让 Python / 其他语言驱动这个 harness？

**真实实现**：`sdk/protocol`（JSON-RPC 2.0、newline-delimited）、`sdk/server`、`sdk/client`、`bundle/headless`、ACP。

**mini 产出**：

- JSON-RPC 帧编解码。
- 方法：`session/create`、`prompt`、`session/events` 订阅、`shutdown`。
- headless runner：一次性任务，stdout 只输出协议帧。
- TS 客户端：子进程、请求/通知、背压。
- 错误码与取消。

**验收**：握手；创建会话；流式事件；取消；关闭；stdout 无污染；客户端可读最终回答。

**思考题**：为什么 stdout 只能放协议帧？通知和请求如何区分？

---

### s18 · observability/eval：让 agent 可诊断、可回归

**问题**：改了 prompt 或 loop，怎么知道没有退化？

**真实实现**：OTel 遥测、session telemetry、结构化错误、keyless recorded-session snapshot、real-API e2e、benchmarks、故障注入。

**mini 产出**：

- 结构化日志 + span（简化 OTel）。
- 录制/回放：保存模型请求-响应，离线重放。
- 快照测试：事件序列 + 最终消息。
- 故障注入：429、超时、断流、工具抛错。
- 性能：首 token、工具并发、长会话。
- 安全回归：路径逃逸、审批绕过、日志注入。

**验收**：回放确定性；快照 diff；故障场景全部可恢复；性能基线；安全用例拒绝。

**思考题**：为什么快照要记录事件而不是最终文本？哪些不确定性必须被注入而不是 mock？

---

## 4. 课程工程结构

```text
course/
  .gitignore
  README.md
  lessons/
    s01-agent-loop/
      README.md
      env.example
      package.json
      tsconfig.json
      src/
        types.ts
        session.ts
        deepseek.ts
        env.ts
        tools.ts
        agent.ts
        demo.ts
        index.ts
      tests/
        s01.test.ts        # 离线单元测试
        live.test.ts       # 真实模型端到端
    s02-session-log/       # 复制 s01 后增量修改
      ...
    s18-observability/
```

每课讲义的结构：

```text
# sNN · 标题

## 这一课要回答的问题
## 先读真实源码（文件 + 函数 + 带着问题读）
## 核心概念（带图）
## 本课实现（新增/修改文件，关键代码片段）
## 运行与验收（命令 + 预期输出 + 测试）
## 刻意简化（与真实 DSH 的差异）
## 练习（2-4 个，含提示）
## 思考题（附源码答案位置）
## 下一课预告
```

---

## 5. 与真实 DSH 的差异（刻意简化）

| 真实 DSH | 课程实现 | 为什么 |
|---|---|---|
| Cordis 完整内核（Fiber/registry/loader/HMR） | s11 实现子集 | 先理解本质，再工程化 |
| 13+ 种 session event、格式迁移 v0→v4 | s02/s09 保留核心事件，单版本 | 迁移是产品历史，不是架构本质 |
| 多种 LLM provider + OAuth + 账户 | 真实 DeepSeek（s08 再加一个兼容 provider） | 聚焦 seam，不聚焦厂商 |
| Native + PTC 两种 executor | 先 Native，PTC 作为 s05 选修 | PTC 需要代码沙箱，成本高 |
| 完整 Web/Electron 客户端 | s16 极简 HTML + SSE | 聚焦传输与投影 |
| JSONL + zstd + checksum + generation | JSONL 明文 + flush | 压缩/校验是工程细节 |
| 全量 OTel | s18 结构化 span | 依赖为零 |
| 100% 覆盖率、快照门禁 | 每课核心路径测试 | 学习项目不追求工业级覆盖率 |

---

## 6. 已确定的约定

- **结构**：每课一个自包含文件夹 `course/lessons/sNN-<slug>/`，内含 `README.md`、`src/`、`tests/`、`env.example`。
- **演进**：后一课复制前一课并增量修改；任意一课可独立运行。
- **技术栈**：Node 24 原生 TypeScript、零运行时依赖、`node:test`。
- **模型**：真实 DeepSeek；`.env` 从 `env.example` 复制，`live.test.ts` 在缺少 key 时自动跳过。
- **讲义**：中文，代码/标识符保留英文。

剩余待定：18 课是否一次做完，还是先交付 s01-s10 再根据反馈继续后半段。

---

## 7. 学习节奏建议

- 每课 2-4 小时：1 小时读讲义 + 真实源码，1-2 小时写本课代码，1 小时跑测试/练习。
- 每 3 课做一次回顾：不看讲义，从空目录重写该阶段的核心（例如 s01-s03 的 loop + log + stream）。
- 每课结束回答讲义里的思考题，并把答案写进 `notes/sNN.md`；这些笔记就是你的架构理解快照。
- 最后做 capstone：用第 18 课的 harness 跑一个真实任务（读写文件、跑测试、修复一个 bug），观察事件日志，和 DSH 的真实 headless 输出对照。
