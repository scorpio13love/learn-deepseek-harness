# DSH 运行时知识图谱

> 六个知识域，不是课程目录

## 总图谱

### 控制平面

- turn / step / request 三个边界
- 取消是协作式，不是回滚
- 模型请求必须从日志派生
- 失败事实与恢复策略分开

### 事实与上下文

- Session Log 是唯一事实源
- surface 是当前模型视图
- replace 遮蔽旧消息不删事件
- compaction 是工作集管理

### 工具与权限

- 模型面 / 执行面 / 投影面
- guard 单调收紧
- 审批是协议，不是弹窗
- 并发默认独占

### 组合与生命周期

- Context 按服务键发现
- inject 推导启动顺序
- effect 必须可逆
- Bundle / Profile / Patch

### 执行边界

- fs / shell / sandbox seam
- MCP 外部工具
- browser / CUA provider
- subagent 预算与隔离

### 质量与宿主

- projection + SSE
- record / replay
- snapshot / eval
- Web / SDK / client UI

## 每课知识点

### s01 · 最小 agent loop

- **是什么 / 格式**
  - turn：一次任务唤醒，从 turn/start 到 turn/end。
  - step：turn 里的一次模型请求，可能没有工具。
  - attempt：一次流式请求的结算，成功/失败/取消都要收口。
- **在 agent 里的作用**
  - 取消后第二天接不上，因为发生过什么只在内存 messages 里。
  - 只看最终回答，无法解释哪一步被中断、哪一步失败。
  - 一次纯文本 turn 可观察、可取消、可恢复
- **关键特征**
  - turn/end 必须放在 finally，失败也要收口。
  - 取消保留已交付前缀，不丢用户看到的内容。
  - 请求从 deriveMessages 派生，不允许隐藏 messages 数组。
- **运行位置**
  - turn/start → step/start → request/header 先入日志。
  - SSE chunk 按 block index 进入 StreamAssembler。
  - block-end → assistant/message → turn/end。
- **面试常问**
  - 为什么不是 while(true)？
  - turn/end 为什么放 finally？
  - 取消为什么保留前缀？
- **架构连接**
  - s02 把工具调用与结果接进同一条 turn。
  - s03 把事件日志投影成 surface。

### s02 · 工具往返

- **是什么 / 格式**
  - tool-call：assistant 请求工具，参数是原始 JSON。
  - tool/call：运行时的日志事实，带 turn/step 归属。
  - tool/result：模型可见结果，isError 也是正常结果。
- **在 agent 里的作用**
  - 只有 tool-call 没有 result，模型下一轮只能猜。
  - 工具异常直接终止 turn，模型学不到“失败也是一种结果”。
  - tool-call 与 tool/result 成对进入下一轮
- **关键特征**
  - 调用与结果必须配对，否则下一步是非法历史。
  - 未知工具、参数非法、工具抛错都变成 isError。
  - 原始参数不重新序列化，避免破坏模型给的 JSON。
- **运行位置**
  - assistant message 产出 tool-call block。
  - ToolRegistry 执行、校验参数、规范化结果。
  - tool/result 写回；deriveMessages 在下一步带上它。
- **面试常问**
  - tool-call 和 tool/result 为什么必须配对？
  - 工具报错该不该终止 turn？
  - 多个工具调用如何按 id 配对？
- **架构连接**
  - s01 提供 turn/step 与日志。
  - s05 把参数 schema 与输出契约前移。

### s03 · Session Log

- **是什么 / 格式**
  - 事件信封：seq / time / type / data，追加后不改。
  - surface：当前模型视图的 seq 列表。
  - replace：用新摘要遮蔽旧视图，不删除事件。
- **在 agent 里的作用**
  - 可变的 messages 数组只说明现在，不说明为什么变成这样。
  - 恢复、审计、fork 都需要原始事实，而不是最终视图。
  - 让日志成为唯一事实源，surface 只是视图
- **关键特征**
  - 模型可见即已记录，不能在发送前偷偷塞消息。
  - replace 只改变视图，sourceEventSeqs 保留来源。
  - fork 只能复制稳定前缀，不能截出悬空历史。
- **运行位置**
  - append 事件到日志，seq 连续递增。
  - deriveMessages 按 surface 投影模型历史。
  - restore 从日志和 surface 重建会话。
- **面试常问**
  - 为什么不直接维护 messages 数组？
  - replace 和删除有什么区别？
  - fork 为什么只能选稳定前缀？
- **架构连接**
  - s10 把日志落成 JSONL。
  - s11 用 replace 做上下文压缩。

### s04 · 流式与 attempt

- **是什么 / 格式**
  - chunk：流式增量，按 block index 归位。
  - attempt：一次模型请求的结算，带完整 stream。
  - live 帧：进程内给 UI 的 start/chunk/end。
- **在 agent 里的作用**
  - 用户已经看到一半文本，取消不能当没发生。
  - 断流后要能解释模型说到哪、为什么停。
  - 把流式过程结算成可回放的 attempt
- **关键特征**
  - usage 必须出现在 finish 之前。
  - 取消保留已交付前缀，attempt 不进模型历史。
  - 原始 chunk 持久化，重放才能解释断流。
- **运行位置**
  - chunk 到达，先推 live 帧，再进 assembler。
  - block-start / delta / block-end 组装 message。
  - assistant/message 或 assistant/attempt 持久化 stream。
- **面试常问**
  - chunk / block / message 三者什么关系？
  - attempt 为什么不进模型历史？
  - usage 为什么必须在 finish 前？
- **架构连接**
  - s01 的 loop 调用模型。
  - s05 的工具参数也走同一套流式组装。

### s05 · 工具契约

- **是什么 / 格式**
  - DSL：作者写参数、输出、作用域。
  - JSON Schema：模型看到的 input_schema。
  - 输出契约：execute 返回规范值，render 投影给模型。
- **在 agent 里的作用**
  - 模型给错参数时，副作用绝不能先发生。
  - TypeScript 类型不能直接给模型看，必须编译成 schema。
  - 坏参数和坏输出都在副作用前被拒绝
- **关键特征**
  - 坏参数返回 isError，不进入 execute。
  - 输出非法也是错误结果，不是崩溃。
  - 条件工具是步骤级，不是注册时一次决定。
- **运行位置**
  - defineTool 编译参数与输出 schema。
  - validateParameters 在执行前拒绝坏参数。
  - validateOutput 通过后，render 生成 ContentBlock。
- **面试常问**
  - TS 类型为什么不直接给模型？
  - 为什么参数和输出都要 schema？
  - 参数非法应该由谁负责？
- **架构连接**
  - s06 给工具调用加策略与审批。
  - s19 浏览器工具也遵循同一 schema 边界。

### s06 · 工具运行时

- **是什么 / 格式**
  - pre-execute：可扩展前置决策。
  - guard：单调收紧，只能拒绝不能放行。
  - approval：高风险动作的显式协议。
- **在 agent 里的作用**
  - 模型选择工具，不等于这次调用已经合法。
  - 写文件、Shell、并发批处理都可能互相踩踏。
  - 工具调用经过策略、审批、并发和结果发布
- **关键特征**
  - 审批不可用必须 fail closed。
  - 并发必须显式声明，默认独占。
  - tools/result 发布后只读，监听器不能改。
- **运行位置**
  - pre-execute → guard → approval。
  - approval 通过后进入 tools/execute。
  - post-execute → finalizeContent → tools/result。
- **面试常问**
  - 模型选了工具，等于授权了吗？
  - guard 为什么只能收紧？
  - 并发为什么默认独占？
- **架构连接**
  - s05 定义工具契约。
  - s14 把 fs/shell/sandbox 变成可替换能力。

### s07 · 系统提示词

- **是什么 / 格式**
  - sections：有名字、顺序、稳定文本。
  - contexts / variables：运行时注入的动态片段。
  - head admission：决定 system 放开头还是追加历史。
- **在 agent 里的作用**
  - 提示词不是常量，会随工作区、权限、工具变化。
  - 每次重拼字符串会破坏稳定前缀与 KV cache。
  - 提示词可组装、可缓存、可准入
- **关键特征**
  - 稳定内容放前缀，动态内容放后部。
  - 秘密不进入提示词或日志。
  - in-history 只追加，不回写开头 head。
- **运行位置**
  - 注册 section 与 context。
  - renderContextMessage 渲染动态片段。
  - system head 准入后生成请求。
- **面试常问**
  - 提示词为什么不是字符串常量？
  - 替换 head 与 in-history 的 cache 差异？
  - 哪些内容不能进系统提示词？
- **架构连接**
  - s08 的 inbox 输入进入 prompt。
  - s09 的 provider 决定请求如何发出。

### s08 · Inbox / steering

- **是什么 / 格式**
  - next-turn：每条消息独占一个新轮次。
  - next-step：下次步骤边界消费。
  - claim：从队列删除，逐条发 claimed。
- **在 agent 里的作用**
  - 用户中途插话，不能都伪装成普通消息。
  - 取消不是删除，已经发生的输入要有因果。
  - 运行中的输入有明确队列和取消语义
- **关键特征**
  - steering 在 step/end 后进历史。
  - 取消 keepInbox 保留待处理输入。
  - whenIdle 等待整个 agent，不等待单条消息。
- **运行位置**
  - followup 进 next-turn 并唤醒。
  - steer/inject 进 next-step；inject 不唤醒。
  - turn 边界领全部 next-step + 一条 next-turn；step 边界只领 next-step。
- **面试常问**
  - next-turn 和 next-step 有什么区别？
  - claim 为什么是纯删除？
  - 取消后的输入去了哪里？
- **架构连接**
  - s01 的 turn/step 提供边界。
  - s03 的日志记录输入。

### s09 · LLM seam

- **是什么 / 格式**
  - Message / ContentBlock：provider-neutral 词汇。
  - StreamChunk：有序、带终止语义的流协议。
  - prepareCall：绑定 config、capabilities、retryPolicy。
- **在 agent 里的作用**
  - loop 不能理解每家模型的消息、工具、流和错误。
  - replay 需要 provider 私有状态，不能只存文本。
  - 把 provider 差异关进适配器，loop 只认统一词汇
- **关键特征**
  - 失败事实在 adapter 归一化。
  - 重试是 loop/策略的事，adapter 不擅自重试。
  - 取消信号必须穿过 adapter。
- **运行位置**
  - provider 注册到 runtime。
  - prepare 解析模型与能力。
  - stream 把 SSE 翻译成 StreamChunk。
- **面试常问**
  - loop 为什么不直接调用 provider？
  - prepareCall 到底绑定了什么？
  - 失败事实和重试策略为什么要分开？
- **架构连接**
  - s10 把会话事实落盘。
  - s11 用新的 surface 控制模型输入。

### s10 · JSONL 持久化

- **是什么 / 格式**
  - JSONL：一行一个事件，可直接读。
  - flush/fsync：显式持久屏障。
  - torn tail：崩溃留下的无效后缀。
- **在 agent 里的作用**
  - 进程会崩，内存 buffer 会丢。
  - 半行 JSON 不是一个完整事件。
  - 会话活过崩溃，坏尾可修复，前缀可 fork
- **关键特征**
  - 无效尾行丢弃，不破坏有效前缀。
  - 未闭合 turn 补 interrupted。
  - fork 复制前缀并加 seed 标记。
- **运行位置**
  - append 只进 buffer。
  - flush 写文件并 fsync。
  - open 逐行解析，修复后 restore。
- **面试常问**
  - 为什么持久化事件而不是最终消息？
  - flush 为什么必须是显式屏障？
  - 半行 JSON 为什么可以安全丢弃？
- **架构连接**
  - s03 定义事件和 surface。
  - s11 压缩后仍需可恢复。

### s11 · Compaction

- **是什么 / 格式**
  - threshold/retain：按窗口比例决定何时压、留多少。
  - prune：先裁剪语义密度低的工具结果。
  - summary：独立模型请求生成摘要。
- **在 agent 里的作用**
  - 48KB 工具结果会把上下文顶满。
  - 简单截断会连目标、约束、未完成调用一起删。
  - 上下文压力下保留目标与约束继续跑
- **关键特征**
  - 旧事件不删除，只改变当前视图。
  - sourceEventSeqs 说明摘要来源。
  - overflow 在仍打开的 step 内重试。
- **运行位置**
  - estimate 超过阈值。
  - prune 替换超长 tool/result。
  - summary 写回，surfaceOp replace 遮蔽旧段。
- **面试常问**
  - 压缩和截断的区别是什么？
  - 为什么先 prune 再 summary？
  - 摘要如何不丢目标和约束？
- **架构连接**
  - s03 的 surface replace。
  - s10 的日志恢复。

### s12 · Plugin kernel

- **是什么 / 格式**
  - Context：按服务键发现能力。
  - inject：依赖未满足就等待。
  - Fiber/effect：副作用有归属、可逆。
- **在 agent 里的作用**
  - 硬编码 loop 无法替换控制流。
  - 卸载插件必须撤销副作用，否则 HMR 不可靠。
  - 能力可插拔、依赖可推导、副作用可撤销
- **关键特征**
  - effect 必须登记 disposer。
  - waterfall 观察者必须委托下游。
  - scope 限制监听器可见范围。
- **运行位置**
  - plugin 注册服务与监听器。
  - inject 解析依赖，Fiber 激活。
  - dispose 逆序撤销 effect。
- **面试常问**
  - 为什么连 Agent Loop 也是插件？
  - inject 解决了什么问题？
  - effect 为什么必须可逆？
- **架构连接**
  - s13 用 bundle/profile/patch 组装插件树。
  - s09 provider 也是插件。

### s13 · 组合与启动

- **是什么 / 格式**
  - Bundle：分发一组插件行。
  - Profile：产品形态的有序配方。
  - Patch：按层级覆盖或插入。
- **在 agent 里的作用**
  - Web/headless 不能各复制一份内核。
  - 多个配置冲突时，必须知道谁获胜。
  - 产品由 bundle/profile/patch 组合，可复现
- **关键特征**
  - 按 id 覆盖是整段替换，不深合并。
  - !!js 是可审计的运行时逃生口。
  - dump-config 复现一次运行。
- **运行位置**
  - bundle 按 profile 顺序叠加。
  - home patch / CLI patch 覆盖。
  - loader 激活最终插件树。
- **面试常问**
  - Bundle / Profile / Patch 各管什么？
  - 为什么按 id 覆盖是整段替换？
  - 一个完整 Seam 有哪三个角色？
- **架构连接**
  - s12 提供 kernel。
  - s22 web 是 profile 的宿主产物。

### s14 · 能力接缝

- **是什么 / 格式**
  - Definition：稳定能力契约。
  - Provider：本地/远程/沙箱实现。
  - Consumer：工具/终端/LSP。
- **在 agent 里的作用**
  - agent 要读写文件、执行 Shell、访问网络。
  - 工具直连宿主，就无法替换成沙箱/远程。
  - agent 通过 seam 安全地接触真实世界
- **关键特征**
  - 消费者不能绕过 seam。
  - 路径边界与工作区容器。
  - 策略失败 fail closed。
- **运行位置**
  - tool 只调 ctx.fs / ctx.shell。
  - provider 解析实际执行环境。
  - approval/sandbox 在执行前决定。
- **面试常问**
  - 为什么能力不等于权限？
  - 消费者绕过 seam 会怎样？
  - sandbox 策略失败为什么 fail closed？
- **架构连接**
  - s06 的 pipeline 调能力。
  - s19 browser 也是 provider seam。

### s15 · Subagents / presets

- **是什么 / 格式**
  - spawn：新会话，只带任务与继承权限。
  - maxDepth/maxActive：硬预算。
  - preset：按会话组装提示词与工具子集。
- **在 agent 里的作用**
  - 复制 loop 会放大会话、权限、预算和失败传播。
  - 子任务需要独立上下文，而不是污染父历史。
  - 委派子任务而不复制 loop、不失控预算
- **关键特征**
  - 预算启动前检查，不能靠工具描述。
  - child 日志独立、可恢复。
  - 父只保留摘要，不复制 child 事件。
- **运行位置**
  - 父工具调用 spawn。
  - manager 检查预算后创建 child。
  - child 跑独立 loop，结果回父。
- **面试常问**
  - spawn 和 fork 的区别？
  - maxDepth / maxActive 防什么？
  - preset 解决的是模型问题还是能力问题？
- **架构连接**
  - s08 的 inbox 接收结果。
  - s28 用多个子任务完成 capstone。

### s16 · PTC

- **是什么 / 格式**
  - program：async 函数体，可 await。
  - tools：Proxy，每次访问进入 callTool。
  - scope：fresh / persistent 变量容器。
- **在 agent 里的作用**
  - 工具多时，模型读 schema 和多次往返很贵。
  - 多步组合需要程序，而不是逐条调用。
  - 模型用程序组合工具，仍受执行边界约束
- **关键特征**
  - PTC 不是沙箱，仍需 timeout/取消。
  - 失败是结构化结果，不是异常。
  - 循环引用序列化失败。
- **运行位置**
  - run_code 编译 program。
  - program 调 tools.calc 等。
  - 结果、日志、调用记录一起返回。
- **面试常问**
  - PTC 和普通 tool call 有什么区别？
  - PTC 是沙箱吗？
  - 为什么要 persistent scope？
- **架构连接**
  - s06 的子调用仍走 tool pipeline。
  - s21 CUA 可用 PTC 组合多步动作。

### s17 · MCP / skills / commands

- **是什么 / 格式**
  - MCP：JSON-RPC 外部工具协议。
  - mcp__server__tool：避免命名冲突。
  - skill catalog / slash command：扩展上下文与宿主操作。
- **在 agent 里的作用**
  - 外部工具不应该修改 loop。
  - 所有 skill 正文一次塞入上下文太贵。
  - 外部工具与技能不修改 loop
- **关键特征**
  - schema 来自 server，不手写。
  - 工具错误映射 isError。
  - slash command 不产生模型轮次。
- **运行位置**
  - initialize → tools/list。
  - 模型调 tools/call。
  - 结果转 tool/result；skill 按需 load。
- **面试常问**
  - MCP 如何做到不修改 loop？
  - 工具名为什么要加 mcp__ 前缀？
  - skill 正文什么时候进入上下文？
- **架构连接**
  - s18 单独拆 skills/commands。
  - s19 browser 通过 provider 接外部能力。

### s18 · Skills / commands

- **是什么 / 格式**
  - SKILL.md：frontmatter + 正文。
  - catalog：只含元数据，不含正文。
  - load_skill：模型按需读取。
- **在 agent 里的作用**
  - 把所有 skill 正文放进 prompt 会挤占上下文。
  - 用户命令不应该走一次模型。
  - 技能按需加载，命令不产生模型轮次
- **关键特征**
  - catalog 不泄露正文。
  - 重名 skill 拒绝。
  - command 由 host 直接分派。
- **运行位置**
  - 扫描 bundle / flat .md。
  - catalog 注入上下文。
  - 模型 load_skill，正文才进入。
- **面试常问**
  - catalog 和 SKILL.md 正文有什么区别？
  - slash command 为什么不产生模型轮次？
  - skill 重名应该怎么处理？
- **架构连接**
  - s17 MCP 是外部工具。
  - s24 UI 可展示 skill/command 结果。

### s19 · Browser use

- **是什么 / 格式**
  - BrowserProvider：单槽位注册。
  - BrowserSession：会话拥有页面。
  - ref 表：给模型稳定元素引用。
- **在 agent 里的作用**
  - 浏览器不是 RPC，页面会在动作后变化。
  - 模型不能直接操作 DOM 或浏览器进程。
  - 浏览器操作是回合制观测-动作-再观测
- **关键特征**
  - 动作后必须重新观测。
  - 旧 ref 失效。
  - 元素/会话错误变 isError。
- **运行位置**
  - navigate 打开页面。
  - read 返回文本与 ref。
  - click(ref) 返回新快照。
- **面试常问**
  - 浏览器工具为什么是回合制？
  - 为什么要给模型 ref 表？
  - 动作后为什么必须重新观测？
- **架构连接**
  - s20 把同样思路带到桌面。
  - s14 用 capability seam 隔离宿主。

### s20 · Computer use I

- **是什么 / 格式**
  - CUA provider：单槽位。
  - app/window：应用与窗口边界。
  - AX/screenshot：模型可读的桌面快照。
- **在 agent 里的作用**
  - 桌面应用不是网页，读取需要系统授权。
  - 截图、AX、窗口都是外部状态。
  - 桌面读取先授权，快照可解释
- **关键特征**
  - 读取前必须授权。
  - 未授权 fail closed。
  - scale 影响后续坐标。
- **运行位置**
  - authorize 应用。
  - getState 返回 app/window/AX。
  - screenshot 返回图像与尺寸。
- **面试常问**
  - CUA 为什么读取前要授权？
  - AX 树和截图各自解决什么？
  - scale 会影响什么？
- **架构连接**
  - s21 在快照上执行动作。
  - s19 是浏览器版本。

### s21 · Computer use II

- **是什么 / 格式**
  - 绝对坐标：截图像素。
  - 相对坐标：0–999 千分比。
  - dispatched/verified：派发与验证分开。
- **在 agent 里的作用**
  - 动作 dispatched 不等于 UI 已改变。
  - 点击/输入不可撤销，必须能重新观测。
  - 动作派发后必须重新观测，权限可撤销
- **关键特征**
  - STALE_SNAPSHOT / WINDOW_CHANGED 要重新观测。
  - 权限撤销立即生效。
  - 输入不可 undo。
- **运行位置**
  - 拿最新 screenshot。
  - click/type/press/scroll。
  - 再截图确认，旧快照失效。
- **面试常问**
  - dispatched 等于 verified 吗？
  - STALE_SNAPSHOT 应该怎么恢复？
  - CUA 输入可以 undo 吗？
- **架构连接**
  - s20 的 state。
  - s27 的 allowlist 与审计。

### s22 · Web projection

- **是什么 / 格式**
  - projection：事件 → 卡片的纯 fold。
  - snapshot：首屏状态 + seq。
  - SSE delta：seq 之后的增量。
- **在 agent 里的作用**
  - 客户端各自 fold 事件会渲染不一致。
  - 断线重连不能把已结束的卡变回 running。
  - 客户端共享同一投影，断线可恢复
- **关键特征**
  - 客户端不自己 fold。
  - 按 seq 去重，不重放已有卡。
  - 多客户端看同一投影。
- **运行位置**
  - host 读 session events。
  - projection 生成 snapshot。
  - 客户端订阅 after=seq，接收 delta。
- **面试常问**
  - 客户端为什么不自己 fold 事件？
  - snapshot 和 delta 如何对齐？
  - 断线重连如何避免重复卡片？
- **架构连接**
  - s24 把投影渲染成 UI。
  - s23 用 SDK 暴露同一运行时。

### s23 · SDK / headless

- **是什么 / 格式**
  - JSON-RPC：请求/响应/通知。
  - stdio：newline framed。
  - session/event：服务端推送。
- **在 agent 里的作用**
  - 编辑器/CI 不应嵌入 loop。
  - 进程边界需要稳定协议与错误语义。
  - 运行时暴露为进程外 SDK
- **关键特征**
  - 错误结构化 code。
  - 取消要传递。
  - 退出码可判断。
- **运行位置**
  - 客户端 session/create。
  - 发送 prompt 请求。
  - 订阅 session/event。
- **面试常问**
  - SDK 为什么不直接嵌 loop？
  - JSON-RPC 如何传递 session 事件？
  - 取消如何跨进程？
- **架构连接**
  - s22 web 是另一种宿主。
  - s24 client UI 消费事件。

### s24 · Client UI

- **是什么 / 格式**
  - action card：text/tool/approval/error。
  - 状态：running/done/failed/denied。
  - snapshot + delta：首屏与增量。
- **在 agent 里的作用**
  - 原始事件不能直接渲染。
  - 工具/审批状态变化必须稳定映射。
  - 原始事件投影成稳定卡片
- **关键特征**
  - 已结束卡不回 running。
  - 状态由 host projection 决定。
  - payload 必须可序列化。
- **运行位置**
  - project events。
  - 工具卡合并 call/result。
  - 重连按 lastSeq 补事件。
- **面试常问**
  - 原始事件为什么不能直接渲染？
  - 卡片状态由谁决定？
  - 重连为什么不能把 done 变回 running？
- **架构连接**
  - s22 提供 projection。
  - s25 记录可回放 UI 状态。

### s25 · Observability

- **是什么 / 格式**
  - span：turn/step/tool 层级。
  - record/replay：事件与 chunk。
  - snapshot：归一化的事实。
- **在 agent 里的作用**
  - agent 行为不确定，必须能录、能回放。
  - 只看最终文本无法定位哪一步退化。
  - 一次运行可记录、回放、比较
- **关键特征**
  - 快照去时间戳噪声。
  - 失败也要记录。
  - 观测不阻塞主路径。
- **运行位置**
  - run 生成 span。
  - record 写事件与 chunk。
  - replay 不请求网络，重放同一 loop。
- **面试常问**
  - record / replay 为什么不请求模型？
  - snapshot 应该去掉哪些噪声？
  - span 如何分层？
- **架构连接**
  - s26 用回放做 eval。
  - s03 的日志是事实源。

### s26 · Eval / fault injection

- **是什么 / 格式**
  - scenario：模型脚本、工具、seed。
  - fault：429/timeout/断流/工具错误。
  - report：矩阵与结论。
- **在 agent 里的作用**
  - 一次失败无法稳定复现。
  - 只测成功路径，无法知道故障时行为。
  - 故障场景可重复、可报告
- **关键特征**
  - seed 固定，结果可重复。
  - 失败不包装成成功。
  - diff 必须能解释。
- **运行位置**
  - scenario 固定输入。
  - record 真实 run。
  - replay + 故障矩阵。
- **面试常问**
  - eval 为什么需要故障矩阵？
  - 固定 seed 解决什么问题？
  - 失败应该如何报告？
- **架构连接**
  - s25 提供 record/replay。
  - s28 用 eval 验收 capstone。

### s27 · Security

- **是什么 / 格式**
  - 路径容器：realpath + relative。
  - 审批：绑定参数、调用者、有效期。
  - redaction / allowlist：秘密与 CUA 授权。
- **在 agent 里的作用**
  - 模型会被间接内容注入。
  - 策略不能依赖模型自觉，必须运行时强制。
  - 安全边界不依赖模型自觉
- **关键特征**
  - fail closed，不静默放宽。
  - 审批不复用。
  - 秘密不进日志或上下文。
- **运行位置**
  - 工具参数物化并冻结。
  - 路径/审批在副作用前检查。
  - 结果截断、脱敏、审计。
- **面试常问**
  - 安全边界为什么不能交给模型？
  - 审批为什么不能复用？
  - 如何证明 secret 没进日志？
- **架构连接**
  - s14 的能力 seam。
  - s21 的 CUA 授权。

### s28 · Capstone

- **是什么 / 格式**
  - 多工具 agent。
  - JSONL 事件日志 + surface 摘要。
  - eval report：验收事实。
- **在 agent 里的作用**
  - 知识点不串起来，遇到真实任务仍然不会。
  - 真实仓库会同时暴露工具、日志、审批和 eval 问题。
  - 把 28 课组合成一个真实 agent
- **关键特征**
  - 工具错误/审批拒绝必须记录。
  - 报告不包装失败。
  - 结果可复现。
- **运行位置**
  - 读任务与工作区。
  - 工具调用、审批、日志。
  - 写 artifacts 与 eval report。
- **面试常问**
  - capstone 验收哪些能力？
  - 多工具调用如何保证配对？
  - 报告如何避免包装失败？
- **架构连接**
  - 回看 s01–s27 的接缝。
  - 下一步：用同一套边界做自己的 agent。
