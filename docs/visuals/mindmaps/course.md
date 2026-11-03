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

- **为什么**
  - 取消后第二天接不上，因为发生过什么只在内存 messages 里。
  - 只看最终回答，无法解释哪一步被中断、哪一步失败。
- **核心概念**
  - turn：一次任务唤醒，从 turn/start 到 turn/end。
  - step：turn 里的一次模型请求，可能没有工具。
  - attempt：一次流式请求的结算，成功/失败/取消都要收口。
- **运行顺序**
  - turn/start → step/start → request/header 先入日志。
  - SSE chunk 按 block index 进入 StreamAssembler。
  - block-end → assistant/message → turn/end。
- **边界/失败**
  - turn/end 必须放在 finally，失败也要收口。
  - 取消保留已交付前缀，不丢用户看到的内容。
  - 请求从 deriveMessages 派生，不允许隐藏 messages 数组。
- **连接**
  - s02 把工具调用与结果接进同一条 turn。
  - s03 把事件日志投影成 surface。

### s02 · 工具往返

- **为什么**
  - 只有 tool-call 没有 result，模型下一轮只能猜。
  - 工具异常直接终止 turn，模型学不到“失败也是一种结果”。
- **核心概念**
  - tool-call：assistant 请求工具，参数是原始 JSON。
  - tool/call：运行时的日志事实，带 turn/step 归属。
  - tool/result：模型可见结果，isError 也是正常结果。
- **运行顺序**
  - assistant message 产出 tool-call block。
  - ToolRegistry 执行、校验参数、规范化结果。
  - tool/result 写回；deriveMessages 在下一步带上它。
- **边界/失败**
  - 调用与结果必须配对，否则下一步是非法历史。
  - 未知工具、参数非法、工具抛错都变成 isError。
  - 原始参数不重新序列化，避免破坏模型给的 JSON。
- **连接**
  - s01 提供 turn/step 与日志。
  - s05 把参数 schema 与输出契约前移。

### s03 · Session Log

- **为什么**
  - 可变的 messages 数组只说明现在，不说明为什么变成这样。
  - 恢复、审计、fork 都需要原始事实，而不是最终视图。
- **核心概念**
  - 事件信封：seq / time / type / data，追加后不改。
  - surface：当前模型视图的 seq 列表。
  - replace：用新摘要遮蔽旧视图，不删除事件。
- **运行顺序**
  - append 事件到日志，seq 连续递增。
  - deriveMessages 按 surface 投影模型历史。
  - restore 从日志和 surface 重建会话。
- **边界/失败**
  - 模型可见即已记录，不能在发送前偷偷塞消息。
  - replace 只改变视图，sourceEventSeqs 保留来源。
  - fork 只能复制稳定前缀，不能截出悬空历史。
- **连接**
  - s10 把日志落成 JSONL。
  - s11 用 replace 做上下文压缩。

### s04 · 流式与 attempt

- **为什么**
  - 用户已经看到一半文本，取消不能当没发生。
  - 断流后要能解释模型说到哪、为什么停。
- **核心概念**
  - chunk：流式增量，按 block index 归位。
  - attempt：一次模型请求的结算，带完整 stream。
  - live 帧：进程内给 UI 的 start/chunk/end。
- **运行顺序**
  - chunk 到达，先推 live 帧，再进 assembler。
  - block-start / delta / block-end 组装 message。
  - assistant/message 或 assistant/attempt 持久化 stream。
- **边界/失败**
  - usage 必须出现在 finish 之前。
  - 取消保留已交付前缀，attempt 不进模型历史。
  - 原始 chunk 持久化，重放才能解释断流。
- **连接**
  - s01 的 loop 调用模型。
  - s05 的工具参数也走同一套流式组装。

### s05 · 工具契约

- **为什么**
  - 模型给错参数时，副作用绝不能先发生。
  - TypeScript 类型不能直接给模型看，必须编译成 schema。
- **核心概念**
  - DSL：作者写参数、输出、作用域。
  - JSON Schema：模型看到的 input_schema。
  - 输出契约：execute 返回规范值，render 投影给模型。
- **运行顺序**
  - defineTool 编译参数与输出 schema。
  - validateParameters 在执行前拒绝坏参数。
  - validateOutput 通过后，render 生成 ContentBlock。
- **边界/失败**
  - 坏参数返回 isError，不进入 execute。
  - 输出非法也是错误结果，不是崩溃。
  - 条件工具是步骤级，不是注册时一次决定。
- **连接**
  - s06 给工具调用加策略与审批。
  - s19 浏览器工具也遵循同一 schema 边界。

### s06 · 工具运行时

- **为什么**
  - 模型选择工具，不等于这次调用已经合法。
  - 写文件、Shell、并发批处理都可能互相踩踏。
- **核心概念**
  - pre-execute：可扩展前置决策。
  - guard：单调收紧，只能拒绝不能放行。
  - approval：高风险动作的显式协议。
- **运行顺序**
  - pre-execute → guard → approval。
  - approval 通过后进入 tools/execute。
  - post-execute → finalizeContent → tools/result。
- **边界/失败**
  - 审批不可用必须 fail closed。
  - 并发必须显式声明，默认独占。
  - tools/result 发布后只读，监听器不能改。
- **连接**
  - s05 定义工具契约。
  - s14 把 fs/shell/sandbox 变成可替换能力。

### s07 · 系统提示词

- **为什么**
  - 提示词不是常量，会随工作区、权限、工具变化。
  - 每次重拼字符串会破坏稳定前缀与 KV cache。
- **核心概念**
  - sections：有名字、顺序、稳定文本。
  - contexts / variables：运行时注入的动态片段。
  - head admission：决定 system 放开头还是追加历史。
- **运行顺序**
  - 注册 section 与 context。
  - renderContextMessage 渲染动态片段。
  - system head 准入后生成请求。
- **边界/失败**
  - 稳定内容放前缀，动态内容放后部。
  - 秘密不进入提示词或日志。
  - in-history 只追加，不回写开头 head。
- **连接**
  - s08 的 inbox 输入进入 prompt。
  - s09 的 provider 决定请求如何发出。

### s08 · Inbox / steering

- **为什么**
  - 用户中途插话，不能都伪装成普通消息。
  - 取消不是删除，已经发生的输入要有因果。
- **核心概念**
  - next-turn：每条消息独占一个新轮次。
  - next-step：下次步骤边界消费。
  - claim：从队列删除，逐条发 claimed。
- **运行顺序**
  - followup 进 next-turn 并唤醒。
  - steer/inject 进 next-step；inject 不唤醒。
  - turn 边界领全部 next-step + 一条 next-turn；step 边界只领 next-step。
- **边界/失败**
  - steering 在 step/end 后进历史。
  - 取消 keepInbox 保留待处理输入。
  - whenIdle 等待整个 agent，不等待单条消息。
- **连接**
  - s01 的 turn/step 提供边界。
  - s03 的日志记录输入。

### s09 · LLM seam

- **为什么**
  - loop 不能理解每家模型的消息、工具、流和错误。
  - replay 需要 provider 私有状态，不能只存文本。
- **核心概念**
  - Message / ContentBlock：provider-neutral 词汇。
  - StreamChunk：有序、带终止语义的流协议。
  - prepareCall：绑定 config、capabilities、retryPolicy。
- **运行顺序**
  - provider 注册到 runtime。
  - prepare 解析模型与能力。
  - stream 把 SSE 翻译成 StreamChunk。
- **边界/失败**
  - 失败事实在 adapter 归一化。
  - 重试是 loop/策略的事，adapter 不擅自重试。
  - 取消信号必须穿过 adapter。
- **连接**
  - s10 把会话事实落盘。
  - s11 用新的 surface 控制模型输入。

### s10 · JSONL 持久化

- **为什么**
  - 进程会崩，内存 buffer 会丢。
  - 半行 JSON 不是一个完整事件。
- **核心概念**
  - JSONL：一行一个事件，可直接读。
  - flush/fsync：显式持久屏障。
  - torn tail：崩溃留下的无效后缀。
- **运行顺序**
  - append 只进 buffer。
  - flush 写文件并 fsync。
  - open 逐行解析，修复后 restore。
- **边界/失败**
  - 无效尾行丢弃，不破坏有效前缀。
  - 未闭合 turn 补 interrupted。
  - fork 复制前缀并加 seed 标记。
- **连接**
  - s03 定义事件和 surface。
  - s11 压缩后仍需可恢复。

### s11 · Compaction

- **为什么**
  - 48KB 工具结果会把上下文顶满。
  - 简单截断会连目标、约束、未完成调用一起删。
- **核心概念**
  - threshold/retain：按窗口比例决定何时压、留多少。
  - prune：先裁剪语义密度低的工具结果。
  - summary：独立模型请求生成摘要。
- **运行顺序**
  - estimate 超过阈值。
  - prune 替换超长 tool/result。
  - summary 写回，surfaceOp replace 遮蔽旧段。
- **边界/失败**
  - 旧事件不删除，只改变当前视图。
  - sourceEventSeqs 说明摘要来源。
  - overflow 在仍打开的 step 内重试。
- **连接**
  - s03 的 surface replace。
  - s10 的日志恢复。

### s12 · Plugin kernel

- **为什么**
  - 硬编码 loop 无法替换控制流。
  - 卸载插件必须撤销副作用，否则 HMR 不可靠。
- **核心概念**
  - Context：按服务键发现能力。
  - inject：依赖未满足就等待。
  - Fiber/effect：副作用有归属、可逆。
- **运行顺序**
  - plugin 注册服务与监听器。
  - inject 解析依赖，Fiber 激活。
  - dispose 逆序撤销 effect。
- **边界/失败**
  - effect 必须登记 disposer。
  - waterfall 观察者必须委托下游。
  - scope 限制监听器可见范围。
- **连接**
  - s13 用 bundle/profile/patch 组装插件树。
  - s09 provider 也是插件。

### s13 · 组合与启动

- **为什么**
  - Web/headless 不能各复制一份内核。
  - 多个配置冲突时，必须知道谁获胜。
- **核心概念**
  - Bundle：分发一组插件行。
  - Profile：产品形态的有序配方。
  - Patch：按层级覆盖或插入。
- **运行顺序**
  - bundle 按 profile 顺序叠加。
  - home patch / CLI patch 覆盖。
  - loader 激活最终插件树。
- **边界/失败**
  - 按 id 覆盖是整段替换，不深合并。
  - !!js 是可审计的运行时逃生口。
  - dump-config 复现一次运行。
- **连接**
  - s12 提供 kernel。
  - s22 web 是 profile 的宿主产物。

### s14 · 能力接缝

- **为什么**
  - agent 要读写文件、执行 Shell、访问网络。
  - 工具直连宿主，就无法替换成沙箱/远程。
- **核心概念**
  - Definition：稳定能力契约。
  - Provider：本地/远程/沙箱实现。
  - Consumer：工具/终端/LSP。
- **运行顺序**
  - tool 只调 ctx.fs / ctx.shell。
  - provider 解析实际执行环境。
  - approval/sandbox 在执行前决定。
- **边界/失败**
  - 消费者不能绕过 seam。
  - 路径边界与工作区容器。
  - 策略失败 fail closed。
- **连接**
  - s06 的 pipeline 调能力。
  - s19 browser 也是 provider seam。

### s15 · Subagents / presets

- **为什么**
  - 复制 loop 会放大会话、权限、预算和失败传播。
  - 子任务需要独立上下文，而不是污染父历史。
- **核心概念**
  - spawn：新会话，只带任务与继承权限。
  - maxDepth/maxActive：硬预算。
  - preset：按会话组装提示词与工具子集。
- **运行顺序**
  - 父工具调用 spawn。
  - manager 检查预算后创建 child。
  - child 跑独立 loop，结果回父。
- **边界/失败**
  - 预算启动前检查，不能靠工具描述。
  - child 日志独立、可恢复。
  - 父只保留摘要，不复制 child 事件。
- **连接**
  - s08 的 inbox 接收结果。
  - s28 用多个子任务完成 capstone。

### s16 · PTC

- **为什么**
  - 工具多时，模型读 schema 和多次往返很贵。
  - 多步组合需要程序，而不是逐条调用。
- **核心概念**
  - program：async 函数体，可 await。
  - tools：Proxy，每次访问进入 callTool。
  - scope：fresh / persistent 变量容器。
- **运行顺序**
  - run_code 编译 program。
  - program 调 tools.calc 等。
  - 结果、日志、调用记录一起返回。
- **边界/失败**
  - PTC 不是沙箱，仍需 timeout/取消。
  - 失败是结构化结果，不是异常。
  - 循环引用序列化失败。
- **连接**
  - s06 的子调用仍走 tool pipeline。
  - s21 CUA 可用 PTC 组合多步动作。

### s17 · MCP / skills / commands

- **为什么**
  - 外部工具不应该修改 loop。
  - 所有 skill 正文一次塞入上下文太贵。
- **核心概念**
  - MCP：JSON-RPC 外部工具协议。
  - mcp__server__tool：避免命名冲突。
  - skill catalog / slash command：扩展上下文与宿主操作。
- **运行顺序**
  - initialize → tools/list。
  - 模型调 tools/call。
  - 结果转 tool/result；skill 按需 load。
- **边界/失败**
  - schema 来自 server，不手写。
  - 工具错误映射 isError。
  - slash command 不产生模型轮次。
- **连接**
  - s18 单独拆 skills/commands。
  - s19 browser 通过 provider 接外部能力。

### s18 · Skills / commands

- **为什么**
  - 把所有 skill 正文放进 prompt 会挤占上下文。
  - 用户命令不应该走一次模型。
- **核心概念**
  - SKILL.md：frontmatter + 正文。
  - catalog：只含元数据，不含正文。
  - load_skill：模型按需读取。
- **运行顺序**
  - 扫描 bundle / flat .md。
  - catalog 注入上下文。
  - 模型 load_skill，正文才进入。
- **边界/失败**
  - catalog 不泄露正文。
  - 重名 skill 拒绝。
  - command 由 host 直接分派。
- **连接**
  - s17 MCP 是外部工具。
  - s24 UI 可展示 skill/command 结果。

### s19 · Browser use

- **为什么**
  - 浏览器不是 RPC，页面会在动作后变化。
  - 模型不能直接操作 DOM 或浏览器进程。
- **核心概念**
  - BrowserProvider：单槽位注册。
  - BrowserSession：会话拥有页面。
  - ref 表：给模型稳定元素引用。
- **运行顺序**
  - navigate 打开页面。
  - read 返回文本与 ref。
  - click(ref) 返回新快照。
- **边界/失败**
  - 动作后必须重新观测。
  - 旧 ref 失效。
  - 元素/会话错误变 isError。
- **连接**
  - s20 把同样思路带到桌面。
  - s14 用 capability seam 隔离宿主。

### s20 · Computer use I

- **为什么**
  - 桌面应用不是网页，读取需要系统授权。
  - 截图、AX、窗口都是外部状态。
- **核心概念**
  - CUA provider：单槽位。
  - app/window：应用与窗口边界。
  - AX/screenshot：模型可读的桌面快照。
- **运行顺序**
  - authorize 应用。
  - getState 返回 app/window/AX。
  - screenshot 返回图像与尺寸。
- **边界/失败**
  - 读取前必须授权。
  - 未授权 fail closed。
  - scale 影响后续坐标。
- **连接**
  - s21 在快照上执行动作。
  - s19 是浏览器版本。

### s21 · Computer use II

- **为什么**
  - 动作 dispatched 不等于 UI 已改变。
  - 点击/输入不可撤销，必须能重新观测。
- **核心概念**
  - 绝对坐标：截图像素。
  - 相对坐标：0–999 千分比。
  - dispatched/verified：派发与验证分开。
- **运行顺序**
  - 拿最新 screenshot。
  - click/type/press/scroll。
  - 再截图确认，旧快照失效。
- **边界/失败**
  - STALE_SNAPSHOT / WINDOW_CHANGED 要重新观测。
  - 权限撤销立即生效。
  - 输入不可 undo。
- **连接**
  - s20 的 state。
  - s27 的 allowlist 与审计。

### s22 · Web projection

- **为什么**
  - 客户端各自 fold 事件会渲染不一致。
  - 断线重连不能把已结束的卡变回 running。
- **核心概念**
  - projection：事件 → 卡片的纯 fold。
  - snapshot：首屏状态 + seq。
  - SSE delta：seq 之后的增量。
- **运行顺序**
  - host 读 session events。
  - projection 生成 snapshot。
  - 客户端订阅 after=seq，接收 delta。
- **边界/失败**
  - 客户端不自己 fold。
  - 按 seq 去重，不重放已有卡。
  - 多客户端看同一投影。
- **连接**
  - s24 把投影渲染成 UI。
  - s23 用 SDK 暴露同一运行时。

### s23 · SDK / headless

- **为什么**
  - 编辑器/CI 不应嵌入 loop。
  - 进程边界需要稳定协议与错误语义。
- **核心概念**
  - JSON-RPC：请求/响应/通知。
  - stdio：newline framed。
  - session/event：服务端推送。
- **运行顺序**
  - 客户端 session/create。
  - 发送 prompt 请求。
  - 订阅 session/event。
- **边界/失败**
  - 错误结构化 code。
  - 取消要传递。
  - 退出码可判断。
- **连接**
  - s22 web 是另一种宿主。
  - s24 client UI 消费事件。

### s24 · Client UI

- **为什么**
  - 原始事件不能直接渲染。
  - 工具/审批状态变化必须稳定映射。
- **核心概念**
  - action card：text/tool/approval/error。
  - 状态：running/done/failed/denied。
  - snapshot + delta：首屏与增量。
- **运行顺序**
  - project events。
  - 工具卡合并 call/result。
  - 重连按 lastSeq 补事件。
- **边界/失败**
  - 已结束卡不回 running。
  - 状态由 host projection 决定。
  - payload 必须可序列化。
- **连接**
  - s22 提供 projection。
  - s25 记录可回放 UI 状态。

### s25 · Observability

- **为什么**
  - agent 行为不确定，必须能录、能回放。
  - 只看最终文本无法定位哪一步退化。
- **核心概念**
  - span：turn/step/tool 层级。
  - record/replay：事件与 chunk。
  - snapshot：归一化的事实。
- **运行顺序**
  - run 生成 span。
  - record 写事件与 chunk。
  - replay 不请求网络，重放同一 loop。
- **边界/失败**
  - 快照去时间戳噪声。
  - 失败也要记录。
  - 观测不阻塞主路径。
- **连接**
  - s26 用回放做 eval。
  - s03 的日志是事实源。

### s26 · Eval / fault injection

- **为什么**
  - 一次失败无法稳定复现。
  - 只测成功路径，无法知道故障时行为。
- **核心概念**
  - scenario：模型脚本、工具、seed。
  - fault：429/timeout/断流/工具错误。
  - report：矩阵与结论。
- **运行顺序**
  - scenario 固定输入。
  - record 真实 run。
  - replay + 故障矩阵。
- **边界/失败**
  - seed 固定，结果可重复。
  - 失败不包装成成功。
  - diff 必须能解释。
- **连接**
  - s25 提供 record/replay。
  - s28 用 eval 验收 capstone。

### s27 · Security

- **为什么**
  - 模型会被间接内容注入。
  - 策略不能依赖模型自觉，必须运行时强制。
- **核心概念**
  - 路径容器：realpath + relative。
  - 审批：绑定参数、调用者、有效期。
  - redaction / allowlist：秘密与 CUA 授权。
- **运行顺序**
  - 工具参数物化并冻结。
  - 路径/审批在副作用前检查。
  - 结果截断、脱敏、审计。
- **边界/失败**
  - fail closed，不静默放宽。
  - 审批不复用。
  - 秘密不进日志或上下文。
- **连接**
  - s14 的能力 seam。
  - s21 的 CUA 授权。

### s28 · Capstone

- **为什么**
  - 知识点不串起来，遇到真实任务仍然不会。
  - 真实仓库会同时暴露工具、日志、审批和 eval 问题。
- **核心概念**
  - 多工具 agent。
  - JSONL 事件日志 + surface 摘要。
  - eval report：验收事实。
- **运行顺序**
  - 读任务与工作区。
  - 工具调用、审批、日志。
  - 写 artifacts 与 eval report。
- **边界/失败**
  - 工具错误/审批拒绝必须记录。
  - 报告不包装失败。
  - 结果可复现。
- **连接**
  - 回看 s01–s27 的接缝。
  - 下一步：用同一套边界做自己的 agent。
