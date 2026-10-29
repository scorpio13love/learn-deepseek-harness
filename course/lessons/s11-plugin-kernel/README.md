# s11 · plugin kernel：Context、Service、Fiber 与事件

> 本课代码：`src/kernel.ts`（mini Cordis）+ `src/demo.ts`
>
> 测试：`tests/s11.test.ts`（8 个离线用例）+ s03-s10 回归
>
> 本课不调用模型；重点是把前面 10 课的对象组装成插件树。

---

## 0. 先跑起来

```sh
cd course/lessons/s11-plugin-kernel
node src/demo.ts
node --test tests/s11.test.ts
node --test tests/s10-regression.test.ts
```

Demo 会：

1. 挂载 `SessionService` 和 `ToolsService`；
2. 挂载一个 `inject: ['sessions','tools']` 的 loop 插件；
3. 触发 `loop/step`，跑一个 `prompt` waterfall；
4. 用 scope 过滤全局/agent 事件；
5. dispose fiber，观察 effect 逆序撤销。

---

## 1. 这一课要回答的问题

1. 为什么 DSH 连 agent loop 都是插件？
2. Context、Service、inject 如何实现依赖注入？
3. Fiber 与 effect 如何保证「卸载即撤销」？
4. emit / waterfall / serial / bail 分别适合什么？
5. scope 如何把注册限制到单个 agent？
6. 没有特权内核的代价是什么？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`vendor/cordis/src/context.ts`](../../../deepseek-harness/vendor/cordis/src/context.ts) | Context 如何提供/查找服务？ | Q1 / Q2 |
| 2 | [`vendor/cordis/src/service.ts`](../../../deepseek-harness/vendor/cordis/src/service.ts) | Service 的生命周期挂在哪里？ | Q2 |
| 3 | [`vendor/cordis/src/fiber.ts`](../../../deepseek-harness/vendor/cordis/src/fiber.ts) | Fiber dispose 的顺序是什么？ | Q3 |
| 4 | [`vendor/cordis/src/events.ts`](../../../deepseek-harness/vendor/cordis/src/events.ts) | 五种分发模式的语义？ | Q4 |
| 5 | [`core/scope/src/index.ts`](../../../deepseek-harness/packages/core/scope/src/index.ts) | scope 如何过滤事件和注册？ | Q5 |
| 6 | [`cordis-primer.zh.md`](../../../deepseek-harness/docs/cordis-primer.zh.md) | 插件作者的最小规则？ | Q1 / Q6 |

---

## 3. 核心概念

### 3.1 五个概念

- **插件**：函数或 Service 类；
- **Context**：服务容器，`ctx.<key>`；
- **inject**：声明依赖，缺失则拒绝挂载；
- **事件**：类型化分发（emit/waterfall/serial/bail）；
- **effect**：注册即副作用，卸载时逆序撤销。

### 3.2 Service 与 inject

```ts
class Sessions extends Service {
  constructor(ctx: Context) { super(ctx, 'sessions') }
}

const loop = Object.assign(async (ctx: Context) => {
  const sessions = ctx.require<Sessions>('sessions')
  // ...
}, { inject: ['sessions'] })
```

插件通过 key 查找服务，而不是 import 实现；这就是「换 provider 不改 loop」的基础。

### 3.3 Fiber 与 effect

```ts
const fiber = await root.plugin(plugin)
fiber.dispose()  // 逆序撤销 effect、监听器、子插件
```

真实 DSH 里，工具注册、提示词段、适配器、监听器都是 effect；卸载插件时自动撤销，HMR 才能工作。

### 3.4 事件模式

| 模式 | 语义 |
|---|---|
| `emit` | 观察，无返回值 |
| `waterfall` | 环绕中间件，监听器调用 `next()` |
| `serial` | 顺序 await，返回最后一个值 |
| `bail` | 第一个非 undefined 停止 |

### 3.5 scope

`ctx.createScope(target)` 创建带 scope 的子上下文；带 scope 的监听器只接收同 scope 的事件。真实 DSH 用它把工具/提示词注册限制到单个 agent。

---

## 4. 本课实现

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/kernel.ts`](src/kernel.ts) | Context/Service/Fiber/effect/events/scope | `vendor/cordis/src/*` |
| [`src/demo.ts`](src/demo.ts) | 三个插件 + waterfall + scope | — |

简化点：

- Service 类注册在挂载上下文（通常是 root），不是每次 plugin 调用的子 context；
- 事件分发遍历插件树，但只做 scope 过滤，不实现 Cordis 的完整 service realm；
- 没有 Loader/配置 schema/HMR；这些留给 s12。

---

## 5. 验收

`tests/s11.test.ts`：

| 测试 | 证明 |
|---|---|
| provide/get | 父子上下文服务查找 |
| inject missing | 缺依赖拒绝挂载并回滚 |
| fiber effects | 逆序撤销、监听器移除 |
| waterfall | 环绕、异步 next |
| serial/bail | 顺序与短路 |
| scope | 只接收匹配 scope |
| child dispose | 子树监听器移除 |
| effect disposer | 可独立注销、幂等 |

---

## 6. 练习

1. **Service 生命周期**：让 Service 注册也绑定到 plugin fiber，而不是 root；写测试验证卸载后服务消失。
2. **事件顺序**：让 waterfall 按 scope 从内到外执行，写出预期顺序。
3. **Loader**：从 JSON 配置挂载插件，校验 `inject` 与 `disabled`。
4. **HMR**：dispose 旧 fiber、挂载新 fiber，验证监听器和工具注册没有泄漏。
5. **Scope realm**：实现「同名服务在两个 agent scope 中互不覆盖」。

---

## 7. 思考题（附源码位置与答案）

### Q1. 为什么 DSH 连 agent loop 都是插件？

因为 loop 也必须可替换、可测试、可卸载。如果 loop 是特权内核，扩展只能改内核；插件化后，loop 只是 `ctx.agents` 的一个 factory，UI/工具/模型都能独立演进。

见 [`architecture.zh.md`](../../../deepseek-harness/docs/architecture.zh.md)。

### Q2. Context、Service、inject 如何实现依赖注入？

Context 是服务容器；Service 把自己注册到 `ctx.<key>`；插件用 `inject` 声明依赖，加载器等待依赖就绪后再 apply。消费方按 key 查找，不 import 实现。

见 [`context.ts`](../../../deepseek-harness/vendor/cordis/src/context.ts)。

### Q3. Fiber 与 effect 如何保证卸载即撤销？

每个插件挂载产生 Fiber；`ctx.effect`/`ctx.on` 把 disposer 交给 Fiber；dispose 时逆序执行。注册即副作用，卸载就不会泄漏。

见 [`fiber.ts`](../../../deepseek-harness/vendor/cordis/src/fiber.ts)。

### Q4. 四种事件模式分别适合什么？

- emit：状态广播/遥测；
- waterfall：策略中间件（pre-step、工具策略、LLM 包装）；
- serial：有序检查点（turn-stopping）；
- bail：短路查找（首个结果）。

见 [`events.ts`](../../../deepseek-harness/vendor/cordis/src/events.ts)。

### Q5. scope 如何限制注册？

`createScope(target)` 产生带 scope 的子上下文；带 scope 的监听器只接收同 scope 的事件。工具/提示词注册可以挂在 `agent.ctx`，从而只对该 agent 生效。

见 [`core/scope`](../../../deepseek-harness/packages/core/scope/src/index.ts)。

### Q6. 没有特权内核的代价是什么？

- 启动顺序由依赖图决定，调试更复杂；
- 插件边界需要显式契约；
- 性能上多一层分发；
- 错误处理必须 fail loud，否则问题会被插件吞掉。

回报是可替换、可热插拔、可组合。

---

## 8. 下一课：s12 · composition / boot

s11 有了内核。s12 会把它组装成产品：

- profile / bundle / patch 如何叠加？
- 配置 schema 如何校验？
- required entry 失败为什么启动失败？
- `--dump-config` 如何工作？
- HMR 如何重载配置？

先读：[`boot/app-boot`](../../../deepseek-harness/packages/boot/app-boot/README.md) 与 [`bundle/base/cordis.patch.yml`](../../../deepseek-harness/packages/bundle/base/cordis.patch.yml)。
