# s12 · composition / boot：profile、bundle、patch

> 本课代码：`src/boot.ts`（JSON 配置、patch 叠加、Boot）
>
> 测试：`tests/s12.test.ts`（8 个离线用例）+ s11 回归
>
> 本课不调用模型；重点是「一棵可替换的插件树如何被组装出来」。

---

## 0. 先跑起来

```sh
cd course/lessons/s12-composition-boot
node src/demo.ts
node --test tests/s12.test.ts
```

Demo 会叠加 base bundle、mode bundle、profile patch，然后启动插件树，并演示 required entry 失败。

---

## 1. 这一课要回答的问题

1. profile、bundle、patch 三层分别负责什么？
2. 为什么 patch 替换整个 config，而不是 merge？
3. 为什么 required entry 失败要中止启动？
4. `--dump-config` 的价值是什么？
5. 配置错误应该在什么时机失败？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`app-boot` README](../../../deepseek-harness/packages/boot/app-boot/README.md) | profile/bundle/patch 如何叠加？ | Q1 / Q2 |
| 2 | [`bundle/base/cordis.patch.yml`](../../../deepseek-harness/packages/bundle/base/cordis.patch.yml) | base 层挂了哪些插件？ | Q1 |
| 3 | [`apps/cli`](../../../deepseek-harness/apps/cli/README.md) | CLI 如何选择 profile / dump config？ | Q3 / Q4 |
| 4 | [`official-bundles`](../../../deepseek-harness/packages/util/official-bundles) | shipped profile 的 bundle 列表？ | Q1 |
| 5 | [`verify-cordis-config`](../../../deepseek-harness/scripts/verify-cordis-config.ts) | 配置错误在什么时候被拒绝？ | Q5 |

---

## 3. 核心概念

### 3.1 三层

- **profile**：命名组装，列出 bundle，并保存自己的 patch；
- **bundle**：可分发的 patch 列表（base / headless / web-app / sdk-app…）；
- **patch**：按 id `insert` / `replace` / `disable` / `remove`。

叠加顺序是：空根 → 各 bundle → profile patch → home patch → `--patch` overlay；后者覆盖前者。

### 3.2 替换整个 config

patch 的 `replace` 不是 deep merge，而是把该条目的 **整个 config** 替换掉。原因：

- merge 语义难解释、难预测；
- 层与层之间会互相污染；
- 显式重写整个 config 更容易审计。

### 3.3 required entry

如果 required 条目缺失、disabled 或无法激活，启动失败并回滚。不能带着不完整的能力树启动，否则问题会在运行期以更难诊断的方式出现。

### 3.4 dump config

`--dump-config` 打印最终组合的条目树。它是读 DSH composition 的最好入口：能直接看到运行时到底挂了什么、顺序如何、配置是什么。

### 3.5 fail loud

配置错误在「最早可解析点」失败：未知 id、重复 insert、缺少 required、未注册插件。不要静默跳过，否则用户会以为配置生效了。

---

## 4. 本课实现

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/boot.ts`](src/boot.ts) | ConfigEntry、Patch、composeProfile、Boot | `boot/app-boot` |
| [`src/kernel.ts`](src/kernel.ts) | 增加 `ctx.config` 与 `plugin(...,{config})` | Cordis Loader |
| [`src/demo.ts`](src/demo.ts) | base + mode + profile patch | — |

核心：

```ts
let entries = []
for (bundle of profile.bundles) for (patch of bundle.patches) entries = applyPatch(entries, patch)
if (profile.patch) entries = applyPatch(entries, profile.patch)
const ctx = await boot.start(entries, { required: ['loop'] })
```

---

## 5. 验收

| 测试 | 证明 |
|---|---|
| patch insert/replace/disable/remove | 叠加语义 |
| unknown id | fail loud |
| bundle order | 后者覆盖前者 |
| boot | 挂载、config 传递、dispose |
| required | 缺失/disabled 回滚 |
| unregistered/failing plugin | 启动失败并回滚 |
| disabled | 跳过 |
| dumpConfig | 深拷贝 |

---

## 6. 刻意简化了什么

| 真实 DSH | s12 | 影响 |
|---|---|---|
| YAML + Loader + Include | JSON + 内存 entries | 语法差异 |
| HMR / 配置热重载 | 无 | s11 的 fiber 可支持 |
| 配置 schema（zod） | 手写校验 | 教学够用 |
| 多 profile 目录 / npm 插件安装 | 内存注册表 | 后续 |
| required 的完整失败矩阵 | 简化版 | 语义相同 |

---

## 7. 练习

1. **YAML 子集**：支持 `entries:` 列表与注释；写解析器。
2. **deep merge**：实现 `replaceMode: 'merge' | 'replace'`，对比两者风险。
3. **HMR**：patch 变化时 dispose 旧 fiber、挂载新 fiber，保留未变化的插件。
4. **required 矩阵**：区分「缺失」「disabled」「插件 apply 失败」「依赖未就绪」。
5. **dump 层级**：在 dump 中标注每个条目来自哪个 bundle/patch 层。

---

## 8. 思考题（附源码位置与答案）

### Q1. profile、bundle、patch 三层分别负责什么？

profile 是命名组装；bundle 是可分发的插件集合；patch 是按 id 的覆盖操作。三者分离让发行版、部署模式、用户覆盖可以独立演进。见 [`app-boot`](../../../deepseek-harness/packages/boot/app-boot/README.md)。

### Q2. 为什么 patch 替换整个 config？

merge 的嵌套语义难以预测，层与层之间会隐式污染；替换整个 config 迫使覆盖者显式写出完整意图，审计也更容易。

### Q3. 为什么 required entry 失败要中止启动？

required 是应用运行的前提（agent loop、webserver、SDK server）。缺失时继续启动只会把错误推迟到运行期，且可能让用户误以为服务正常。

### Q4. `--dump-config` 的价值？

它把最终组合树打印出来，让「运行时到底加载了什么」可观察、可 diff、可排障；读 composition 时比读源码更快。

### Q5. 配置错误应该在什么时机失败？

最早可解析点：加载时能判断的（未知 id、重复、schema）就加载时失败；只有依赖运行期状态的才推迟到最早可解析点。不要静默跳过。

---

## 9. 下一课：s13 · capability seams

s12 组装了插件树。s13 会加入真实执行世界：

- `ctx.fs` / `ctx.shell` / `ctx.sandbox` / `ctx.approval` 如何分工？
- 为什么沙箱要在进程启动前包装 argv？
- 审批不可用为什么 fail closed？
- 文件工具的路径逃逸如何阻止？
- 如何把本地后端换成远程后端？

先读：[`fs`](../../../deepseek-harness/packages/fs/README.md)、[`shell`](../../../deepseek-harness/packages/shell/README.md)、[`sandbox`](../../../deepseek-harness/packages/sandbox/README.md)。
