# Learn DeepSeek Harness · 28 课知识导图

## I · 内核

- **s01 agent loop**
  - 问题：minimal loop
  - 机制：turn/step / stream / cancel
  - 代码：core/agent-loop/src/agent.ts
- **s02 tool round-trip**
  - 问题：tool-call / result
  - 机制：tool call / surface / next step
  - 代码：core/agent-loop/src/agent.ts
- **s03 session log**
  - 问题：append-only + surface
  - 机制：event sourcing / surface / replay
  - 代码：core/session/src/{index
- **s04 stream & attempt**
  - 问题：chunk → attempt
  - 机制：chunks / attempt / usage
  - 代码：llm/llm/src/{assembler
- **s05 tool contract**
  - 问题：schema + output
  - 机制：schema / inference / scope
  - 代码：core/tools/src/{schema
- **s06 tool runtime**
  - 问题：policy + batch
  - 机制：guards / approval / batch
  - 代码：core/tools/src/{pipeline

## II · 上下文

- **s07 system prompt**
  - 问题：sections + admission
  - 机制：sections / contexts / KV cache
  - 代码：core/system-prompt/src/index.ts
- **s08 inbox / steering**
  - 问题：next-turn / next-step
  - 机制：inbox / steering / cancel
  - 代码：core/agent-loop/src/{inbox
- **s09 LLM seam**
  - 问题：provider + prepareCall
  - 机制：provider / capabilities / retry
  - 代码：llm/llm/src/{call-config
- **s10 persistence**
  - 问题：JSONL + resume
  - 机制：JSONL / recovery / fork
  - 代码：session/session-persistence/src/index.ts
- **s11 compaction**
  - 问题：prune + summarize
  - 机制：token meter / prune / summary
  - 代码：compaction/compaction-basic/src/index.ts

## III · 组合

- **s12 plugin kernel**
  - 问题：Context / Fiber
  - 机制：Cordis / Fiber / waterfall
  - 代码：vendor/cordis/src/{context
- **s13 composition / boot**
  - 问题：profile / bundle / patch
  - 机制：profiles / patches / boot
  - 代码：boot/app-boot

## IV · 执行边界

- **s14 capability seams**
  - 问题：fs / shell / sandbox
  - 机制：fs / shell / approval
  - 代码：fs/tool-fs
- **s15 subagents / presets**
  - 问题：delegate + isolate
  - 机制：spawn / budgets / preset
  - 代码：subagent/subagent/src/manager.ts
- **s16 PTC**
  - 问题：programmatic tools
  - 机制：run_code / PTC / tools
  - 代码：ptc-runtime/ptc-runtime
- **s17 MCP / skills / commands**
  - 问题：external capability
  - 机制：MCP / skills / commands
  - 代码：mcp/mcp-client
- **s18 skills / commands**
  - 问题：catalog + slash
  - 机制：skills / commands / host
  - 代码：skill/skill
- **s19 browser use**
  - 问题：browser provider
  - 机制：browser / provider / mock
  - 代码：browser-use/browser-use
- **s20 computer use I**
  - 问题：app / window / AX
  - 机制：CUA / macOS / AX
  - 代码：computer-use/computer-use
- **s21 computer use II**
  - 问题：actions + permissions
  - 机制：actions / coordinates / permissions
  - 代码：experimental/cua-macos

## V · 产品面

- **s22 web**
  - 问题：projection + SSE
  - 机制：projection / SSE / reconnect
  - 代码：session/session-projection
- **s23 SDK / headless**
  - 问题：JSON-RPC over stdio
  - 机制：JSON-RPC / stdio / SDK
  - 代码：sdk/protocol
- **s24 client UI**
  - 问题：action cards
  - 机制：projection / action cards / UI
  - 代码：client/ui-renderer

## VI · 质量

- **s25 observability / eval**
  - 问题：spans + snapshots
  - 机制：telemetry / replay / snapshot
  - 代码：telemetry/otel
- **s26 eval / fault injection**
  - 问题：scenario + replay
  - 机制：eval / fault / replay
  - 代码：docs/testing.zh.md
- **s27 security / permissions**
  - 问题：fail closed
  - 机制：security / approval / redaction
  - 代码：sandbox
- **s28 capstone**
  - 问题：full harness
  - 机制：capstone / eval / real task
  - 代码：core/agent-loop/src/agent.ts
