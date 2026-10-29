# s04 · tools：typed schema、输出契约、作用域与条件

> 本课代码：`src/`（新增 `schema.ts`；重写 `tools.ts`；`agent.ts` 改为步骤级 ToolSet）
>
> 测试：`tests/s04.test.ts`（11 个离线用例）+ `tests/s03-regression.test.ts`（12 个流式回归）+ `tests/live.test.ts`（1 个真实模型用例）
>
> 模型：真实 DeepSeek，默认 `deepseek-flash`。

---

## 0. 先跑起来

```sh
cd course/lessons/s04-tools

cp env.example .env
# 编辑 .env，至少填入 DEEPSEEK_API_KEY

node src/demo.ts
node --test tests/s04.test.ts
node --test tests/s03-regression.test.ts
node --test tests/live.test.ts     # 需要 key

# 可选：类型检查
npm install
npm run typecheck
```

Demo 会先静态解析工具集，再让真实模型调用 `calc`：

```text
resolved tools: [ 'calc', 'admin_stats' ]
schemas: [ 'calc', 'admin_stats' ]
model: deepseek/deepseek-flash (https://api.deepseek.com)

#07 tool/result        84 meta={"expression":"(12 + 30) * 2","result":"84"}
```

`maintenance_only` 的条件永远为 false，所以不在 resolved tools 里。

---

## 1. 这一课要回答的问题

1. 模型只能看到 JSON Schema，工具的 TypeScript 类型安全从哪里来？
2. 为什么工具要同时声明「参数 schema」和「输出 schema」？
3. 为什么工具返回规范值，而不是直接返回文本？
4. 条件工具为什么是「步骤级」而不是「注册时」？
5. scoped 工具、全局工具、restrictions 三者如何互相影响？
6. 参数非法、输出非法、render 抛错，分别应该让谁看到？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`contracts.ts` → `ToolDefinition`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L26) | 一个工具到底由哪些契约组成？ | Q1 / Q2 |
| 2 | [`contracts.ts` → `ToolOutputDefinition`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L16) | 为什么输出也要 schema + render？ | Q2 / Q3 |
| 3 | [`schema.ts` → `ValueSchemaSpec`](../../../deepseek-harness/packages/core/tools/src/schema.ts#L86) | DSL 如何同时服务类型推导和 JSON Schema？ | Q1 |
| 4 | [`schema.ts` → `InferArgs`](../../../deepseek-harness/packages/core/tools/src/schema.ts#L176) | 类型推导如何保留 required/optional？ | Q1 |
| 5 | [`schema.ts` → `defineTool`](../../../deepseek-harness/packages/core/tools/src/schema.ts#L555) | 编译发生在注册时还是调用时？ | Q1 / Q10 |
| 6 | [`contracts.ts` → `ResolvedToolSet`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L127) | 为什么工具集是步骤级的？ | Q4 / Q7 |
| 7 | [`tools README` → conditional tools](../../../deepseek-harness/packages/core/tools/README.md#conditional-tools) | 条件工具在什么时机求值？ | Q4 |
| 8 | [`contracts.ts` → `ToolRestriction`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L376) | 为什么 restriction 只影响全局工具？ | Q5 / Q6 |
| 9 | [`cookbook/adding-a-tool.zh.md`](../../../deepseek-harness/docs/cookbook/adding-a-tool.zh.md) | 作者需要遵守哪些 execute 约定？ | Q8 / Q9 |

读完后，你应该能画出：

```text
register(def, {scope?, when?})
        │
        ▼
resolve({signal, scope})   ← 每步一次
        │  global + scoped（scoped 遮蔽同名 global）
        │  restrictions 只过滤 global
        │  when 一次求值
        ▼
ResolvedToolSet ── schemas() ──▶ prompt / request/header
        │
        └─ get(name) ──▶ execute(call, ctx, toolSet)
                              │
                              ├─ 参数校验
                              ├─ execute() → 规范值
                              ├─ 输出校验
                              ├─ output.render → 模型内容
                              └─ presentationMeta → UI 数据
```

---

## 3. 核心概念

### 3.1 一个工具由三份契约组成

```ts
{
  name, description, parameters,   // 模型可见声明
  output: { schema, render },      // 规范值 + 模型内容
  execute(args, ctx): unknown      // 只返回规范值
}
```

- **parameters**：模型能传什么；
- **output.schema**：工具必须返回什么；
- **render**：规范值如何变成模型可读内容。

模型只看到 `name/description/parameters`；`execute`、`output.schema`、`render` 都不进 wire 声明。

### 3.2 作者写 TypeScript，运行时用 JSON Schema

```ts
const add = defineTool({
  name: 'add',
  description: 'Add two numbers.',
  parameters: {
    a: { type: 'number', required: true },
    b: { type: 'number', required: true },
  },
  output: {
    schema: { type: 'number' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  execute: args => args.a + args.b,
})
```

- `args` 的类型由 `InferArgs<P>` 推导：`{ a: number; b: number }`；
- `parameters` 在注册时编译成 JSON Schema，进入提示词；
- 运行时用同一份 spec 校验模型参数，避免「类型只在编译期」；
- `output.schema` 校验返回值，`render` 只负责展示。

### 3.3 为什么返回规范值

如果 `execute` 直接返回文本：

- PTC / workflow 只能解析自然语言；
- 策略替换内容会丢掉结构化数据；
- UI 只能拿到渲染后的字符串；
- 输出 schema 无法校验。

返回规范值后：

- 程序化调用拿到结构化 JSON；
- `render` 负责模型内容，`presentationMeta` 负责 UI；
- 输出可以校验、快照、持久化；
- 工具可以独立演进渲染和程序化 API。

### 3.4 条件、作用域、限制

- **条件**（`when`）：每个步骤求值一次；false 从 prompt 和执行中同时移除；抛错让步骤准备失败。
- **作用域**（`scope`）：scoped 工具只在该 agent/scope 可见，并遮蔽同名 global。
- **限制**（`restrict`）：对 global 工具做 allow/deny 掩码；多个掩码取交集；scoped 工具不受影响。

三者都在 `resolve()` 时合成为一份 `ResolvedToolSet`。prompt 里的 schema 和实际可执行的工具必须来自同一份 ToolSet，否则会出现「模型看到但调不到」或「能调到但没声明」。

### 3.5 ToolSet 的生命周期

```ts
const toolSet = await registry.resolve({ signal, scope })
try {
  const request = buildRequest(toolSet.schemas())
  // 模型流式输出 + 执行工具
} finally {
  toolSet.dispose()
}
```

步骤结束就 dispose：之后的新调用看不到这些工具；已经开始的调用不受影响（s05 会处理并发与取消）。这保证 prompt 与执行是同一个快照。

---

## 4. 本课实现

### 4.1 文件地图

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/schema.ts`](src/schema.ts) | DSL、类型推导、JSON Schema 编译、校验、`defineTool` | `core/tools/src/{schema,json-schema}.ts` |
| [`src/tools.ts`](src/tools.ts) | 注册表、scope、condition、restriction、ToolSet、执行 | `core/tools/src/index.ts` |
| [`src/agent.ts`](src/agent.ts) | 每步 resolve + dispose，prompt/执行共用 ToolSet | `agent-loop/src/agent.ts` |
| [`src/types.ts`](src/types.ts) | `ToolDefinition` / `ToolOutputDefinition` / `ResolvedToolSet` | `dsh-tools` 契约 |
| [`src/demo.ts`](src/demo.ts) | 解析工具集 + 真实模型调用 | — |

### 4.2 编译与校验

```ts
parametersToJsonSchema(parameters)  // 作者 DSL → JSON Schema
validateParameters(parameters, args) // 同一份 DSL → 运行时错误
valueToJsonSchema(output.schema)     // 输出 schema → JSON Schema
validateOutput(output.schema, value) // 输出值校验
```

`defineTool` 把这两个校验器挂在 `ToolDefinition` 上；注册表执行时调用，不需要每次重新编译。

### 4.3 执行流程

```ts
execute(call, ctx, toolSet) {
  const tool = toolSet === undefined ? get(call.name, ctx.scope) : toolSet.get(call.name)
  if (!tool) return error('unknown tool')
  const args = parse(call.arguments)
  if (tool.parameterValidator(args).length) return error('invalid arguments')
  const value = await tool.execute(args, ctx)   // 抛错 → error result
  if (tool.outputValidator(value).length) return error('invalid output')
  const content = tool.output.render(args, value)
  const meta = tool.output.presentationMeta?.(args, value)
  return { content, isError: false, meta }
}
```

### 4.4 resolve

```ts
const globals = visibleGlobalNames()       // 应用 restrictions
const candidates = new Map(globals)
for (scoped of scope) candidates.set(name, scoped)  // scoped 遮蔽
for (candidate of candidates) {
  if (when && !await when(context)) continue
  active.set(name, definition)
}
return new ResolvedToolSetImpl(active)
```

条件求值失败抛 `ToolActivationError`，步骤准备失败；这比「静默隐藏工具」更安全。

---

## 5. 验收

离线（`tests/s04.test.ts`）：

| 测试 | 证明 |
|---|---|
| schema 编译 | 隐式根对象 closed、required 列表正确、嵌套对象保留 openness |
| 参数校验 | required/type/enum/extra/oneOf |
| defineTool | 规范值渲染 + presentationMeta |
| 输出校验 | 非法输出、render 抛错都变成 error result |
| 错误路径 | 缺参、未知工具、工具抛错 |
| 条件 | scope 感知、false 过滤、抛错 → `TOOL_ACTIVATION_FAILED` |
| 作用域 | scoped 遮蔽同名 global，其他 scope 不可见 |
| 限制 | allow/deny 只影响 global，scoped 不受影响 |
| ToolSet | dispose 后不可见、不可开始新调用 |
| 元数据 | `isConcurrencySafe` 保留 |

流式回归（`tests/s03-regression.test.ts`）：12 个 s03 用例全部保留。

真实模型（`tests/live.test.ts`）：`calc` 调用、header 工具声明、stream、重放、压缩。

---

## 6. 刻意简化了什么

| 真实 DSH | s04 | 影响 |
|---|---|---|
| 完整 JSON Schema 关键字（pattern、format、dependentSchemas…） | 常用子集 | 教学够用 |
| 原始 JSON Schema 工具的输入校验 | 只做 DSL 校验器；raw 工具自行负责 | s05/s08 补 |
| `projectContent` / `finalizeContent` | 无 | s05 补 |
| 工具执行流水线（pre/guards/approval/post） | 无 | s05 |
| 并发调度 / 超时 | 无 | s05 |
| PTC mode | 无 | 选修 |
| 工具展示卡片 | 只有 `presentationMeta` | s16 UI |

---

## 7. 练习

### 练习 1：加一个 `enum` 驱动的工具

实现 `set_mode(mode)`：

- `mode` 只能是 `fast | slow`；
- 输出是 `{ previous, next }`；
- 用 `output.schema` 声明对象；
- 写测试：非法 mode 被参数校验拦截。

### 练习 2：作用域继承

当前 scoped 工具只按精确 scope 匹配。要求：

- 支持 `scope: 'admin:*'` 之类的层级；
- 更具体的 scope 覆盖更宽泛的；
- 写测试：`admin:readonly` 能看到 `admin` 的工具，但 `admin` 看不到 `admin:readonly` 的。

### 练习 3：输出契约的「展示投影」

给 `calc` 加 `presentationMeta`：

- 返回 `{ expression, result }`；
- 确认 `tool/result.meta` 持久化；
- 重放后仍能从 meta 重建卡片。

### 练习 4：工具限制的组合

要求：

- 同时应用 `allow: ['a','b']` 和 `deny: ['b']`；
- 结果只剩 `a`；
- scoped 的 `b` 仍然可见；
- 写测试并解释为什么 restriction 不作用于 scoped。

### 练习 5（进阶）：条件工具的缓存

`resolve()` 每个步骤都重新求值 `when`。要求：

- 给同一步骤的重试复用同一份 ToolSet；
- 步骤之间重新求值；
- 思考：为什么重试不能重新求值？如果条件依赖外部状态变化会怎样？

---

## 8. 思考题（附源码位置与答案）

### Q1. 为什么工具声明 JSON Schema，而不是直接写函数？

模型只能理解 JSON Schema 这样的结构化声明；函数签名、类型注解不会进入 wire。DSH 让作者写 TypeScript DSL，再编译成 JSON Schema，同时保留类型推导和运行时校验：作者体验好，模型协议正确。

见 [`ValueSchemaSpec`](../../../deepseek-harness/packages/core/tools/src/schema.ts#L86)、[`InferArgs`](../../../deepseek-harness/packages/core/tools/src/schema.ts#L176)、[`defineTool`](../../../deepseek-harness/packages/core/tools/src/schema.ts#L555)。

### Q2. 为什么工具要同时声明「参数 schema」和「输出 schema」？

参数 schema 约束模型输入；输出 schema 约束工具返回值。没有输出 schema，工具可能返回任意形状，调用方（PTC、workflow、UI）无法可靠消费；有了它，返回值可以被校验、快照、持久化，渲染也可以独立演进。

见 [`ToolOutputDefinition`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L16)。

### Q3. 为什么工具返回规范值，而不是直接返回文本？

规范值是程序化 API：结构化、可校验、可替换内容而不丢数据。文本只是它的一种渲染。模型需要自然语言时用 `render`；UI 需要卡片时用 `presentationMeta`；PTC 需要字段时直接用规范值。

见 [`ToolDefinition.execute`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L26)。

### Q4. 条件工具为什么是「步骤级」而不是「注册时」？

条件可能依赖当前 agent、模型选择、scope 或外部状态。注册时求值只能得到一次答案；步骤级求值才能让同一进程里的不同 agent/步骤看到不同工具集。重试复用同一步骤的 ToolSet，避免同一个请求中途工具集变化。

见 [`ResolvedToolSet`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L127) 与 [conditional tools](../../../deepseek-harness/packages/core/tools/README.md#conditional-tools)。

### Q5. scoped 工具为什么遮蔽同名全局工具？

scope 是更具体的配置：agent 或 preset 明确要一个不同的实现时，应该覆盖全局默认，而不是产生两个同名工具。遮蔽保证同名工具只有一个定义可见，避免 prompt 和 dispatch 歧义。

s04 在 `resolve()` 里先放 global，再用 scoped 覆盖同名项。

### Q6. 限制为什么只作用于全局工具？

`restrict` 是「这个 agent 继承全局工具时的掩码」；scoped 注册是该 agent 明确拥有的能力，不应该被全局掩码误伤。这样 preset/agent 可以精确控制自己的工具集。

见 [`ToolRestriction`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L376) 与 tools README 的 restrict 段。

### Q7. 为什么 ToolSet 要在步骤结束 dispose？

因为 prompt 里的 schema 和实际可执行的工具必须来自同一份快照。dispose 后，未开始的调用不能再使用旧工具；已经开始的调用保留自己的定义（s05 处理）。这样注册表变化不会让一个已经组装好的请求出现「声明了但执行不到」。

见 [`ResolvedToolSet.dispose`](../../../deepseek-harness/packages/core/tools/src/contracts.ts#L127)。

### Q8. 为什么参数校验失败是模型可见错误，而不是抛异常？

模型可以修正参数并重试；抛异常会直接结束轮次，模型没有机会改正。参数错误属于「工具调用失败」，应该以 `isError` 的 tool result 回到模型。

真实实现会把所有工具错误规范化为 `Error: <message>`；s04 的 `errorResult` 同理。

### Q9. 为什么输出/渲染失败也要规范化？

因为工具作者可能写错 schema 或 render；如果直接抛异常，会结束轮次，模型看不到「工具实现有 bug」。规范化为 error result 后，模型可以决定换工具或报告问题；同时日志保留失败事实。

见 [`execute()`](../../../deepseek-harness/packages/core/tools/src/index.ts) 的规范化顺序。

### Q10. 为什么 schema 会自动进入系统提示词？

因为「模型能做什么」和「模型被告知能做什么」必须一致。工具注册表把 schema 提供给 prompt 组装，而不是让工具作者手动拼提示词；这样新增/移除/条件工具会自动反映到请求里。

s06 会深入 prompt 组装；s04 已经让 `ToolSet.schemas()` 成为唯一来源。

---

## 9. 下一课：s05 · tool pipeline

s04 解决了「工具是什么、能看见什么」。s05 会解决「一次调用如何被策略、审批、并发、超时和恢复包围」：

- `tools/pre-execute` / `tools/execute` / `tools/post-execute` / `tools/result` 的顺序；
- 单调守卫为什么只能拒绝、不能翻案；
- 审批 `ask` 如何 fail closed；
- 并发安全工具如何滚动执行，独占工具如何形成屏障；
- 结果为什么必须按模型顺序提交；
- 失败步骤如何补齐缺失的工具结果。

先读：[`tool-execution-pipeline.zh.md`](../../../deepseek-harness/docs/tool-execution-pipeline.zh.md) 与 [`core/tools/src/{pipeline,batch}.ts`](../../../deepseek-harness/packages/core/tools/src/pipeline.ts)。
