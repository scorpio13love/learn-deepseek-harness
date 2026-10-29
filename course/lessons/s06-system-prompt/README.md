# s06 · system prompt：sections、variables、contexts 与准入

> 本课代码：`src/`（新增 `prompt.ts`；`agent.ts` 接入提示词组装与 head 替换）
>
> 测试：`tests/s06.test.ts`（10 个离线用例）+ s03/s04/s05 回归（34 个）+ `tests/live.test.ts`（1 个真实模型用例）
>
> 模型：真实 DeepSeek，默认 `deepseek-flash`。

---

## 0. 先跑起来

```sh
cd course/lessons/s06-system-prompt

cp env.example .env
# 编辑 .env，至少填入 DEEPSEEK_API_KEY

node src/demo.ts
node --test tests/s06.test.ts
node --test tests/s05-regression.test.ts tests/s04-regression.test.ts tests/s03-regression.test.ts
node --test tests/live.test.ts     # 需要 key

# 可选：类型检查
npm install
npm run typecheck
```

Demo 会先打印组装后的提示词，再让真实模型调用 calc：

```text
--- rendered prompt ---
You are an AI agent powered by DeepSeek Harness.

You are terse. Answer in Chinese.

Prefer the calc tool for arithmetic. Never use eval.
--- runtime contexts ---
[ 'Current working directory: ...' ]

#02 system/message     You are an AI agent powered by DeepSeek Harness....
#03 user/message       请使用 calc...
#04 user/message       Current working directory: ...
```

---

## 1. 这一课要回答的问题

1. 为什么系统提示词不是一个字符串常量，而是一组可注册的 section？
2. section 的 order、complete、变量插值分别解决什么问题？
3. 运行时上下文（cwd、时间、AGENTS.md）为什么变成 user 消息，而不是 system 文本？
4. 工具 schema 为什么和提示词一起组装？
5. 提示词变化时，为什么替换 head，而不是追加一条新的 system 消息？
6. 空提示词为什么也要写一个 `system/message` 节点？
7. 这些选择对 KV cache 有什么影响？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`system-prompt.zh.md`](../../../deepseek-harness/docs/subsystems/system-prompt.zh.md) | 提示词组装由哪些输入组成？ | Q1 |
| 2 | [`core/system-prompt/src/index.ts`](../../../deepseek-harness/packages/core/system-prompt/src/index.ts) | sections/contexts/tools 如何合并与排序？ | Q2 / Q3 / Q4 |
| 3 | [`assemble()`](../../../deepseek-harness/packages/core/system-prompt/src/index.ts) | 为什么 assemble 与 render 分成两步？ | Q3 / Q6 |
| 4 | [`renderPrompt()`](../../../deepseek-harness/packages/core/system-prompt/src/index.ts) | 未知变量为什么抛错，而不是留空？ | Q3 |
| 5 | [`agent-loop` prompt admission](../../../deepseek-harness/packages/core/agent-loop/README.md#understand-the-implementation) | in-history 与替换 head 的差别？ | Q7 / Q10 |
| 6 | [`agent.ts` → `step()`](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L435) | system 与 user 的写入顺序？ | Q7 |
| 7 | [`session/types.ts` → `system/message`](../../../deepseek-harness/packages/core/session/src/types.ts#L338) | 空 system 节点为什么保留？ | Q8 |
| 8 | [`GenerateOptions`](../../../deepseek-harness/packages/llm/llm/src/types.ts#L555) | 为什么 loop 构造的请求没有 `system` 字段？ | Q4 / Q10 |

读完后，你应该能画出：

```text
sections (order) ─┐
variables ────────┼─▶ assemble() ──▶ waterfall ──▶ assembly
contexts (order) ─┤                                  │
tools (toolOrder) ┘                                  ├─ renderPrompt() ──▶ system/message
                                                     └─ renderContexts() ─▶ user/message
```

---

## 3. 核心概念

### 3.1 提示词是组装结果，不是常量

```ts
prompt.section({ name: 'identity', order: -1000, text: 'You are an AI agent...' })
prompt.section({ name: 'persona', order: 0, text: 'Answer in {{language}}.' })
prompt.variable('language', 'Chinese')
prompt.context({ name: 'workspace', order: 0, text: 'cwd={{cwd}}' })
```

- **section**：提示词文本，按 `order` 升序拼接；同序按 name；
- **variable**：`{{name}}` 插值，每次 assemble 重新解析；
- **context**：动态运行时事实，最终成为 user-role 快照；
- **tools**：本步准入的工具 schema，和提示词一起组装。

### 3.2 complete section

一个标了 `complete: true` 的 section 会成为**唯一**提示词，其他 section 被忽略。多个生效的 complete section 会让组装失败。

这用于「部署完全接管提示词」的场景：不想让内置 identity/persona 混进来。

### 3.3 assemble 与 render 分开

- `assemble()`：合并输入、排序、解析变量、跑 waterfall，返回**未插值**的文本；
- `renderPrompt()`：插值、丢弃空 section、用空行连接。

分开的原因：waterfall 监听器可以检查/替换 section 文本，但插值应该发生在最终渲染；同一个 assembly 可以渲染多次（例如预览与实际请求）。

### 3.4 contexts 为什么是 user 消息

系统提示词是「模型必须遵守的指令」，运行时上下文是「当前会话的事实」：cwd、时间、AGENTS.md、技能目录。后者可能变化，放在 user-role 快照里更自然，也不污染 system 指令。

真实 DSH 把它们记为带 source 的 user 消息；s06 用一条拼接的 user 消息演示。

### 3.5 工具顺序

`toolOrder` 控制模型看到的工具声明顺序。注册顺序是插件加载的副产物，不应该泄漏到模型；显式顺序让 KV cache 和快照稳定。

s06 要求恰好一个 `'<unlisted-tools>'` 作为剩余项；列出的工具必须存在，否则组装失败。

### 3.6 提示词准入

s06 的 agent 在第一次请求前：

```ts
session.append('system/message', { message: systemMessage }, { surfaceOp: 'append' })
```

后续步骤如果提示词变化：

```ts
session.append('system/message', { message: newSystemMessage }, {
  surfaceOp: { op: 'replace', startSeq: previous, endSeq: previous },
  sourceEventSeqs: [previous],
})
```

替换 head 而不是追加，保证 system 节点始终在用户消息之前；原始旧节点仍在日志里，可审计。真实 DSH 还支持 `in-history` 路由：提示词更新可以追加在缓存历史之后，以保留前缀缓存。

---

## 4. 本课实现

### 4.1 文件地图

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/prompt.ts`](src/prompt.ts) | section/context/variable 注册、assemble、render、waterfall、toolOrder | `core/system-prompt/src/index.ts` |
| [`src/agent.ts`](src/agent.ts) | `#admitPrompt` 写 head、变化时 replace、context 写 user | `agent-loop/src/agent.ts` |
| [`src/demo.ts`](src/demo.ts) | 组装预览 + 真实模型调用 | — |

### 4.2 assemble

```ts
const variables = { provider, model, ...registered }
const sections = sorted(sections)
const complete = sections.filter(s => s.complete)
if (complete.length > 1) throw
let assembly = {
  sections: complete.length === 1 ? [complete[0]] : sections,
  contexts: sorted(contexts),
  variables,
  tools: orderTools(toolSet.schemas()),
}
assembly = await waterfall(assembly)
return assembly
```

### 4.3 render

```ts
if (complete) return interpolate(complete.text)
return sections
  .map(s => interpolate(s.text))
  .filter(text => text.length > 0)
  .join('\n\n')
```

未知变量抛错；`interpolate: false` 保留字面量。

### 4.4 agent 的 head 准入

- 第一次：append `system/message`（即使空文本，也保留 node 0）；
- 后续变化：replace 上一个 system 节点；
- 未变化：不写事件；
- context：只在第一步、user 消息之后写一条 user 快照。

---

## 5. 验收

离线（`tests/s06.test.ts`）：

| 测试 | 证明 |
|---|---|
| sections | order + name 排序、变量插值 |
| complete | 唯一提示词、多个 complete 报错 |
| unknown variable | 渲染失败、`interpolate:false` 保留字面量 |
| contexts | 排序、空段落丢弃、合成 user 消息 |
| toolOrder | rest 项、重复、未知工具 |
| waterfall | 观察/替换 assembly |
| disposers | section/variable 注销 |
| agent head | system 在首个 user 之前，context 跟随 |
| head replace | 第二次提示词变化替换 surface head，旧事件保留 |
| empty prompt | 保留空 system 节点，派生历史无 system |

回归：s03/s04/s05 共 34 个用例全部保留。

真实模型：真实 `deepseek-flash` + prompt + context，system 事件、header 工具、stream、重放、压缩。

---

## 6. 刻意简化了什么

| 真实 DSH | s06 | 影响 |
|---|---|---|
| agent/preset 作用域遮蔽 | 全局注册 | s11/s14 |
| 动态 context 抑制器 | 无 | 后续 |
| `refreshContext()` | 无 | s10 |
| `in-history` 路由能力 | 只演示替换 head | s08 |
| complete group 的复杂插值规则 | 单 complete section | 教学够用 |
| 工具增删的 developer/message | 无 | s08 |
| 变量值来自 provider 能力 | 只有 provider/model 内置 | s08 |

---

## 7. 练习

### 1. 加一个时间上下文

实现 `context`：

- 文本 `Current time: {{time}}`；
- `time` 是函数，每次 assemble 返回当前 ISO 时间；
- 验证两次 assemble 的值不同；
- 思考：为什么时间不应该放进 system section？

### 2. 动态工具说明

用 `onAssemble` 监听器：

- 当 toolSet 包含 `calc` 时追加一段「优先用 calc」；
- 不包含时追加「不要编造计算」；
- 验证 waterfall 能看到 tools。

### 3. 完整提示词模式

用 `complete: true`：

- 部署提供完整提示词；
- 内置 identity/persona 被忽略；
- 工具 schema 仍然存在；
- 写测试验证。

### 4. 提示词变更的 KV cache

要求：

- 连续两轮，第一轮提示词 A，第二轮提示词 B；
- 观察 surface head 被替换，日志里有两条 system 事件；
- 解释为什么「替换 head」会让前缀缓存从第一个 token 失效；
- 如果路由支持 `in-history`，你会怎么改？

### 5. 上下文去重

当前 context 只在第一步写。要求：

- 当 context 文本变化时，在下一步追加一条新的 user 快照；
- 未变化时不写；
- 思考：这会不会破坏工具调用的相邻性？

---

## 8. 思考题（附源码位置与答案）

### Q1. 为什么系统提示词不是一个字符串常量？

因为提示词由多个来源组成：身份、persona、工具指引、部署配置、运行时事实。用注册表 + order + waterfall 组装，才能让插件增量贡献、替换、测试，而不是改一个巨大的字符串。

见 [`system-prompt.zh.md`](../../../deepseek-harness/docs/subsystems/system-prompt.zh.md)。

### Q2. section 的 order、complete 分别解决什么？

- `order`：让贡献者声明相对位置，而不是依赖注册顺序；
- `complete`：允许部署完全接管提示词，忽略其他 section；多个 complete 同时生效会让 assembly 失败，避免歧义。

见 `assemble()` 与 `renderPrompt()`。

### Q3. 变量为什么每次 assemble 重新解析？未知变量为什么报错？

变量可能依赖当前 provider/model、运行时事实或插件状态；每次解析才能反映变化。未知变量意味着提示词会带着 `{{name}}` 字面量发给模型，模型可能照抄；响亮失败比发送坏提示词更好。

见 `renderPrompt()` 与 `interpolate()`。

### Q4. contexts 和 sections 的区别？为什么 context 变成 user 消息？

- section 是「指令」，进入 system 提示词；
- context 是「当前会话的事实」，进入 user-role 快照。

事实会变化，且应该带有来源（cwd、时间、AGENTS.md），适合作为 user 消息；指令是部署级配置，适合 system。

见 [`system/message`](../../../deepseek-harness/packages/core/session/src/types.ts#L338) 与 `renderContextMessage()`。

### Q5. toolOrder 为什么需要 rest 项？

工具集合是动态的；rest 项表示「未列出的工具按剩余顺序放在这里」。没有 rest，新增工具会被静默丢弃；有 rest，顺序可控且不丢工具。

s06 要求恰好一个 rest，并在列出的工具不存在时报错。

### Q6. assemble waterfall 能做什么？为什么是 waterfall？

监听器可以观察/改写 section、context、变量、工具，然后调用 `next()` 委托下游。waterfall 适合「包装整个组装结果」：策略插件可以在最外层追加安全指令，内层再渲染。

见 `SystemPrompt.onAssemble()`。

### Q7. 提示词变化时为什么替换 head，而不是追加？

system 节点必须在用户消息之前，模型才会把它当成系统指令；追加到历史末尾会变成普通消息。替换 head 保持位置不变；旧节点仍在日志里，可审计。

真实 DSH 的 `in-history` 路由是例外：它允许提示词更新追加在缓存历史之后，以保留前缀缓存。

见 [`system/message`](../../../deepseek-harness/packages/core/session/src/types.ts#L338) 与 agent-loop 的 prompt admission。

### Q8. 空提示词为什么也要写 system/message 节点？

它保留 surface node 0 的位置，表达「没有系统提示词」；后续提示词更新可以替换这个节点，而不是插入到用户消息之后。`deriveEventMessage()` 会把它投影为 null，不产生 wire message。

见 [`deriveEventMessage`](../../../deepseek-harness/packages/core/session/src/surface.ts#L120)。

### Q9. 为什么工具 schema 和提示词一起组装？

「模型能做什么」和「模型被告知能做什么」必须一致。工具集合是提示词的一部分，应该在同一个步骤快照里组装；否则 prompt 里有的工具执行不到，或执行了没声明的工具。

见 s04 的 `ToolSet.schemas()` 与 s06 的 `assemble({ toolSet })`。

### Q10. 这对 KV cache 有什么影响？in-history 是什么？

前缀缓存要求请求前缀字节稳定。替换 system head 会让请求从第一个 token 开始不同，缓存全失效；`in-history` 路由允许把提示词更新追加在历史之后，保留之前的前缀。

真实 loop 根据适配器声明的 `systemPromptUpdate` 选择策略；s06 只演示 head 替换，s08 会讲能力协商。

见 [`GenerateOptions`](../../../deepseek-harness/packages/llm/llm/src/types.ts#L555) 与 agent-loop README 的 KV cache 段。

---

## 9. 下一课：s07 · inbox / steering

s06 解决了「模型看到什么提示词」。s07 会解决「运行中的 agent 如何接收新输入」：

- `next-turn` 与 `next-step` 有什么区别？
- `followup` / `steer` / `inject` 分别落在哪个队列？
- claim 为什么是纯删除？
- 取消时 `keepInbox` 保留什么？
- 注入的上下文为什么不能唤醒 idle agent？

先读：[`agent-loop/src/{inbox,agent}.ts`](../../../deepseek-harness/packages/core/agent-loop/src/inbox.ts) 与 [`core.zh.md` 的 inbox 段](../../../deepseek-harness/docs/subsystems/core.zh.md)。
