# s15 · MCP / skills / commands：不修改 loop 的扩展

> 本课代码：`src/mcp.ts`、`src/skills/catalog.ts`、`src/commands/registry.ts`、`src/mock-mcp-server.ts`
>
> 测试：`tests/s15.test.ts`（4 个离线用例）+ s14 回归
>
> 本课不调用模型；重点是三种「不碰 loop」的扩展面。

---

## 0. 先跑起来

```sh
cd course/lessons/s15-mcp-skills-commands
node src/demo.ts
node --test tests/s15.test.ts
```

Demo 会：

1. spawn 一个 mock MCP server，列出并调用 `echo`；
2. 扫描临时 skill 目录，打印 catalog 和按需加载的正文；
3. 分派 `/help`，并确认普通输入不当作命令。

---

## 1. 这一课要回答的问题

1. MCP 工具如何发现、命名、执行？
2. 外部工具的错误如何映射成模型可见结果？
3. skill 目录如何注入、何时加载正文？
4. slash command 为什么不走模型？
5. 这三种扩展为什么都不需要改 agent loop？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`mcp-client`](../../../deepseek-harness/packages/mcp/mcp-client/src/index.ts) | stdio JSON-RPC、初始化、工具列表？ | Q1 / Q2 |
| 2 | [`tool-mcp`](../../../deepseek-harness/packages/mcp/mcp-client/src/index.ts) | 工具如何前缀命名、避免冲突？ | Q1 |
| 3 | [`skill`](../../../deepseek-harness/packages/skill/skill/src/index.ts) | catalog 与按需加载的分工？ | Q3 |
| 4 | [`commands`](../../../deepseek-harness/packages/interaction/commands/src/index.ts) | 命令为什么直接分派？ | Q4 |
| 5 | [`extension-cookbook`](../../../deepseek-harness/docs/cookbook/extension-cookbook.zh.md) | 新能力挂在哪里？ | Q5 |

---

## 3. 核心概念

### 3.1 MCP

MCP 是外部工具协议：

```text
initialize
tools/list  → [{name, description, inputSchema}]
tools/call  → {content: [{type:'text',text}], isError?}
```

工具名加 `mcp__<server>__<tool>` 前缀，避免与原生工具冲突；schema 直接来自 server，执行结果转成模型可见内容，错误变成 `Error:` 结果。

### 3.2 skills

skill 是「可复用指令包」：

- `SKILL.md` 带 frontmatter（name/description）；
- 启动时只把 catalog 注入上下文；
- 模型需要时再 `load(name)` 读正文。

这样避免把所有技能正文一次性塞进提示词。

### 3.3 commands

slash command 是用户界面操作：

- `/help`、`/compact`、`/model`；
- 直接分派到 host 逻辑，不产生模型轮次；
- 普通输入才进入 agent。

---

## 4. 本课实现

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/mcp.ts`](src/mcp.ts) | stdio JSON-RPC client + 工具投影 | `mcp-client` / `tool-mcp` |
| [`src/mock-mcp-server.ts`](src/mock-mcp-server.ts) | 测试用 MCP server | — |
| [`src/skills/catalog.ts`](src/skills/catalog.ts) | 扫描/目录/按需加载 | `skill` |
| [`src/commands/registry.ts`](src/commands/registry.ts) | 命令注册与分派 | `commands` |

---

## 5. 验收

| 测试 | 证明 |
|---|---|
| MCP list/call | initialize、echo |
| MCP unknown | 错误传播 |
| skills | frontmatter、catalog、load |
| commands | 直接分派、普通输入透传 |

---

## 6. 刻意简化了什么

| 真实 DSH | s15 | 影响 |
|---|---|---|
| MCP 多 transport / resources/prompts | 只有 stdio tools | 教学 |
| 工具 schema 转换 | 直接使用 inputSchema | 未做 DSL 校验 |
| skill 依赖/权限 | 只有 catalog/load | 后续 |
| 命令 UI/参数补全 | 简单注册表 | 后续 |
| 断线重连/超时 | 基础 timeout | 够用 |

---

## 7. 练习

1. **MCP 断线重连**：server 退出后自动重启并重新 initialize。
2. **工具命名冲突**：两个 server 同名工具，验证前缀隔离。
3. **skill 按需加载**：在 agent 工具里实现 `load_skill(name)`，只返回正文。
4. **命令权限**：`/compact` 只允许 owner，`/help` 所有人可用。
5. **MCP 错误映射**：把 `isError` 内容转成 `tool/result {isError:true}`。

---

## 8. 思考题（附源码位置与答案）

### Q1. MCP 工具如何发现、命名、执行？

initialize 后 `tools/list` 获取 schema；工具名加 server 前缀避免冲突；执行时 `tools/call`，结果内容投影成模型可见文本。

见 [`mcp-client`](../../../deepseek-harness/packages/mcp/mcp-client/src/index.ts)。

### Q2. 外部工具错误如何映射？

JSON-RPC error 或 `isError` 结果都转成 `ToolResult {isError:true}`，模型看到 `Error: ...`，可以决定换工具或重试。

### Q3. skill 目录如何注入、何时加载正文？

启动时扫描 frontmatter，只注入 `name: description` catalog；模型显式请求时再读正文，避免一次性占用上下文。

见 [`skill`](../../../deepseek-harness/packages/skill/skill/src/index.ts)。

### Q4. slash command 为什么不走模型？

命令是确定性的 UI 操作：切换模型、压缩、帮助。交给模型既慢又不可靠；直接分派到 host 逻辑更合适。

见 [`commands`](../../../deepseek-harness/packages/interaction/commands/src/index.ts)。

### Q5. 为什么这些扩展不需要改 loop？

它们都挂在既有扩展点：MCP 注册成工具、skill 贡献 context、command 走 host。loop 只看到工具/上下文，不需要知道来源。

见 [`extension-cookbook`](../../../deepseek-harness/docs/cookbook/extension-cookbook.zh.md)。

---

## 9. 下一课：s16 · web

s15 接入了外部能力。s16 会把状态送到浏览器：

- session projection 如何折叠事件？
- 为什么客户端不自己 fold？
- SSE 快照 + 增量如何配合？
- 断线重连如何从 seq 恢复？
- 多客户端如何保持一致？

先读：[`session-projection`](../../../deepseek-harness/packages/session/session-projection/src/index.ts) 与 [`host/webserver`](../../../deepseek-harness/packages/host/webserver/src/index.ts)。
