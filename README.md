# Learn DeepSeek Harness

这是 `deepseek-harness` 的源码学习项目：**先读懂真实架构，再用 18 课从零重写一个 mini harness**。

- 上游源码（本地 clone，不随仓库提交）：`deepseek-harness/`，版本 `0.2.2-alpha.2`
- 架构阅读笔记：[`docs/00-architecture.zh.md`](docs/00-architecture.zh.md)
- 课程设计（18 课）：[`docs/01-course-design.zh.md`](docs/01-course-design.zh.md)
- 课程工程：[`course/`](course/README.md)
- 课程网站：[`site/`](site/README.md)（`node site/serve.mjs`）
- 第 1 课：[`s01 · agent loop`](course/lessons/s01-agent-loop/README.md)
- 第 2 课：[`s02 · session log`](course/lessons/s02-session-log/README.md)
- 第 3 课：[`s03 · streaming`](course/lessons/s03-streaming/README.md)
- 第 4 课：[`s04 · tools`](course/lessons/s04-tools/README.md)
- 第 5 课：[`s05 · tool pipeline`](course/lessons/s05-tool-pipeline/README.md)
- 第 6 课：[`s06 · system prompt`](course/lessons/s06-system-prompt/README.md)
- 第 7 课：[`s07 · inbox / steering`](course/lessons/s07-inbox-steering/README.md)
- 第 8 课：[`s08 · LLM seam`](course/lessons/s08-llm-seam/README.md)
- 第 9 课：[`s09 · persistence`](course/lessons/s09-persistence/README.md)
- 第 10 课：[`s10 · compaction`](course/lessons/s10-compaction/README.md)
- 第 11 课：[`s11 · plugin kernel`](course/lessons/s11-plugin-kernel/README.md)
- 第 12 课：[`s12 · composition / boot`](course/lessons/s12-composition-boot/README.md)
- 第 13 课：[`s13 · capability seams`](course/lessons/s13-capability-seams/README.md)
- 第 14 课：[`s14 · subagents / presets`](course/lessons/s14-subagents-presets/README.md)
- 第 15 课：[`s15 · MCP / skills / commands`](course/lessons/s15-mcp-skills-commands/README.md)
- 第 16 课：[`s16 · web`](course/lessons/s16-web/README.md)
- 第 17 课：[`s17 · SDK / headless`](course/lessons/s17-sdk-headless/README.md)
- 第 18 课：[`s18 · observability / eval`](course/lessons/s18-observability-eval/README.md)


## 快速开始

```sh
cd course/lessons/s01-agent-loop
cp env.example .env          # 填入 DEEPSEEK_API_KEY
node src/demo.ts             # 真实 DeepSeek 跑一次工具调用
node --test tests/s01.test.ts # 离线单元测试，不需要 key
```

不需要 `pnpm install`，Node ≥ 24 直接运行 TypeScript。每课都是自包含文件夹：`README.md`、`src/`、`tests/`、`env.example` 都在该课目录内。

开源仓库**不包含**上游 `deepseek-harness/` 和本地练习目录 `course/practice/`。要读真实源码时，在本机单独 clone：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git deepseek-harness
```

课程代码和离线测试不依赖这个目录；它只用于对照阅读。

Demo 会打印一次真实 turn 的完整事件序列：

```text
turn/start
step/start
user/message
request/header
assistant/message
tool/call
tool/result
step/end
step/start
assistant/message
step/end
turn/end
```

## 仓库结构

```text
docs/               架构阅读笔记与课程设计
course/lessons/     18 课自包含代码、测试、讲义
course/practice/    本地私有练习（不提交）
site/               课程网站（Markdown 阅读模式）
deepseek-harness/   上游源码 clone（不提交，仅本地阅读）
```

仓库只提交源码：站点不提交 `content.js` 或讲义副本，运行时直接读取 Markdown；仅保留 `docs/assets/course-home.png` 一张首页截图用于文档预览。

## 安全与隐私

- **不要提交 `.env`**。每课的 `env.example` 只有占位符；真实 key 放在本地 `.env`，该文件已被 `.gitignore` 忽略。
- 如果 key 曾经被提交或推到远端：立刻在 provider 侧吊销/轮换，再清理 Git 历史；不要只删当前文件。
- 本仓库忽略 `deepseek-harness/`（第三方 checkout）与 `course/practice/`（个人练习），二者只在你本机存在。
- 课程 demo 会真实执行 shell、写文件、调用模型。请在没有敏感数据的临时工作区运行；mini harness 不是安全沙箱。
- 安全问题请按 [`SECURITY.md`](SECURITY.md) 私下报告，不要开公开 issue。

## 这个项目回答什么

1. 一个生产级 coding agent 的 **agent loop** 到底长什么样？为什么不是「调模型 + 跑工具」的 while 循环？
2. 为什么 DSH 把 **append-only 会话日志** 当作唯一真源，而不是维护 `messages` 数组？
3. 工具、提示词、模型、沙箱、子 agent、UI 如何通过 **capability seam** 和 **插件树** 组合，而不是互相 import？
4. 取消、重试、压缩、恢复、并发、审批这些「工程细节」如何变成可验证的契约？
5. 如何把这些设计**亲手实现一遍**，而不是只读不写？

## 文档地图

| 文档 | 内容 |
|---|---|
| [`docs/00-architecture.zh.md`](docs/00-architecture.zh.md) | 20 节架构阅读笔记：运行时、包地图、Cordis、turn 时序、会话日志、loop、工具、提示词、LLM seam、能力 seam、扩展面、传输、横切关注点、设计模式、阅读路线、文件索引 |
| [`docs/01-course-design.zh.md`](docs/01-course-design.zh.md) | 18 课设计：设计原则、课程地图、每课目标/源码锚点/产出/验收、与真实 DSH 的差异 |
| [`course/README.md`](course/README.md) | 课程工程说明、运行方式、代码约定 |
| [`course/lessons/`](course/lessons) | 18 课自包含讲义：每课 README 含源码阅读路径、实现说明、验收、练习与带答案的思考题 |

## 课程网站

`site/` 是随仓库一起开源的网站源码，clone 后无需构建；18 课有一个可浏览版本：

```sh
node site/serve.mjs
# http://127.0.0.1:4173/site/
```

站点直接读取 `course/lessons/*/README.md` 与 `docs/*.md`，不提交打包后的讲义副本或 bundle；只保留一张首页截图用于文档预览。必须通过本地服务器访问；站点包含课程地图、讲义阅读页、页内目录、学习进度、搜索与深浅色主题，说明见 [`site/README.md`](site/README.md)。

![课程首页截图](docs/assets/course-home.png)

## 课程进度

| 课 | 主题 | 状态 |
|---|---|---|
| s01 | agent loop | ✅ 已完成（自包含课程 + 16 离线测试 + 2 live 测试 + demo） |
| s02 | session log | ✅ 已完成（surface/replay + 12 离线 + 1 live 测试） |
| s03 | streaming | ✅ 已完成（持久 stream/attempt + 12 离线 + 1 live 测试） |
| s04 | tools | ✅ 已完成（schema/ToolSet + 11 离线 + 12 回归 + 1 live） |
| s05 | tool pipeline | ✅ 已完成（pipeline/batch/recovery + 11 离线 + 23 回归 + 1 live） |
| s06 | system prompt | ✅ 已完成（prompt/准入 + 10 离线 + 44 回归 + 1 live） |
| s07 | inbox / steering | ✅ 已完成（inbox/steering + 10 离线 + 54 回归 + 1 live） |
| s08 | LLM seam | ✅ 已完成（provider/prepareCall/retry + 8 离线 + 54 回归 + 1 live） |
| s09 | persistence | ✅ 已完成（JSONL/resume/fork + 10 离线 + 72 回归 + 1 live） |
| s10 | compaction | ✅ 已完成（prune/summary/replace + 7 离线 + 79 回归 + 1 live） |
| s11 | plugin kernel | ✅ 已完成（Context/Fiber/events/scope + 8 离线） |
| s12 | composition / boot | ✅ 已完成（patch/boot + 8 离线） |
| s13 | capability seams（fs/shell/sandbox/approval） | ✅ 已完成（fs/shell/approval + 6 离线） |
| s14 | subagents / presets | ✅ 已完成（spawn/预算/preset + 3 离线 + 1 live） |
| s15 | MCP / skills / commands | ✅ 已完成（MCP/skill/command + 4 离线） |
| s16 | web（projection + SSE） | ✅ 已完成（projection/SSE + 2 离线） |
| s17 | SDK / headless | ✅ 已完成（JSON-RPC + 3 离线 + 1 live） |
| s18 | observability / eval | ✅ 已完成（telemetry/replay/snapshot + 4 离线 + 1 live） |

## 建议的阅读顺序

如果你只有几个小时：

1. 读 [`00-architecture.zh.md`](docs/00-architecture.zh.md) 的第 1、2、5、6、7、8 节。
2. 跑 `course/lessons/s01-agent-loop/src/demo.ts`，对照事件日志读第 1 课讲义。
3. 读 `deepseek-harness/packages/core/agent-loop/src/agent.ts` 的 `turn()`、`preStep()`、`step()`。
4. 做第 1 课的练习 1 和 3。

如果你有一周：

- 按 18 课顺序，每课 2-4 小时；每 3 课做一次「不看讲义重写」。
- 最后用第 18 课的 mini harness 跑一个真实任务（读写文件、跑测试、修复 bug），和真实 `dsh --profile headless` 的输出对照。

## 已确定的结构约定

- 每课一个自包含目录：`course/lessons/sNN-<slug>/`，内含 `README.md`、`src/`、`tests/`、`env.example`。
- 课程代码按课复制并增量演进，后一课是前一课的完整快照；任意一课都能单独运行。
- 模型一律使用真实 DeepSeek（`DEEPSEEK_API_KEY`），不再内置假模型。
- 运行时零依赖，Node 24 原生 TypeScript；离线单元测试不访问网络，`live.test.ts` 在缺少 key 时自动跳过。

## 上游与许可

- 上游项目：[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（MIT）。本课程是独立的学习用重写，不是上游官方文档，也不代表上游立场。
- 本仓库课程代码、讲义与网站采用 [MIT License](LICENSE)；上游版权与许可见 [`LICENSE-UPSTREAM`](LICENSE-UPSTREAM) 与 [`NOTICE`](NOTICE)。
- 欢迎贡献：先读 [`CONTRIBUTING.md`](CONTRIBUTING.md)；提交前不要带 `.env`、`deepseek-harness/` 或 `course/practice/`。
