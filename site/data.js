window.COURSE = {
  "title": "Learn DeepSeek Harness",
  "subtitle": "28 课，从零重写一个生产级 Agent Harness",
  "description": "沿着 DeepSeek Harness 的真实架构，用零依赖 TypeScript 重建 agent loop、会话日志、工具流水线、插件内核、computer use 与 Web/SDK。",
  "repo": "https://github.com/deepseek-ai/deepseek-harness",
  "branch": "master",
  "stats": [
    {
      "value": "28",
      "label": "自包含课程"
    },
    {
      "value": "1,352",
      "label": "累计测试运行"
    },
    {
      "value": "0",
      "label": "运行时依赖"
    },
    {
      "value": "28",
      "label": "可运行 demo"
    }
  ],
  "parts": [
    {
      "id": "core",
      "title": "I · 内核",
      "subtitle": "先把 loop、日志、流与工具写出来",
      "lessons": [
        "s01-agent-loop",
        "s02-tool-round-trip",
        "s03-session-log",
        "s04-streaming",
        "s05-tool-contract",
        "s06-tool-runtime"
      ]
    },
    {
      "id": "context",
      "title": "II · 上下文",
      "subtitle": "提示词、输入、模型与长会话",
      "lessons": [
        "s07-system-prompt",
        "s08-inbox-steering",
        "s09-llm-seam",
        "s10-persistence",
        "s11-compaction"
      ]
    },
    {
      "id": "composition",
      "title": "III · 组合",
      "subtitle": "插件树与启动配置",
      "lessons": [
        "s12-plugin-kernel",
        "s13-composition-boot"
      ]
    },
    {
      "id": "execution",
      "title": "IV · 执行边界",
      "subtitle": "文件、桌面、浏览器、外部协议",
      "lessons": [
        "s14-capability-seams",
        "s15-subagents-presets",
        "s16-ptc",
        "s17-mcp-skills-commands",
        "s18-skills-commands",
        "s19-browser-use",
        "s20-computer-use-i",
        "s21-computer-use-ii"
      ]
    },
    {
      "id": "product",
      "title": "V · 产品面",
      "subtitle": "浏览器、SDK、客户端 UI",
      "lessons": [
        "s22-web",
        "s23-sdk-headless",
        "s24-client-ui"
      ]
    },
    {
      "id": "quality",
      "title": "VI · 质量",
      "subtitle": "可观测、评测、安全、结课",
      "lessons": [
        "s25-observability-eval",
        "s26-eval",
        "s27-security",
        "s28-capstone"
      ]
    }
  ],
  "docs": [
    {
      "id": "architecture",
      "title": "DeepSeek Harness 架构阅读笔记",
      "short": "架构阅读笔记",
      "file": "../docs/00-architecture.zh.md",
      "desc": "运行时、包地图、Cordis、turn 时序、会话日志、loop、工具、提示词、LLM seam、能力 seam、扩展面、传输与文件索引。",
      "badge": "20 节"
    },
    {
      "id": "course-design",
      "title": "28 课课程设计",
      "short": "课程设计",
      "file": "../docs/02-course-v3.zh.md",
      "desc": "六条主线、28 课、computer use、每课开篇模板与可视化规范。",
      "badge": "v3"
    },
    {
      "id": "course-readme",
      "title": "课程工程说明",
      "short": "课程工程说明",
      "file": "../course/README.md",
      "desc": "课程目录、运行方式、环境约定与代码组织。",
      "badge": "运行指南"
    }
  ],
  "lessons": {
    "s01-agent-loop": {
      "n": 1,
      "title": "agent loop",
      "short": "minimal loop",
      "desc": "一次真实文本 turn：turn/step、流式 chunk、取消与最小事件日志。",
      "part": "core",
      "difficulty": 2,
      "hours": "2–3h",
      "tests": "7 离线 + 1 live",
      "tags": [
        "turn/step",
        "stream",
        "cancel"
      ],
      "source": "core/agent-loop/src/agent.ts"
    },
    "s02-tool-round-trip": {
      "n": 2,
      "title": "tool round-trip",
      "short": "tool-call / result",
      "desc": "模型产出 tool-call，工具执行，结果回到下一步请求。",
      "part": "core",
      "difficulty": 2,
      "hours": "2–3h",
      "tests": "16 离线 + 2 live",
      "tags": [
        "tool call",
        "surface",
        "next step"
      ],
      "source": "core/agent-loop/src/agent.ts"
    },
    "s03-session-log": {
      "n": 3,
      "title": "session log",
      "short": "append-only + surface",
      "desc": "日志是事实，surface 是当前模型视图；replace 不删除历史。",
      "part": "core",
      "difficulty": 3,
      "hours": "3–4h",
      "tests": "12 离线 + 1 live",
      "tags": [
        "event sourcing",
        "surface",
        "replay"
      ],
      "source": "core/session/src/{index,surface}.ts"
    },
    "s04-streaming": {
      "n": 4,
      "title": "stream & attempt",
      "short": "chunk → attempt",
      "desc": "把 SSE chunk、attempt、usage、live 帧与取消前缀持久化。",
      "part": "core",
      "difficulty": 3,
      "hours": "3–4h",
      "tests": "12 离线 + 1 live",
      "tags": [
        "chunks",
        "attempt",
        "usage"
      ],
      "source": "llm/llm/src/{assembler,assistant-stream}.ts"
    },
    "s05-tool-contract": {
      "n": 5,
      "title": "tool contract",
      "short": "schema + output",
      "desc": "作者写 TypeScript，模型看 JSON Schema：参数、输出契约、scope。",
      "part": "core",
      "difficulty": 3,
      "hours": "3–4h",
      "tests": "11 离线 + 12 回归 + 1 live",
      "tags": [
        "schema",
        "inference",
        "scope"
      ],
      "source": "core/tools/src/{schema,contracts}.ts"
    },
    "s06-tool-runtime": {
      "n": 6,
      "title": "tool runtime",
      "short": "policy + batch",
      "desc": "一次工具调用的流水线：guard、审批、并发、超时、失败恢复。",
      "part": "core",
      "difficulty": 4,
      "hours": "4–5h",
      "tests": "11 离线 + 23 回归 + 1 live",
      "tags": [
        "guards",
        "approval",
        "batch"
      ],
      "source": "core/tools/src/{pipeline,batch}.ts"
    },
    "s07-system-prompt": {
      "n": 7,
      "title": "system prompt",
      "short": "sections + admission",
      "desc": "提示词组装：sections、variables、contexts、toolOrder、head 准入。",
      "part": "context",
      "difficulty": 4,
      "hours": "3–4h",
      "tests": "10 离线 + 44 回归 + 1 live",
      "tags": [
        "sections",
        "contexts",
        "KV cache"
      ],
      "source": "core/system-prompt/src/index.ts"
    },
    "s08-inbox-steering": {
      "n": 8,
      "title": "inbox / steering",
      "short": "next-turn / next-step",
      "desc": "运行中的 agent 如何接收输入：claim、注入、取消、whenIdle。",
      "part": "context",
      "difficulty": 3,
      "hours": "3–4h",
      "tests": "10 离线 + 54 回归 + 1 live",
      "tags": [
        "inbox",
        "steering",
        "cancel"
      ],
      "source": "core/agent-loop/src/{inbox,agent}.ts"
    },
    "s09-llm-seam": {
      "n": 9,
      "title": "LLM seam",
      "short": "provider + prepareCall",
      "desc": "provider 注册、prepareCall、能力协商、in-history 与重试。",
      "part": "context",
      "difficulty": 4,
      "hours": "4–5h",
      "tests": "8 离线 + 62 回归 + 1 live",
      "tags": [
        "provider",
        "capabilities",
        "retry"
      ],
      "source": "llm/llm/src/{call-config,retry-policy}.ts"
    },
    "s10-persistence": {
      "n": 10,
      "title": "persistence",
      "short": "JSONL + resume",
      "desc": "会话活过进程重启：JSONL、flush、截断修复、未闭合 turn、fork。",
      "part": "context",
      "difficulty": 4,
      "hours": "4–5h",
      "tests": "10 离线 + 72 回归 + 1 live",
      "tags": [
        "JSONL",
        "recovery",
        "fork"
      ],
      "source": "session/session-persistence/src/index.ts"
    },
    "s11-compaction": {
      "n": 11,
      "title": "compaction",
      "short": "prune + summarize",
      "desc": "有限上下文里继续工作：token 压力、裁剪、摘要、surface replace。",
      "part": "context",
      "difficulty": 4,
      "hours": "4–5h",
      "tests": "7 离线 + 79 回归 + 1 live",
      "tags": [
        "token meter",
        "prune",
        "summary"
      ],
      "source": "compaction/compaction-basic/src/index.ts"
    },
    "s12-plugin-kernel": {
      "n": 12,
      "title": "plugin kernel",
      "short": "Context / Fiber",
      "desc": "Context、Service、Fiber、effect、events、scope。",
      "part": "composition",
      "difficulty": 5,
      "hours": "5–6h",
      "tests": "8 离线 + 87 回归",
      "tags": [
        "Cordis",
        "Fiber",
        "waterfall"
      ],
      "source": "vendor/cordis/src/{context,fiber,events}.ts"
    },
    "s13-composition-boot": {
      "n": 13,
      "title": "composition / boot",
      "short": "profile / bundle / patch",
      "desc": "插件树如何组装：patch 分层、required entry、dump config。",
      "part": "composition",
      "difficulty": 4,
      "hours": "4–5h",
      "tests": "8 离线 + 95 回归",
      "tags": [
        "profiles",
        "patches",
        "boot"
      ],
      "source": "boot/app-boot, bundle/base"
    },
    "s14-capability-seams": {
      "n": 14,
      "title": "capability seams",
      "short": "fs / shell / sandbox",
      "desc": "让 agent 真正读写和执行：FS、Shell、沙箱、审批、路径边界。",
      "part": "execution",
      "difficulty": 5,
      "hours": "5–6h",
      "tests": "6 离线 + 101 回归",
      "tags": [
        "fs",
        "shell",
        "approval"
      ],
      "source": "fs/tool-fs, shell, sandbox"
    },
    "s15-subagents-presets": {
      "n": 15,
      "title": "subagents / presets",
      "short": "delegate + isolate",
      "desc": "委派子 agent：spawn、深度/并发预算、preset 工具子集。",
      "part": "execution",
      "difficulty": 5,
      "hours": "5–6h",
      "tests": "3 离线 + 104 回归 + 1 live",
      "tags": [
        "spawn",
        "budgets",
        "preset"
      ],
      "source": "subagent/subagent/src/manager.ts"
    },
    "s16-ptc": {
      "n": 16,
      "title": "PTC",
      "short": "programmatic tools",
      "desc": "模型写代码调用 tools.*：持久 scope、异步、超时、结果序列化。",
      "part": "execution",
      "difficulty": 4,
      "hours": "4–5h",
      "tests": "14 离线",
      "tags": [
        "run_code",
        "PTC",
        "tools"
      ],
      "source": "ptc-runtime/ptc-runtime"
    },
    "s17-mcp-skills-commands": {
      "n": 17,
      "title": "MCP / skills / commands",
      "short": "external capability",
      "desc": "stdio MCP 工具、skill catalog、slash command 直接分派。",
      "part": "execution",
      "difficulty": 4,
      "hours": "4–5h",
      "tests": "14 离线 + 108 回归",
      "tags": [
        "MCP",
        "skills",
        "commands"
      ],
      "source": "mcp/mcp-client, skill, interaction/commands"
    },
    "s18-skills-commands": {
      "n": 18,
      "title": "skills / commands",
      "short": "catalog + slash",
      "desc": "skill 目录按需加载；slash command 不产生模型轮次。",
      "part": "execution",
      "difficulty": 3,
      "hours": "4–5h",
      "tests": "10 离线",
      "tags": [
        "skills",
        "commands",
        "host"
      ],
      "source": "skill/skill, interaction/commands"
    },
    "s19-browser-use": {
      "n": 19,
      "title": "browser use",
      "short": "browser provider",
      "desc": "浏览器 provider registry：页面、DOM、点击、截图、session 隔离。",
      "part": "execution",
      "difficulty": 4,
      "hours": "5–6h",
      "tests": "8 离线",
      "tags": [
        "browser",
        "provider",
        "mock"
      ],
      "source": "browser-use/browser-use"
    },
    "s20-computer-use-i": {
      "n": 20,
      "title": "computer use I",
      "short": "app / window / AX",
      "desc": "CUA provider、应用/窗口、AX 快照、截图与授权。",
      "part": "execution",
      "difficulty": 5,
      "hours": "5–6h",
      "tests": "10 离线",
      "tags": [
        "CUA",
        "macOS",
        "AX"
      ],
      "source": "computer-use/computer-use, experimental/cua"
    },
    "s21-computer-use-ii": {
      "n": 21,
      "title": "computer use II",
      "short": "actions + permissions",
      "desc": "坐标、动作、快照失效、持久/会话授权、多模态附件。",
      "part": "execution",
      "difficulty": 5,
      "hours": "5–6h",
      "tests": "12 离线",
      "tags": [
        "actions",
        "coordinates",
        "permissions"
      ],
      "source": "experimental/cua-macos, cua"
    },
    "s22-web": {
      "n": 22,
      "title": "web",
      "short": "projection + SSE",
      "desc": "session projection、快照 + 增量、SSE 重连与多客户端。",
      "part": "product",
      "difficulty": 4,
      "hours": "4–5h",
      "tests": "2 离线 + 110 回归",
      "tags": [
        "projection",
        "SSE",
        "reconnect"
      ],
      "source": "session/session-projection, host/webserver"
    },
    "s23-sdk-headless": {
      "n": 23,
      "title": "SDK / headless",
      "short": "JSON-RPC over stdio",
      "desc": "newline JSON-RPC、session/create、prompt、事件通知。",
      "part": "product",
      "difficulty": 4,
      "hours": "4–5h",
      "tests": "3 离线 + 113 回归 + 1 live",
      "tags": [
        "JSON-RPC",
        "stdio",
        "SDK"
      ],
      "source": "sdk/protocol, sdk/server"
    },
    "s24-client-ui": {
      "n": 24,
      "title": "client UI",
      "short": "action cards",
      "desc": "把事件投影成工具卡、审批卡、错误卡和断线恢复后的状态。",
      "part": "product",
      "difficulty": 3,
      "hours": "4–5h",
      "tests": "11 离线",
      "tags": [
        "projection",
        "action cards",
        "UI"
      ],
      "source": "client/ui-renderer"
    },
    "s25-observability-eval": {
      "n": 25,
      "title": "observability / eval",
      "short": "spans + snapshots",
      "desc": "span、record/replay、session snapshot、故障注入。",
      "part": "quality",
      "difficulty": 4,
      "hours": "4–5h",
      "tests": "4 离线 + 117 回归 + 1 live",
      "tags": [
        "telemetry",
        "replay",
        "snapshot"
      ],
      "source": "telemetry/otel, snapshots"
    },
    "s26-eval": {
      "n": 26,
      "title": "eval / fault injection",
      "short": "scenario + replay",
      "desc": "可重复 scenario runner：录制、回放、快照 diff、故障矩阵。",
      "part": "quality",
      "difficulty": 4,
      "hours": "4–5h",
      "tests": "9 离线",
      "tags": [
        "eval",
        "fault",
        "replay"
      ],
      "source": "docs/testing.zh.md, snapshots"
    },
    "s27-security": {
      "n": 27,
      "title": "security / permissions",
      "short": "fail closed",
      "desc": "路径逃逸、审批 fail-closed、redaction、输出截断、CUA 授权。",
      "part": "quality",
      "difficulty": 4,
      "hours": "4–5h",
      "tests": "17 离线",
      "tags": [
        "security",
        "approval",
        "redaction"
      ],
      "source": "sandbox, interaction/user-approval"
    },
    "s28-capstone": {
      "n": 28,
      "title": "capstone",
      "short": "full harness",
      "desc": "真实模型多工具任务 + 事件日志 + surface 摘要 + 评测报告。",
      "part": "quality",
      "difficulty": 5,
      "hours": "6–8h",
      "tests": "8 离线 + 1 live",
      "tags": [
        "capstone",
        "eval",
        "real task"
      ],
      "source": "core/agent-loop/src/agent.ts"
    }
  }
};
