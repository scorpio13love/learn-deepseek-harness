# s16 · PTC：让模型写程序调用工具

> 本课代码：`src/ptc.ts`、`src/tools.ts`、`src/deepseek.ts`、`src/env.ts`、`src/demo.ts`
>
> 测试：`tests/s16.test.ts`（14 个离线用例，不访问网络）
>
> 依赖：Node >= 24、零运行时依赖；只有真实模型 demo 需要 `DEEPSEEK_API_KEY`。

---

## 开篇 · 本课定位

### 这一课学什么

PTC（programmatic tool calling）把「模型逐个调用工具」换成「模型写一段程序，runtime 执行它」：

```text
传统 tool calling：
模型 → tool A → 模型 → tool B → 模型 → tool C → 模型

PTC：
模型 → 写一段 JS → runtime 执行 { A, B, C, 循环/分支/并行 } → 只返回最终结果 → 模型
```

本课实现一个最小但语义完整的 `PtcRuntime`：

- 模型生成的 JS 可以通过 `tools.<name>(args)` 调用已注册工具；
- 支持异步、`Promise.all`、中间变量；
- 工具结果跨边界前做 JSON 序列化；
- 工具错误 / 程序异常变成结构化 `result.error`，程序可以 `try/catch`；
- 每次 run 支持超时与外部取消；
- 每次 run 独立 scope，也可以传同一个 scope 持久化变量。

### 为什么 CUA / 复杂工具需要它

Computer-use agent（CUA）的每一步都很碎：截图 → 找坐标 → 点击 → 输入 → 等待 → 再截图。如果每一次都走一次模型往返：

- 延迟高：每个动作都要一次 LLM 请求；
- 上下文脏：截图、坐标、中间状态全塞进模型历史；
- 脆弱：模型要在多轮之间“记住”自己刚才点到了哪里；
- 贵：token 随步骤数线性增长。

PTC 让模型把「点哪里、输入什么、失败怎么重试」写成一个程序，runtime 在本地执行循环和条件分支，只在最后把结果交回模型。复杂重构、批量文件处理、多步表单填写也是同一模式。

真实 DSH 的 PTC 由两层组成：

- [`packages/ptc-runtime`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/ptc-runtime)：执行模型程序的抽象 seam（`run` / `resolve`、bindings、timeout、结构化失败）；
- [`packages/core/tool-executor-ptc`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/tool-executor-ptc)：把工具注册表投影成 `run_code` 和生成的 `tools` SDK，并处理嵌套调用、并发与取消。

更完整的背景见 [`docs/subsystems/ptc-runtime.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/ptc-runtime.md)。

### 服务的场景

- **CUA**：一次程序里完成“截图 → 点击 → 输入 → 校验”，失败就重试；
- **批量代码修改**：遍历文件、条件跳过、汇总结果，只把 summary 返回模型；
- **数据处理**：调用多个查询工具、在本地 join，避免把原始行塞进上下文；
- **workflow 编排**：把子 agent / 工具调用写成程序，而不是让模型逐步决策。

### 一张图

```text
┌──────────────┐    program (JS)     ┌─────────────────────────────┐
│   模型        │ ──────────────────> │  PtcRuntime.run(program)    │
│ 写代码        │                     │                             │
└──────────────┘                     │  tools.calc(...) ──┐        │
        ▲                            │  tools.sleep(...) ──┼─> 工具  │
        │  { ok, value, calls }      │  await / Promise.all│        │
        └────────────────────────────│  超时 / 取消 / 错误  │        │
                                     └─────────────────────────────┘
```

关键点：**工具调用发生在 runtime 内部，不逐次进入模型上下文**。模型只看到 program 的最终结果和（可选的）调用记录。

---

## 0. 先跑起来

```sh
cd course/lessons-v3/s16-ptc

node src/demo.ts                 # 没 key 时自动跑离线程序
node --test tests/s16.test.ts    # 全部离线，不需要 key
```

有 key 时：

```sh
cp env.example .env
# 填入 DEEPSEEK_API_KEY
node src/demo.ts
```

Demo 会让模型写一段程序，调用两次 `calc`：

```js
const sum = await tools.calc({ expression: '12 + 30' })
console.log('first call returned', sum)
return await tools.calc({ expression: `${sum} * 2` })
```

然后打印：

```text
=== tool calls ===
- calc({"expression":"12 + 30"}) -> 42 ok 0ms
- calc({"expression":"42 * 2"}) -> 84 ok 0ms

=== result ===
ok      : true
value   : 84
```

注意：模型的历史里没有 `42` 这个中间值，只有 program 的返回值 `84`。这就是 PTC 省上下文的地方。

环境变量：

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | 仅真实 demo | — | 没有 key 时 demo 走离线程序 |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | OpenAI-compatible 端点 |
| `DEEPSEEK_MODEL` | 否 | `deepseek-flash` | 默认模型 |
| `DEEPSEEK_MAX_TOKENS` | 否 | 不发送 | 单次输出上限 |
| `DEEPSEEK_TIMEOUT_MS` | 否 | 不超时 | HTTP 请求超时 |

---

## 1. 这一课要回答的问题

1. 为什么 PTC 能减少模型往返和上下文占用？
2. 工具结果如何跨进程/语言边界？为什么必须序列化？
3. 工具抛错时，应该让 program 崩掉，还是让模型代码自己 `try/catch`？
4. 超时和取消应该终止什么？为什么单线程 JS 里做不到“强杀”？
5. fresh scope 和 persistent scope 的边界在哪里？
6. PTC 为什么不是沙箱？真实 DSH 如何隔离？

---

## 2. 先读真实源码

| 顺序 | 文件 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`ptc-runtime/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/ptc-runtime/ptc-runtime/src/index.ts) | `run` / `resolve` 的职责如何切分？ | Q1 |
| 2 | [`ptc-runtime/src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/ptc-runtime/ptc-runtime/src/types.ts) | bindings、failure kind、sandbox facts 分别表达什么？ | Q2 |
| 3 | [`ptc-runtime-node`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/ptc-runtime/ptc-runtime-node) | 为什么要放进子进程？persistent REPL 怎么保留状态？ | Q6 |
| 4 | [`tool-executor-ptc/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tool-executor-ptc/src/index.ts) | `run_code` 如何生成 SDK、处理并发与取消？ | Q3 |
| 5 | [`ptc-runtime.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/ptc-runtime.md) | 真实失败分类和本课的简化差在哪？ | Q4 |

---

## 3. 核心概念

### 3.1 program 是 async 函数体

本课把模型输出当作一个 async 函数体：

```js
const sum = await tools.calc({ expression: '12 + 30' })
return await tools.calc({ expression: `${sum} * 2` })
```

runtime 编译成：

```ts
new AsyncFunction('tools', 'console', 'scope', program)
```

因此：

- 可以写顶层 `await`、`return`；
- `tools` 是 runtime 注入的命名空间；
- `console` 被捕获到 `result.logs`，不会污染宿主 stdout；
- `scope` 是显式的跨 run 变量容器。

真实 DSH 还支持 REPL / Script 格式（顶层声明、最后表达式），本课只做 function-body。

### 3.2 tools 是 Proxy，不是普通对象

```ts
const tools = new Proxy({}, {
  get: (_target, name) => (args) => callTool(name, args),
})
```

这样 `tools.nope()` 会进入 runtime 的 `UNKNOWN_TOOL` 分支，而不是抛一个难以分类的 `TypeError`。`then` 被特殊处理，避免 `await program()` 把 tools 当 thenable。

### 3.3 序列化边界

工具返回值不能直接交给 program（它可能含 Date、Map、Error、循环引用）。runtime 在边界上做一次规范化：

| 输入 | 输出 |
|---|---|
| `undefined` / 函数 / Symbol | `null` |
| `Date` | ISO 字符串 |
| `Error` | `{ name, message, code? }` |
| `bigint` | `"10n"` |
| `Map` / `Set` | 对象 / 数组 |
| 循环引用 | `serialization` 失败 |

program 的返回值也走同一条路径。调用记录里的参数用宽松序列化，保证观测不会因为一个坏参数而失败。

### 3.4 失败是结构化结果

`run()` 不向调用方抛异常，而是返回：

```ts
{
  ok: false,
  value: null,
  logs,
  calls,
  error: { kind, code, message, tool? },
}
```

`kind` 的取值：

- `invalid-program`：代码语法错误，编译失败；
- `exception`：program 自己抛了未捕获异常；
- `tool-error`：工具抛错，program 没有 catch；
- `timeout` / `abort`：超时或外部取消；
- `serialization`：循环引用等无法跨边界的结果。

工具错误进入 program 时是 `PtcToolError`（带 `code`、`tool`），所以程序可以：

```js
try {
  await tools.boom({})
} catch (error) {
  return { code: error.code, message: error.message }
}
```

### 3.5 超时与取消

```ts
const result = await runtime.run(program, {
  timeoutMs: 10_000,
  signal: controller.signal,
})
```

- 超时和外部取消共用一个内部 `AbortController`；
- 工具的 `ctx.signal` 会立刻 abort，正在 await 的工具应尽快退出；
- program 与一个 `abortPromise` 赛跑，先结束者决定结果。

**限制**：JS 单线程无法抢占一个 `while (true) {}`。超时只能打断“有 await 的程序”；真正的强隔离需要子进程/worker，真实 DSH 的 Node backend 就是这么做的。本课不是沙箱。

### 3.6 fresh vs persistent scope

```ts
const scope = runtime.createScope()
await runtime.run('scope.count = (scope.count ?? 0) + 1; return scope.count', { scope }) // 1
await runtime.run('scope.count = (scope.count ?? 0) + 1; return scope.count', { scope }) // 2
await runtime.run('scope.count = (scope.count ?? 0) + 1; return scope.count')            // 1
```

scope 是显式对象：只有写在 `scope.*` 上的值跨 run 保留；`const` / `let` 局部变量不会。真实 DSH 的 persistent REPL 由 backend 维护整个环境，本课刻意退化成显式状态，方便观察。

---

## 4. mini 实现

| 文件 | 作用 |
|---|---|
| [`src/ptc.ts`](src/ptc.ts) | `PtcRuntime`、编译、tools Proxy、序列化、超时/取消、失败分类 |
| [`src/tools.ts`](src/tools.ts) | 最小 `ToolRegistry`、`defineTool`、安全 `calc` |
| [`src/deepseek.ts`](src/deepseek.ts) | 非流式 DeepSeek 客户端（只给 demo 用） |
| [`src/env.ts`](src/env.ts) | 配置读取；无 key 时返回 undefined |
| [`src/demo.ts`](src/demo.ts) | 真实模型生成程序；无 key 时跑离线程序 |

`run` 的骨架：

```ts
const fn = AsyncFunction('tools', 'console', 'scope', program)
const programPromise = fn(tools, capturedConsole, scope)
const result = await Promise.race([programPromise, abortPromise])
return { ok: true, value: toJsonValue(result), logs, calls, durationMs }
```

调用记录在每次 `tools.*` 时追加：工具名、参数、结果/错误、耗时。它既是 demo 的观测面，也是测试的断言面。

---

## 5. 验收：14 个离线测试

| # | 用例 | 证明 |
|---|---|---|
| 1 | 两次 calc + add | 工具调用、返回值、调用记录 |
| 2 | `Promise.all` 并行 | 异步与并发 |
| 3 | console 捕获 | program 输出不污染宿主 |
| 4 | 工具抛错 | `tool-error` + 调用记录 |
| 5 | program `try/catch` | 错误可恢复，失败事实仍保留 |
| 6 | 未知工具 | `UNKNOWN_TOOL`，不是 TypeError |
| 7 | 语法错误 | `invalid-program` |
| 8 | 超时 | `timeout`，已完成的调用保留 |
| 9 | 外部取消 | `abort` |
| 10 | shared / fresh scope | 持久变量边界 |
| 11 | Date/undefined/bigint | JSON 序列化规则 |
| 12 | 循环引用 | `serialization` |
| 13 | schema 投影 | 工具声明仍可给模型 |
| 14 | 重名工具 | 注册表拒绝冲突 |

运行：

```sh
node --test tests/s16.test.ts
```

---

## 6. 刻意简化了什么

| 真实 DSH | s16 | 影响 |
|---|---|---|
| 子进程 / 沙箱执行 | 同进程 `AsyncFunction` | **不是安全边界** |
| 多语言 backend（TS/Python） | 只有 JS | 教学聚焦协议 |
| REPL / Script program 格式 | async function body | 无顶层声明持久化 |
| 嵌套调用并发上限 | 无上限 | demo 规模够用 |
| lossless JSON 全类型 | 常用类型 + 循环检测 | 够表达差异 |
| 嵌套 tool 调用 id / 事件日志 | 简化 callId + calls 数组 | 不做持久化 |
| sandbox facts / approval | 无 | 真实执行前需要 |

---

## 7. 练习

1. **并发上限**：给 runtime 加 `maxParallelSubCalls`，用信号量限制 `Promise.all` 里的工具数。
2. **工具白名单**：program 里只暴露允许的工具，其余返回 `UNKNOWN_TOOL`。
3. **真实强杀**：用 `node:worker_threads` 把 program 放进 worker，超时直接 terminate。
4. **持久 REPL**：用 worker 保留全局环境，让 `let x = 1` 跨 run 可见。
5. **重试工具**：在 program 里对 `tools.fetch(...)` 做指数退避，验证 runtime 不介入。
6. **结构化错误分类**：把工具错误的 `code`、`status` 保留到 `result.error`，供上层决策。

---

## 8. 思考题（附答案）

### Q1. `run` 和 `resolve` 为什么分开？

`resolve` 做静态校验和默认值（cwd、timeout、sandbox），失败属于调用方误用；`run` 只执行已经解析好的 spec，把 program 的成功/失败变成结果。这样 backend 可以在不执行代码的情况下拒绝不支持的选择。

见 [`ptc-runtime/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/ptc-runtime/ptc-runtime/src/index.ts)。

### Q2. 为什么 bindings 用 namespace，而不是把工具直接塞进全局？

namespace（如 `tools`）让语言可移植、避免与 program 自己的变量冲突，也方便 backend 统一生成 SDK 和做名字校验。真实 DSH 还限制保留字和 backend 占用的名字。

### Q3. 工具错误应该 reject 还是返回 error 值？

两者都可以，但语义不同。本课选择 reject 一个 `PtcToolError`：program 可以 `try/catch`，未捕获时 runtime 归类为 `tool-error`。这样“错误是值还是控制流”由模型代码决定，而 runtime 始终保留结构化事实。

### Q4. 为什么超时不是“杀掉程序”？

JS 是协作式的：同步死循环不会让出事件循环，timer 根本没机会执行。本课只能让 `await` 中的程序感知 abort；真正的隔离需要子进程/worker。真实 DSH 的 Node backend 用受管理进程执行，所以能 terminate。

### Q5. PTC 省了什么，又多了什么？

省了模型往返、token、上下文污染；多了执行层：序列化、超时、错误分类、权限、审计。真实系统还必须回答“这段代码能碰什么文件/网络”。

### Q6. 为什么 PTC 不能当沙箱？

`new AsyncFunction` 与宿主同进程、同权限，模型代码可以直接 `process.exit()` 或读文件。PTC 是调用协议，不是安全边界；安全必须来自子进程、文件策略和审批。

---

## 9. 下一课

PTC 把“工具调用”变成“程序”。下一步可以看：

- **s17**：MCP / skills / commands，如何把外部能力接进同一个工具面；
- **s19 / s20**：browser-use 与 computer-use，PTC 最适合的细粒度动作场景；
- **s27**：安全与沙箱，回答“这段模型代码到底能碰什么”。
