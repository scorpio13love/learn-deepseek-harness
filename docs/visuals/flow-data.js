window.FLOW = {
  "s01": {
    "slug": "s01-agent-loop",
    "n": 1,
    "title": "agent loop",
    "subtitle": "一次文本 turn 的完整闭环",
    "part": "core",
    "nodes": [
      "User prompt",
      "turn / step",
      "DeepSeek SSE",
      "StreamAssembler",
      "assistant/message"
    ],
    "anchor": "core/agent-loop/src/agent.ts",
    "what": "把「调一次 DeepSeek」写成 coding agent 的最小闭环，并且让每一步都可以被观察： - 一次 turn 如何打开、如何以 turn/end 收口； - turn 里的 step 是什么，为什么不是简单的 while (true); - 模型返回的 SSE chunk 如何被 StreamAssembler 组装成一条 assistant message； - 用户取消时，已经流式交付的文本前缀如何保留； - 为什…",
    "why": "因为 agent 不是一次问答，而是会持续产生可观察事实的长事务： - 模型输出是流式的，用户在中途就能看到文本；取消不能把已经看到的内容抹掉； - 一次用户请求可能包含多个模型步骤，每一步都需要独立的失败、取消和用量边界； - 进程可能崩溃，恢复后必须能从事件日志重建“模型当时看到了什么”； - 失败（网络错误、内容过滤、超限）本身也是事实，不能用一个没人记录的异常吞掉。 所以 DSH 把循环写成显式的 turn() / ste…",
    "scene": "这节对应的是所有后续能力的地基： 没有这层状态机，后面的工具往返、持久化、压缩、subagent、SDK 都只是孤立模块。"
  },
  "s02": {
    "slug": "s02-tool-round-trip",
    "n": 2,
    "title": "tool round-trip",
    "subtitle": "工具调用如何回到下一轮请求",
    "part": "core",
    "nodes": [
      "assistant tool-call",
      "ToolRegistry",
      "tool/result",
      "surface append",
      "next request"
    ],
    "anchor": "core/agent-loop/src/agent.ts",
    "what": "模型如何产出 tool-call，运行时如何执行并规范化结果，tool/result 如何回到下一轮请求： - assistant/message 里的 tool-call block - tool/call 与 tool/result 的配对 - deriveMessages() 在第二步如何带上工具结果 - 工具失败/未知工具为什么也是可回放的结果",
    "why": "模型不能直接操作世界；它只能请求工具。DSH 把“调用”和“结果”都写成事件： - 调用和结果必须成对，否则下一步请求是非法历史 - 工具失败不能中断轮次，必须变成模型可见的 isError 结果 - 多步工具往返要保留每一步的 turn/step 归属 - 结果进入 surface 后，下一步请求才能看到它 参考： - agent-loop 的工具分发 - tools 子系统",
    "scene": "真实 coding agent 的日常： 每一步都是模型发起工具调用、运行时执行、结果回到历史，然后进入下一步。"
  },
  "s03": {
    "slug": "s03-session-log",
    "n": 3,
    "title": "session log",
    "subtitle": "append-only 事实与 surface 视图",
    "part": "core",
    "nodes": [
      "events[]",
      "surface[]",
      "deriveMessages",
      "ChatRequest",
      "replace 不改日志"
    ],
    "anchor": "core/session/src/{index,surface}.ts",
    "what": "为什么 DSH 存 append-only 事件日志，而不是 messages: Message[]： - 事件信封：seq/time/type/data - surface：当前模型视图的 seq 列表 - deriveMessages()：从 surface 派生历史 - surfaceOp: replace：压缩/改写视图但不删除事实 - Session.restore()：从日志重建",
    "why": "因为会话需要被重放、压缩、审计、fork： - 如果直接改 messages，原始历史不可恢复 - 压缩只是改变“模型看到什么”，不是删除事实 - 崩溃恢复必须从日志重建，不能相信外部状态 - fork 需要复制前缀，而不是复制派生结果 参考： - session 子系统 - surface.ts",
    "scene": "长会话压缩、进程重启恢复、fork 子会话、排查“模型当时到底看到了什么”。"
  },
  "s04": {
    "slug": "s04-streaming",
    "n": 4,
    "title": "stream & attempt",
    "subtitle": "chunk 如何变成可回放的 attempt",
    "part": "core",
    "nodes": [
      "SSE chunk",
      "StreamAssembler",
      "AssistantStreamAttempt",
      "assistant/message",
      "assistant/attempt"
    ],
    "anchor": "llm/llm/src/{assembler,assistant-stream}.ts",
    "what": "SSE chunk 如何变成可回放的 attempt：block 组装、usage、live 帧、失败/取消前缀。",
    "why": "流式输出是用户已经看到的事实；只有把原始 chunk 持久化，断线/取消/重试后才能解释“模型当时说了什么”。",
    "scene": "长回答、网络断流、用户中途取消、排查一个被截断的 assistant message。"
  },
  "s05": {
    "slug": "s05-tool-contract",
    "n": 5,
    "title": "tool contract",
    "subtitle": "作者写 TS，模型看 JSON Schema",
    "part": "core",
    "nodes": [
      "TS DSL",
      "JSON Schema",
      "validate args",
      "ToolSet",
      "output contract"
    ],
    "anchor": "core/tools/src/{schema,contracts}.ts",
    "what": "工具作者如何用 TypeScript DSL 定义参数、输出契约、条件和作用域，再编译成模型可见的 JSON Schema。",
    "why": "模型只能看 schema，不能看 TypeScript；校验必须发生在副作用之前，输出契约让工具结果可渲染、可测试。",
    "scene": "给 agent 新增一个文件/数据库/HTTP 工具，参数非法时在调用前拒绝。"
  },
  "s06": {
    "slug": "s06-tool-runtime",
    "n": 6,
    "title": "tool runtime",
    "subtitle": "一次工具调用的运行时流水线",
    "part": "core",
    "nodes": [
      "tool/call",
      "guard",
      "approval",
      "batch execute",
      "result / recovery"
    ],
    "anchor": "core/tools/src/{pipeline,batch}.ts",
    "what": "一次工具调用的运行时：pre、guard、审批、执行、并发批次、超时、失败恢复。",
    "why": "工具有副作用，不能只写 tool.run()：需要权限、并发边界、取消，以及失败后仍能配对的工具历史。",
    "scene": "并行读多个文件、串行写文件、危险命令需要审批。"
  },
  "s07": {
    "slug": "s07-system-prompt",
    "n": 7,
    "title": "system prompt",
    "subtitle": "提示词是组装结果，不是字符串常量",
    "part": "context",
    "nodes": [
      "sections",
      "variables",
      "contexts",
      "head admission",
      "ChatRequest"
    ],
    "anchor": "core/system-prompt/src/index.ts",
    "what": "提示词如何由 sections、variables、contexts、toolOrder 组装，并在 system head 准入。",
    "why": "提示词不是常量：它随工作区、权限、工具变化；DSH 还要利用 KV cache，决定替换还是 in-history 追加。",
    "scene": "同一个 agent 在不同仓库、不同权限下需要不同系统提示词。"
  },
  "s08": {
    "slug": "s08-inbox-steering",
    "n": 8,
    "title": "inbox / steering",
    "subtitle": "运行中的 agent 如何接收输入",
    "part": "context",
    "nodes": [
      "user input",
      "inbox queues",
      "claim",
      "step / turn",
      "agent"
    ],
    "anchor": "core/agent-loop/src/{inbox,agent}.ts",
    "what": "运行中的 agent 如何接收输入：next-turn / next-step、claim、followup、steer、inject、cancel。",
    "why": "用户不会等 agent 跑完才说话；输入必须排队、可撤销、可区分“下一轮”和“下一步”。",
    "scene": "用户看到 agent 跑偏，立刻中途纠正。"
  },
  "s09": {
    "slug": "s09-llm-seam",
    "n": 9,
    "title": "LLM seam",
    "subtitle": "模型调用是可替换的 I/O 边界",
    "part": "context",
    "nodes": [
      "ChatRequest",
      "prepareCall",
      "provider",
      "capabilities",
      "retry / response"
    ],
    "anchor": "llm/llm/src/{call-config,retry-policy}.ts",
    "what": "Provider 注册、prepareCall、能力元数据、in-history 与 step 内重试。",
    "why": "模型是可替换的 I/O；能力差异和失败模式不能散落在 loop 里。",
    "scene": "切换 DeepSeek 模型、遇到 429、需要能力协商。"
  },
  "s10": {
    "slug": "s10-persistence",
    "n": 10,
    "title": "persistence",
    "subtitle": "会话如何活过进程重启",
    "part": "context",
    "nodes": [
      "append event",
      "flush barrier",
      "JSONL",
      "restore / repair",
      "fork / resume"
    ],
    "anchor": "session/session-persistence/src/index.ts",
    "what": "JSONL 会话日志、flush 屏障、resume、截断修复、未闭合 turn、fork。",
    "why": "进程会崩，会话不能只活在内存；事实必须落盘，恢复时还要能修坏尾。",
    "scene": "长任务跑一半进程被杀，第二天继续。"
  },
  "s11": {
    "slug": "s11-compaction",
    "n": 11,
    "title": "compaction",
    "subtitle": "上下文压力下改变模型视图",
    "part": "context",
    "nodes": [
      "token pressure",
      "prune results",
      "summarize",
      "surface replace",
      "next request"
    ],
    "anchor": "compaction/compaction-basic/src/index.ts",
    "what": "token 压力、工具结果裁剪、摘要、surface replace、overflow 重试。",
    "why": "上下文有限；压缩是“改变模型看到的视图”，不是删除审计事实。",
    "scene": "长会话继续工作，同时保留最近决策。"
  },
  "s12": {
    "slug": "s12-plugin-kernel",
    "n": 12,
    "title": "plugin kernel",
    "subtitle": "能力如何变成可卸载的插件",
    "part": "composition",
    "nodes": [
      "Context",
      "Service",
      "Fiber",
      "effect",
      "scope"
    ],
    "anchor": "vendor/cordis/src/{context,fiber,events}.ts",
    "what": "Context、Service、Fiber、effect、events、scope：把前面课程重构成插件树。",
    "why": "生产 harness 的能力必须可替换、可卸载、可热插拔；没有特权内核。",
    "scene": "替换工具、模型、UI，或卸载一个插件而不泄漏监听器。"
  },
  "s13": {
    "slug": "s13-composition-boot",
    "n": 13,
    "title": "composition / boot",
    "subtitle": "profile、bundle、patch 如何叠加",
    "part": "composition",
    "nodes": [
      "profile",
      "bundle",
      "patch",
      "required entry",
      "boot"
    ],
    "anchor": "boot/app-boot, bundle/base",
    "what": "profile、bundle、patch、required entry、dump config。",
    "why": "不同部署需要不同插件组合，组合必须可复现、可审计、错误早失败。",
    "scene": "CLI、headless、web 三种 profile 共用一套 bundle。"
  },
  "s14": {
    "slug": "s14-capability-seams",
    "n": 14,
    "title": "capability seams",
    "subtitle": "agent 如何安全地碰真实世界",
    "part": "execution",
    "nodes": [
      "tool call",
      "fs / shell",
      "sandbox",
      "approval",
      "result"
    ],
    "anchor": "fs/tool-fs, shell, sandbox",
    "what": "fs、shell、sandbox、approval：agent 如何安全地碰真实世界。",
    "why": "工具只是消费者；路径、进程、权限必须由可替换的 provider 提供。",
    "scene": "在真实仓库读写、跑测试，同时限制工作区边界。"
  },
  "s15": {
    "slug": "s15-subagents-presets",
    "n": 15,
    "title": "subagents / presets",
    "subtitle": "委派、隔离与预算",
    "part": "execution",
    "nodes": [
      "parent agent",
      "spawn",
      "child session",
      "preset / budget",
      "result"
    ],
    "anchor": "subagent/subagent/src/manager.ts",
    "what": "spawn、子会话、深度/并发预算、preset。",
    "why": "复杂任务需要委派，但委派必须隔离、可限制、可追踪。",
    "scene": "父 agent 让子 agent 调研一个目录，再汇总。"
  },
  "s16": {
    "slug": "s16-ptc",
    "n": 16,
    "title": "PTC",
    "subtitle": "模型写代码调用 tools.*",
    "part": "execution",
    "nodes": [
      "model code",
      "run_code",
      "tools.*",
      "result / error",
      "next request"
    ],
    "anchor": "ptc-runtime/ptc-runtime",
    "what": "PTC（programmatic tool calling）把「模型逐个调用工具」换成「模型写一段程序，runtime 执行它」： 本课实现一个最小但语义完整的 PtcRuntime： - 模型生成的 JS 可以通过 tools.<name(args) 调用已注册工具； - 支持异步、Promise.all、中间变量； - 工具结果跨边界前做 JSON 序列化； - 工具错误 / 程序异常变成结构化 result.error，程序…",
    "why": "Computer-use agent（CUA）的每一步都很碎：截图 → 找坐标 → 点击 → 输入 → 等待 → 再截图。如果每一次都走一次模型往返： - 延迟高：每个动作都要一次 LLM 请求； - 上下文脏：截图、坐标、中间状态全塞进模型历史； - 脆弱：模型要在多轮之间“记住”自己刚才点到了哪里； - 贵：token 随步骤数线性增长。 PTC 让模型把「点哪里、输入什么、失败怎么重试」写成一个程序，runtime 在本地执…",
    "scene": "- CUA：一次程序里完成“截图 → 点击 → 输入 → 校验”，失败就重试； - 批量代码修改：遍历文件、条件跳过、汇总结果，只把 summary 返回模型； - 数据处理：调用多个查询工具、在本地 join，避免把原始行塞进上下文； - workflow 编排：把子 agent / 工具调用写成程序，而不是让模型逐步决策。"
  },
  "s17": {
    "slug": "s17-mcp-skills-commands",
    "n": 17,
    "title": "MCP / skills / commands",
    "subtitle": "不修改 loop 的外部能力",
    "part": "execution",
    "nodes": [
      "MCP server",
      "tools/list",
      "tools/call",
      "tool result",
      "assistant"
    ],
    "anchor": "mcp/mcp-client, skill, interaction/commands",
    "what": "MCP 工具发现/调用、skill catalog、slash command。",
    "why": "外部能力不应该修改 loop：MCP 注册成工具，skill 贡献上下文，command 走 host。",
    "scene": "接入 GitHub/Slack MCP，加载团队 skill，执行 /help。"
  },
  "s18": {
    "slug": "s18-skills-commands",
    "n": 18,
    "title": "skills / commands",
    "subtitle": "技能目录与斜杠命令",
    "part": "execution",
    "nodes": [
      "SKILL.md",
      "catalog",
      "load_skill",
      "slash command",
      "host dispatch"
    ],
    "anchor": "skill/skill, interaction/commands",
    "what": "",
    "why": "",
    "scene": "用户说：“帮我把这份 PDF 表单填了。” 如果没有 catalog/按需加载，第二步就只能把两个技能的正文都塞进上下文；如果没有 host 命令，/help 会变成一次昂贵的模型请求。"
  },
  "s19": {
    "slug": "s19-browser-use",
    "n": 19,
    "title": "browser use",
    "subtitle": "浏览器 provider 与会话",
    "part": "execution",
    "nodes": [
      "agent tool",
      "browser provider",
      "page / DOM",
      "click / screenshot",
      "result"
    ],
    "anchor": "browser-use/browser-use",
    "what": "浏览器操作能力由三段组成，本课逐段实现： 1. 注册表：一个组合只能挂一个 browser provider（BrowserProviderRegistry），第二个注册必须失败；dispose 释放槽位并关掉它拥有的会话。 2. 会话 seam：BrowserProvider 只负责 open()；BrowserSession 暴露 navigate / read / click / screenshot / close。模型工…",
    "why": "- 共享服务只登记名字，不登记方法。DSH 的 BrowserUseRegistry 只有一个槽位和一个 providerName，没有 navigate() 之类的通用方法。原因：不同 provider 的工具 schema、结果渲染、截图能力、上游限制都不同；把方法塞进共享层会强迫所有 provider 长成一样。 - 浏览器属于 Session，而不属于全局。启动的浏览器归使用它的那个实时 Agent/Session；跨轮次…",
    "scene": "用户说：「打开 mock 商店，找到 products 页，把商品名读给我，然后点回首页。」 Loop 会这样走： 注意 e1 在不同快照里指向不同元素：ref 只在它所属的快照内有效。这是浏览器自动化的核心约束，也是下一课「快照失效」的伏笔。"
  },
  "s20": {
    "slug": "s20-computer-use-i",
    "n": 20,
    "title": "computer use I",
    "subtitle": "应用、窗口、AX 与截图",
    "part": "execution",
    "nodes": [
      "CUA provider",
      "app / window",
      "AX snapshot",
      "screenshot",
      "model"
    ],
    "anchor": "computer-use/computer-use, experimental/cua",
    "what": "1. 注册表：ComputerUseProviderRegistry 一次只允许一个 provider（第二个注册失败），dispose() 关闭它拥有的会话后释放槽位。 2. 桌面 seam：ComputerUseProvider 只负责 open()；CuaDesktopSession 提供 listApps / getApp / getWindows / getState / screenshot。 3. 授权：应用必须先被…",
    "why": "- 共享服务只登记名字。DSH 的 ComputerUseRegistry 没有通用的 click / type 方法；工具 schema、AX 渲染、截图诊断、上游限制都归 provider。共享层只回答「现在挂的是哪个 provider」。 - 权限属于 provider，不属于模型。CUA 的真实边界是 macOS TCC（辅助功能 / 屏幕录制）加上「用户是否允许控制这个应用」两件事。DSH 把应用授权放在 provide…",
    "scene": "用户说：「在 Notes 里找到购物清单，把内容读给我。」 如果用户还没允许控制 Notes，第三步会直接失败，前两步里也不会泄露任何 AX 内容。"
  },
  "s21": {
    "slug": "s21-computer-use-ii",
    "n": 21,
    "title": "computer use II",
    "subtitle": "坐标、动作、权限与失效",
    "part": "execution",
    "nodes": [
      "screenshot",
      "coordinate",
      "action",
      "verify / stale",
      "next step"
    ],
    "anchor": "experimental/cua-macos, cua",
    "what": "在 s20 的观察能力上补四件事： 1. 动作：click / type / press / scroll。每个动作返回 status: \"dispatched\"、verified: false、irreversible: true。成功只代表「已发出」，不代表「界面已生效」。 2. 坐标：绝对坐标是最近一次截图的像素（换算成原生 point 要除以 scale）；相对坐标是 0-999 的千分比，窗口尺寸变化后仍可用。 3. 失…",
    "why": "- 输入不可撤销。桌面收到的是真实事件（CGEvent），发出后无法撤回。DSH 的 guidance 明确写着：取消可能留下部分效果；不确定时不要重试，先观察。API 用 verified: false 强迫调用方重新读状态，而不是相信「成功」。 - 坐标必须绑定观测。模型看到的是截图，原生接口要的是 point。两者之间隔着 scale、窗口边框、多显示器。DSH 让 provider 保存「截图 ↔ 窗口几何」的对应关系，在…",
    "scene": "用户说：「把 Notes 里购物清单的末尾加上 — milk，然后确认写进去了。」 如果第二步之后直接 click 一个旧 snapshotId 的元素，会得到 STALESNAPSHOT；如果这时窗口被用户拉大，会先得到 WINDOWCHANGED。"
  },
  "s22": {
    "slug": "s22-web",
    "n": 22,
    "title": "web",
    "subtitle": "投影、SSE 与断线重连",
    "part": "product",
    "nodes": [
      "session events",
      "projection",
      "snapshot",
      "SSE",
      "client"
    ],
    "anchor": "session/session-projection, host/webserver",
    "what": "session projection、SSE 快照+增量、断线重连、多客户端。",
    "why": "客户端不应该各自 fold 事件；host 计算一次投影，客户端只渲染。",
    "scene": "浏览器打开一个长任务，断网后恢复。"
  },
  "s23": {
    "slug": "s23-sdk-headless",
    "n": 23,
    "title": "SDK / headless",
    "subtitle": "把 harness 变成进程外服务",
    "part": "product",
    "nodes": [
      "client",
      "JSON-RPC",
      "SDK server",
      "agent",
      "session/event"
    ],
    "anchor": "sdk/protocol, sdk/server",
    "what": "newline JSON-RPC、session/create、prompt、session/event、stdio。",
    "why": "把 harness 变成进程外服务，编辑器/CI 才能嵌入。",
    "scene": "VS Code 插件或 CI 脚本调用 agent。"
  },
  "s24": {
    "slug": "s24-client-ui",
    "n": 24,
    "title": "client UI",
    "subtitle": "事件如何变成可渲染卡片",
    "part": "product",
    "nodes": [
      "events",
      "action cards",
      "HTML",
      "client",
      "reconnect"
    ],
    "anchor": "client/ui-renderer",
    "what": "",
    "why": "",
    "scene": "用户打开一个长任务会话：助手说“我先看看项目结构”，调用 readfile，接着要写文件，弹出审批，用户拒绝，模型改用只读方案，最后又遇到一次 429。客户端需要把这段过程稳定地渲染成五类卡片——text、tool-call、tool-result、approval、error——每张卡都有状态、标题、摘要和可序列化 payload，而且断线重连后不能把已经结束的工具卡重新显示成“运行中”。 本课不引入 React，也不启动真实模…"
  },
  "s25": {
    "slug": "s25-observability-eval",
    "n": 25,
    "title": "observability / eval",
    "subtitle": "span、回放与快照",
    "part": "quality",
    "nodes": [
      "span",
      "trace",
      "record / replay",
      "snapshot",
      "eval report"
    ],
    "anchor": "telemetry/otel, snapshots",
    "what": "span、record/replay、session snapshot、故障注入、性能基线。",
    "why": "agent 行为不确定，必须能录制、回放、对比和注入失败。",
    "scene": "改 prompt 后确认没有退化，复现一个 429/断流。"
  },
  "s26": {
    "slug": "s26-eval",
    "n": 26,
    "title": "eval / fault injection",
    "subtitle": "可重复的 scenario 与故障矩阵",
    "part": "quality",
    "nodes": [
      "scenario",
      "record",
      "replay",
      "fault",
      "report"
    ],
    "anchor": "docs/testing.zh.md, snapshots",
    "what": "",
    "why": "",
    "scene": "凌晨两点，线上 agent 在第 3 步收到 429；另一次请求在流到一半时连接被切断；还有一次工具返回了错误参数。你不可能靠“再跑一次真实模型”来复现这些偶发故障。 本课把 s25 里的 telemetry/record/replay 拆出一个评测层：一次录制，多次重放；用 snapshot 比较两次运行；用故障矩阵覆盖 429 / 超时 / 断流 / 工具错误；最后用一个可重复的 scenario runner 输出通过率、失…"
  },
  "s27": {
    "slug": "s27-security",
    "n": 27,
    "title": "security / permissions",
    "subtitle": "路径、审批、redaction 与授权",
    "part": "quality",
    "nodes": [
      "tool input",
      "path guard",
      "approval",
      "redaction",
      "audit"
    ],
    "anchor": "sandbox, interaction/user-approval",
    "what": "",
    "why": "",
    "scene": "一个 coding agent 正在改项目：它请求读取 ../../.ssh/idrsa，请求写入工作区外的文件，弹出审批后用户直接关掉了窗口，工具返回了 2 MB 的构建日志，随后 CUA 想点击一个没有授权的桌面应用。任何一处默认放行，都会把“教学 demo”变成真实事故。 本课只实现五条最小边界：工作区路径逃逸、fail-closed 审批、secret/sensitive 字段 redaction、工具输出截断、CUA 应…"
  },
  "s28": {
    "slug": "s28-capstone",
    "n": 28,
    "title": "capstone",
    "subtitle": "用完整 harness 跑真实任务",
    "part": "quality",
    "nodes": [
      "task",
      "agent loop",
      "tools",
      "artifacts",
      "eval report"
    ],
    "anchor": "core/agent-loop/src/agent.ts",
    "what": "",
    "why": "",
    "scene": "交付一个仓库审计任务：agent 必须列出文件、读取源码、搜索 TODO/FIXME、写出一份带 file:line 引用的 audit.md，最后给出摘要。运行结束后留下四类证据： - events.jsonl：append-only 事件日志； - surface.json：工具/文件/审批/错误的 surface 摘要； - eval-report.json：验收检查与指标（通过/失败、步骤、token、文件数）； - au…"
  }
};
