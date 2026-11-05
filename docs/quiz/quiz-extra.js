/* 每个 Part 的补充概念题：单选 / 多选 / 判断。 */
window.QUIZ_PARTS = [
  ['core', 'I · 内核', 's01–s06'],
  ['context', 'II · 上下文', 's07–s11'],
  ['composition', 'III · 组合', 's12–s13'],
  ['execution', 'IV · 执行边界', 's14–s21'],
  ['product', 'V · 产品面', 's22–s24'],
  ['quality', 'VI · 质量', 's25–s28'],
]

window.QUIZ_MORE = [
  // I 内核
  ['m-core-1','s01','core','DSH 说“没有特权内核”，最准确的含义是什么？',['Agent Loop 不能替换','连 loop 也可以作为插件替换','插件不能注册服务','只有 UI 可以替换'],1,'没有任何重要性自动带来不可替换性；loop 也遵守插件契约。'],
  ['m-core-2','s01','core','turn/end 必须覆盖失败和取消路径。',['正确','错误'],0,'否则日志里的 turn 会永远悬空。','tf'],
  ['m-core-3','s02','core','tool/call 没有对应 tool/result 时，下一步请求仍然合法。',['正确','错误'],1,'调用与结果必须配对；缺失结果会让模型历史不可解释。','tf'],
  ['m-core-4','s06','core','以下哪些是 guard 的正确性质？',['只能拒绝或不做决定','可以返回 allow 放行','后注册插件不能推翻前面的拒绝','拒绝理由应可审计'],[0,2,3],'单调 guard 只能收紧权限，真正的允许来自基础策略或审批。','multi'],
  ['m-core-5','s04','core','assistant/attempt 可以进入模型历史。',['正确','错误'],1,'attempt 保留 stream 作为事实，但不作为完整 assistant message 进入 surface。','tf'],
  ['m-core-6','s03','core','surface replace 会删除被替换的原始事件。',['正确','错误'],1,'replace 只改变当前视图；原始事件保留，来源由 sourceEventSeqs 记录。','tf'],

  // II 上下文
  ['m-context-1','s11','context','surface replace 需要记录哪些信息？',['sourceEventSeqs','被替换事件的原始内容副本','新视图节点','删除全部旧事件'],[0,2],'replace 记录来源并发布新视图，原始事件不删除。','multi'],
  ['m-context-2','s07','context','系统提示词的稳定 section 应尽量放在前缀，以复用 KV cache。',['正确','错误'],0,'稳定前缀不变，动态上下文放后部，才能复用缓存。','tf'],
  ['m-context-3','s08','context','next-turn 和 next-step 的核心区别是什么？',['next-turn 只存工具结果','next-turn 每条消息开启新轮次；next-step 在下个步骤边界消费','next-step 只给 UI','两者完全等价'],1,'followup 进 next-turn；steer/inject 进 next-step。'],
  ['m-context-4','s08','context','inbox.claim 是纯删除，队列只保存待处理消息。',['正确','错误'],0,'claim 删除并逐条通知，避免同一消息被两个边界领取。','tf'],
  ['m-context-5','s09','context','prepareCall 通常会绑定哪些内容？',['config 与模型路由','capabilities','retryPolicy','用户密码'],[0,1,2],'prepareCall 固定配置、能力与重试策略；密码不属于模型调用配置。','multi'],
  ['m-context-6','s10','context','JSONL 解析遇到半行 JSON 时，正确做法是什么？',['把半行补成合法 JSON','丢弃无效后缀，保留有效前缀','用随机字符补齐','让模型重写整个文件'],1,'半行不是事件；丢弃坏尾不会破坏有效前缀。'],
  ['m-context-7','s11','context','压缩时为什么通常先 prune 工具结果？',['工具结果一定不重要','语义密度低、裁剪收益高，可能已降到阈值','prune 比摘要更贵','prune 会删除原始事件'],1,'先裁剪低价值细节，仍超阈值再调用模型摘要。'],
  ['m-context-8','s11','context','overflow 恢复应在仍然打开的 step 内重试，不重跑 pre-step。',['正确','错误'],0,'重跑 pre-step 会重复工具、审批和提示词副作用。','tf'],
  ['m-context-9','s09','context','LLM adapter 的职责包括直接决定是否重试。',['正确','错误'],1,'adapter 归一化失败；是否重试属于 Agent/策略层。','tf'],
  ['m-context-10','s10','context','fork 应该选择什么样的边界？',['随机事件位置','没有开放 turn 的稳定前缀','最近一条工具结果之后','文件末尾'],1,'稳定前缀才能让子会话解释自己的过去。'],

  // III 组合
  ['m-comp-1','s12','composition','Cordis Context 通过什么发现能力？',['文件路径','稳定服务键','模型名称','UI 组件名'],1,'消费者按服务键取能力，不 import 具体实现。'],
  ['m-comp-2','s12','composition','inject 的作用是什么？',['让插件立即执行','声明依赖，未满足时等待','删除插件','替代事件系统'],1,'inject 把启动顺序变成依赖关系。'],
  ['m-comp-3','s12','composition','Fiber dispose 对 effect 的顺序是什么？',['按注册顺序','逆序撤销','随机','只清空内存'],1,'逆序撤销，先撤依赖再撤提供方。'],
  ['m-comp-4','s13','composition','Bundle、Profile、Patch 的职责，哪项正确？',['Bundle 分发插件行，Profile 定义产品配方，Patch 覆盖/插入','Bundle 存密钥，Profile 执行测试，Patch 是 UI','三者完全相同','Patch 只能删除文件'],0,'三者分别负责分发、产品组合和环境差异。'],
  ['m-comp-5','s13','composition','按 id 覆盖配置时，DSH 的语义是什么？',['深合并所有字段','整段替换，不做深合并','只替换第一个字段','随机合并'],1,'整段替换降低合并魔法，但要求复述配置和迁移。'],
  ['m-comp-6','s13','composition','一个完整的 capability seam 包含哪些角色？',['Definition','Provider','Consumer','Renderer'],[0,1,2],'Definition/Provider/Consumer 三角色；Renderer 不是 seam 角色。','multi'],
  ['m-comp-7','s14','composition','消费者可以绕过 seam 直接访问宿主实现。',['正确','错误'],1,'那样替换 provider 只存在于配置表面，执行环境不会真正迁移。','tf'],
  ['m-comp-8','s12','composition','HMR 能自动迁移插件持有的旧内存状态。',['正确','错误'],1,'HMR 能撤销 effect、激活新 Fiber，但内存状态迁移要单独设计。','tf'],
  ['m-comp-9','s12','composition','waterfall 监听器应该怎样处理？',['忽略下游','必须委托下游或明确终止','只能同步返回','只能记录日志'],1,'观察者不委托会截断后续插件。'],
  ['m-comp-10','s12','composition','effect 为什么必须登记 disposer？',['为了增加代码量','为了卸载时撤销副作用','为了让模型读取','为了生成 UI'],1,'没有 disposer，HMR 和插件卸载会泄漏监听器/连接。'],
  ['m-comp-11','s12','composition','Context.extend/isolate 主要用于什么？',['扩大模型上下文','隔离服务作用域与插件可见性','压缩 JSONL','执行 shell'],1,'作用域限制服务解析和监听器可见范围。'],
  ['m-comp-12','s13','composition','Profile 的主要职责是什么？',['定义产品形态的插件配方','存储 API key','渲染卡片','执行工具'],0,'Profile 决定 Web/headless/定制产品如何装配。'],
  ['m-comp-13','s13','composition','Patch 的 !!js 逃生口应如何对待？',['默认启用','可审计、受控使用','完全禁止','交给模型决定'],1,'它是运行时逃生口，必须可审计，不应成为默认路径。'],
  ['m-comp-14','s12','composition','插件注册服务后，消费者如何拿到它？',['import 具体类','通过 Context 服务键解析','读取全局变量','扫描文件系统'],1,'服务键是稳定契约，提供方可替换。'],
  ['m-comp-15','s12','composition','Fiber 激活失败时应该怎样？',['保持半初始化状态','回滚已注册 effect 并报告失败','忽略失败','删除日志'],1,'半初始化会留下泄漏的服务与监听器。'],
  ['m-comp-16','s13','composition','Bundle 应该决定某个用户的机器偏好。',['正确','错误'],1,'Bundle 只分发可共同安装的插件行；机器差异属于 profile/patch。','tf'],
  ['m-comp-17','s13','composition','Patch 的层级顺序应该怎样？',['随机','从基础配置到用户/CLI 覆盖，明确优先级','只保留最后一个文件','由模型排序'],1,'层级必须明确，最终配置才可复现。'],
  ['m-comp-18','s14','composition','capability seam 的 Consumer 应该依赖什么？',['具体本地实现','稳定 Definition 契约','UI 组件','模型 provider'],1,'消费者只依赖契约，替换 provider 才能成立。'],
  ['m-comp-19','s12','composition','插件事件中的 serial 与 bail 的区别是什么？',['serial 顺序执行，bail 可提前终止','两者都并行','serial 只给 UI','bail 只记录日志'],0,'serial 保序；bail 允许某个监听器终止后续。'],
  ['m-comp-20','s12','composition','effect 的所有权属于哪个层级？',['全局变量','Fiber/插件作用域','模型消息','UI DOM'],1,'effect 有归属，卸载时才能精确撤销。'],
  ['m-comp-21','s13','composition','dump-config 的价值是什么？',['让模型更聪明','复现一次启动的最终插件树','压缩上下文','替代测试'],1,'最终配置可审计、可复现，便于定位组合差异。'],
  ['m-comp-22','s13','composition','一个插件被禁用后，它注册的服务和监听器应该怎样？',['继续运行','随 Fiber 卸载而撤销','只停 UI','转交给模型'],1,'禁用必须撤销副作用，否则只是表面禁用。'],

  // V 产品面
  ['m-prod-1','s22','product','客户端为什么不自己 fold 事件？',['浏览器不支持循环','多个客户端会得到不一致视图','事件不能 JSON 化','SSE 只能传文本'],1,'host 统一 projection，客户端只渲染快照与增量。'],
  ['m-prod-2','s22','product','snapshot 需要带什么来对齐增量？',['随机 id','当前 seq','模型名称','文件路径'],1,'客户端从 snapshot.seq 之后接收 delta，避免重复。'],
  ['m-prod-3','s22','product','SSE 断线重连时应从什么地方继续？',['从头开始','lastSeq 之后','随机 seq','完整日志文件'],1,'按 seq 补缺失事件，保证卡片状态一致。'],
  ['m-prod-4','s23','product','SDK 常用什么传输协议？',['JSON-RPC over stdio','GraphQL over FTP','SOAP over UDP','HTML over SMTP'],0,'newline framed JSON-RPC 适合进程间通信。'],
  ['m-prod-5','s23','product','为什么 SDK 不直接嵌 Agent Loop？',['loop 太大','保持进程边界和稳定协议','loop 不能运行','SDK 只能读文件'],1,'编辑器/CI 通过协议共享运行时，不共享内存。'],
  ['m-prod-6','s24','product','action card 的状态由谁决定？',['客户端猜测','host projection','CSS','模型自由发挥'],1,'host 投影出稳定状态，客户端只渲染。'],
  ['m-prod-7','s24','product','断线重连后，已结束的工具卡应该怎样？',['变回 running','保持 done/failed','删除','重新执行工具'],1,'快照 + delta 按 seq 对齐，状态不能倒退。'],
  ['m-prod-8','s24','product','卡片 payload 为什么必须可序列化？',['为了美观','为了快照、回放和多客户端传输','为了加密','为了压缩'],1,'跨进程/断线重放需要无损 JSON。'],
  ['m-prod-9','s22','product','Web 与 headless 应该共享什么？',['各自一套 loop','同一套 session/events/tools/policy','只共享 CSS','只共享 API key'],1,'运行时稳定，宿主表面可替换。'],
  ['m-prod-10','s23','product','SDK 的 session/event 通知用于什么？',['传递日志文件','服务端推送运行事件','渲染 CSS','存储密钥'],1,'客户端通过事件通知获得增量。'],
  ['m-prod-11','s24','product','审批请求在客户端通常映射成什么状态？',['done','waiting','failed','running'],1,'等待用户/宿主决策，不能当作已完成。'],
  ['m-prod-12','s22','product','projection 应该是什么类型的函数？',['有随机副作用的函数','纯 fold，输入事件输出卡片','网络请求函数','模型调用函数'],1,'纯函数让实时 UI 与回放使用同一逻辑。'],
  ['m-prod-13','s23','product','SDK 客户端取消 prompt 时应该怎样？',['直接杀进程','通过协议发送取消信号','删除 session 文件','忽略'],1,'取消是协作式信号，跨进程也必须传递。'],
  ['m-prod-14','s24','product','多客户端同时查看同一 session 时，状态应该以什么为准？',['各自本地状态','host 的 snapshot + delta','随机客户端','模型输出'],1,'统一投影和 seq 对齐，避免分叉。'],
  ['m-prod-15','s22','product','Web projection 与模型上下文是同一份数据吗？',['是','不是；一个是 UI 投影，一个是模型 surface','只在压缩时相同','只在 SDK 中相同'],1,'UI 投影和模型 surface 共享事实源，但不是同一视图。'],
  ['m-prod-16','s23','product','JSON-RPC 的请求、响应、通知，哪项正确？',['通知不需要 id/响应','响应必须带 method','请求不能带 params','三者相同'],0,'通知是单向消息，不需要响应。'],
  ['m-prod-17','s24','product','卡片状态能不能由客户端根据文本猜？',['能','不能，状态来自事件投影','只能由模型猜','只能由 CSS 决定'],1,'猜测会产生不一致和回放漂移。'],
  ['m-prod-18','s22','product','snapshot 与 delta 的边界应该由什么标识？',['时间戳字符串','seq','模型名','文件名'],1,'seq 是单调事实顺序，适合对齐。'],

  // VI 质量
  ['m-qual-1','s25','quality','一个 span 通常对应什么？',['一次 UI 点击','turn/step/tool 等可观测区间','一条 CSS 规则','一个密钥'],1,'span 表达层级化的执行区间。'],
  ['m-qual-2','s25','quality','record/replay 为什么不能只记录最终文本？',['文本太长','无法解释工具、审批、失败和取消','不能 JSON 化','模型不喜欢'],1,'只存文本无法复现控制流和失败。'],
  ['m-qual-3','s25','quality','snapshot 归一化时应该去掉什么？',['工具名','耗时、时间戳等噪声','状态','错误码'],1,'比较行为而不是机器速度。'],
  ['m-qual-4','s26','quality','故障矩阵的价值是什么？',['增加题目数量','验证 429/超时/断流/工具错误时的行为','训练模型','压缩上下文'],1,'逐格检查失败语义、重试和最终状态。'],
  ['m-qual-5','s26','quality','eval 固定 seed 的作用是什么？',['让模型更聪明','让输入和随机选择可重复','减少 token','加密日志'],1,'可重复是定位回归的前提。'],
  ['m-qual-6','s26','quality','eval 失败时报告应该怎样？',['包装成成功','如实标出失败格与原因','删除失败记录','只报通过数'],1,'报告要能定位问题，而不是掩盖。'],
  ['m-qual-7','s27','quality','只用 startsWith(root) 检查路径为什么不够？',['太慢','挡不住 ../app-evil 和前缀相似目录','浏览器不支持','路径不能 JSON'],1,'需要 realpath/relative 的工作区容器。'],
  ['m-qual-8','s27','quality','审批服务不可用时应该怎样？',['默认允许','fail closed','跳过审批','让模型决定'],1,'安全策略失败不能退回更宽权限。'],
  ['m-qual-9','s27','quality','redaction 的目标是什么？',['让日志更短','确保 secret 不进入日志/上下文','隐藏工具名','删除错误'],1,'按 key/value 脱敏，同时保留审计结构。'],
  ['m-qual-10','s27','quality','CUA 的 allowlist 应该在哪一步生效？',['动作之后','读取/动作之前','只在 UI','只在日志'],1,'未授权读取或动作必须在副作用前拒绝。'],
  ['m-qual-11','s28','quality','capstone 验收应该看什么？',['只看最终文本','日志、surface、artifacts、eval report','只看 token 数','只看截图'],1,'真实任务需要可复现、可审计的产物。'],
  ['m-qual-12','s28','quality','capstone 的失败报告应该怎样？',['隐藏失败步骤','如实标记失败并定位原因','只保留成功路径','重试到通过'],1,'失败是结果，报告要诚实。'],
  ['m-qual-13','s27','quality','安全边界为什么不能只靠 Prompt？',['Prompt 太长','模型会犯错、内容可能注入指令','因为模型不能读文件','因为审批需要 UI'],1,'Approval、sandbox、凭据和审计属于运行时策略平面。'],
  ['m-qual-14','s25','quality','回放时应该重新请求模型吗？',['应该','不应该，按记录驱动同一 loop','只在失败时','只在 UI'],1,'replay 不访问网络，才能确定性复现。'],
]

window.QUIZ_CODING = [
  {
    "id": "code-turn-window",
    "taskId": "turn-window",
    "title": "哪些 turn 还开着？",
    "lesson": "s01 · agent loop",
    "part": "core",
    "prompt": "实现 openTurns(events)：按 turn/start 和 turn/end 计算仍未关闭的 turn 编号，升序返回。"
  },
  {
    "id": "code-pair-tool-results",
    "taskId": "pair-tool-results",
    "title": "配对 tool-call 与 tool/result",
    "lesson": "s02 · tool round-trip",
    "part": "core",
    "prompt": "实现 pairToolResults(calls, results)，返回 paired、unmatchedCalls、unmatchedResults。不要依赖数组顺序，按 id 配对。"
  },
  {
    "id": "code-derive-surface",
    "taskId": "derive-surface",
    "title": "实现 append + replace 的 surface",
    "lesson": "s03 · session log / surface",
    "part": "core",
    "prompt": "实现 deriveSurface(events)，维护当前视图 id 数组。遇到 replace 时先移除 sourceEventSeqs 中仍存在的 id，再加入当前事件 id。"
  },
  {
    "id": "code-assemble-text",
    "taskId": "assemble-text",
    "title": "把 text delta 拼成 assistant 文本",
    "lesson": "s04 · streaming",
    "part": "core",
    "prompt": "实现 assembleText(chunks)：把 text-delta 的 text 按顺序拼成一个字符串。"
  },
  {
    "id": "code-missing-args",
    "taskId": "missing-args",
    "title": "执行前找出缺失参数",
    "lesson": "s05 · tool contract",
    "part": "core",
    "prompt": "实现 missingArgs(args, required)：返回 args 中值为 undefined 的必填字段，保持 required 的顺序。"
  },
  {
    "id": "code-plan-batches",
    "taskId": "plan-batches",
    "title": "规划 parallel / exclusive 批次",
    "lesson": "s06 · tool runtime",
    "part": "core",
    "prompt": "实现 planBatches(calls)。连续的 parallel 调用合成一组；exclusive 调用各自一组，并在它前后切断 parallel 组。"
  },
  {
    "id": "code-render-sections",
    "taskId": "render-sections",
    "title": "按 order 渲染 prompt sections",
    "lesson": "s07 · system prompt",
    "part": "context",
    "prompt": "实现 renderSections(sections)：按 order 升序，用两个换行连接每段 text。"
  },
  {
    "id": "code-partition-inbox",
    "taskId": "partition-inbox",
    "title": "拆分 next-turn 与 next-step",
    "lesson": "s08 · inbox / steering",
    "part": "context",
    "prompt": "实现 partitionInbox(items)：返回 { nextTurn, nextStep }，分别放两类消息 id，保持原顺序。"
  },
  {
    "id": "code-normalize-failure",
    "taskId": "normalize-failure",
    "title": "把 HTTP 失败归一化成稳定类别",
    "lesson": "s09 · LLM seam",
    "part": "context",
    "prompt": "实现 normalizeFailure(status)：401→auth，429→rate-limit，408/504→timeout，500–599→server，其余→unknown。"
  },
  {
    "id": "code-parse-jsonl",
    "taskId": "parse-jsonl",
    "title": "逐行解析 JSONL，保留坏尾标记",
    "lesson": "s10 · persistence",
    "part": "context",
    "prompt": "实现 parseJsonl(text)：解析每个非空行，遇到第一个坏行停止，返回有效事件和 tornTail 布尔值。"
  },
  {
    "id": "code-should-compact",
    "taskId": "should-compact",
    "title": "实现上下文压缩阈值",
    "lesson": "s11 · compaction",
    "part": "context",
    "prompt": "实现 shouldCompact(tokens, contextWindow, thresholdRatio)。达到阈值返回 true；非法 window/ratio 时返回 false，不要抛出。"
  },
  {
    "id": "code-dispose-effects",
    "taskId": "dispose-effects",
    "title": "逆序撤销 effect",
    "lesson": "s12 · plugin kernel",
    "part": "composition",
    "prompt": "实现 disposeEffects(items)：从后往前调用 dispose，返回实际调用顺序的 name。"
  },
  {
    "id": "code-apply-patch",
    "taskId": "apply-patch",
    "title": "按 id 覆盖：整段替换而非深合并",
    "lesson": "s13 · composition / boot",
    "part": "composition",
    "prompt": "实现 applyPatch(base, patch)：返回浅层合并结果，patch 中的对象整段覆盖 base 中的同名对象。"
  },
  {
    "id": "code-workspace-path",
    "taskId": "workspace-path",
    "title": "实现工作区路径边界",
    "lesson": "s14 · capability seams / s27 · security",
    "part": "execution",
    "prompt": "实现 isInsideWorkspace(root, candidate)。工作区自身返回 true；越出 root 或前缀相似目录返回 false。可以使用 node:path。"
  },
  {
    "id": "code-can-spawn",
    "taskId": "can-spawn",
    "title": "子 agent 预算检查",
    "lesson": "s15 · subagents / presets",
    "part": "execution",
    "prompt": "实现 canSpawn(active, depth, maxActive, maxDepth)：未达到两个上限才返回 true。"
  },
  {
    "id": "code-safe-serialize",
    "taskId": "safe-serialize",
    "title": "PTC 返回值的安全序列化",
    "lesson": "s16 · PTC",
    "part": "execution",
    "prompt": "实现 safeSerialize(value)：成功返回 { ok: true, json }，失败返回 { ok: false, error: \"circular\" }。"
  },
  {
    "id": "code-mcp-name",
    "taskId": "mcp-name",
    "title": "生成稳定的 MCP 工具名",
    "lesson": "s17 · MCP",
    "part": "execution",
    "prompt": "实现 mcpToolName(server, tool)：返回 mcp__<server>__<tool>。"
  },
  {
    "id": "code-select-skills",
    "taskId": "select-skills",
    "title": "按查询筛选 skill catalog",
    "lesson": "s18 · skills / commands",
    "part": "execution",
    "prompt": "实现 selectSkills(catalog, query)：返回匹配的 name 数组，保持 catalog 顺序；query 为空时返回全部。"
  },
  {
    "id": "code-stale-ref",
    "taskId": "stale-ref",
    "title": "判断浏览器 ref 是否过期",
    "lesson": "s19 · browser use",
    "part": "execution",
    "prompt": "实现 isStaleRef(refSnapshot, currentSnapshot)：两者不同就返回 true。"
  },
  {
    "id": "code-scale-point",
    "taskId": "scale-point",
    "title": "把截图坐标换算成原生坐标",
    "lesson": "s20 · computer use I",
    "part": "execution",
    "prompt": "实现 scalePoint(x, y, scale)：返回 { x: Math.round(x * scale), y: Math.round(y * scale) }。"
  },
  {
    "id": "code-stale-reason",
    "taskId": "stale-reason",
    "title": "CUA 动作前的失效检查",
    "lesson": "s21 · computer use II",
    "part": "execution",
    "prompt": "实现 staleReason(refSnapshot, currentSnapshot, refWindow, currentWindow)：按上述优先级返回错误码或 null。"
  },
  {
    "id": "code-apply-delta",
    "taskId": "apply-delta",
    "title": "把 SSE 增量接到快照后面",
    "lesson": "s22 · web",
    "part": "product",
    "prompt": "实现 applyDelta(cards, events, lastSeq)：过滤 seq > lastSeq，按 seq 升序追加事件 id。"
  },
  {
    "id": "code-parse-jsonrpc",
    "taskId": "parse-jsonrpc",
    "title": "解析 SDK 的 JSON-RPC 行",
    "lesson": "s23 · SDK / headless",
    "part": "product",
    "prompt": "实现 parseJsonRpcLine(line)：解析 JSON，要求 jsonrpc === \"2.0\" 且 method 是字符串；否则抛出 Error(\"invalid\")。"
  },
  {
    "id": "code-card-status",
    "taskId": "card-status",
    "title": "把事件映射成卡片状态",
    "lesson": "s24 · client UI",
    "part": "product",
    "prompt": "实现 cardStatus(event)：approval/request→waiting；tool/result 且 isError→failed；tool/result→done；其余→running。"
  },
  {
    "id": "code-normalize-span",
    "taskId": "normalize-span",
    "title": "去掉 span 的时间噪声",
    "lesson": "s25 · observability",
    "part": "quality",
    "prompt": "实现 normalizeSpan(span)：返回 { name, status }，丢弃时间字段。"
  },
  {
    "id": "code-matrix-summary",
    "taskId": "matrix-summary",
    "title": "汇总 eval 故障矩阵",
    "lesson": "s26 · eval",
    "part": "quality",
    "prompt": "实现 summarizeMatrix(rows)：返回 { [scenario]: { pass, fail } }，没有成功即 fail，保持首次出现顺序。"
  },
  {
    "id": "code-redact-secrets",
    "taskId": "redact-secrets",
    "title": "日志脱敏 redaction",
    "lesson": "s27 · security",
    "part": "quality",
    "prompt": "实现 redactSecrets(text)：把 sk- 开头的 key、Bearer token、x-api-key 的值替换为 [REDACTED]。不要改普通单词。"
  },
  {
    "id": "code-audit-run",
    "taskId": "audit-run",
    "title": "审计一次 run 的未配对工具",
    "lesson": "s28 · capstone",
    "part": "quality",
    "prompt": "实现 auditRun(events)：收集 tool/call 的 id，返回没有对应 tool/result 的 id 数组，保持调用顺序。"
  }
]
