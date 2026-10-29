# s13 · capability seams：fs / shell / sandbox / approval

> 本课代码：`src/capabilities.ts`（本地 fs/shell 提供方、沙箱包装、审批、read/write/bash 工具）
>
> 测试：`tests/s13.test.ts`（6 个离线用例）+ s12 回归
>
> 本课不调用模型；重点是「执行世界」的 seam。

---

## 0. 先跑起来

```sh
cd course/lessons/s13-capability-seams
node src/demo.ts
node --test tests/s13.test.ts
```

Demo 会在临时工作区里写文件、读文件、跑 shell，并演示：

- 路径逃逸被拒绝；
- 审批拒绝时写/执行不运行；
- 沙箱在 spawn 前包装 argv。

---

## 1. 这一课要回答的问题

1. `ctx.fs` / `ctx.shell` / `ctx.sandbox` / `ctx.approval` 分别负责什么？
2. 为什么沙箱必须在进程启动前包装 argv？
3. 审批不可用时为什么 fail closed？
4. 路径逃逸应该由谁阻止？
5. 换成远程后端时，工具需要改吗？

---

## 2. 先读真实源码

| 顺序 | 文件 / 函数 | 读的时候问自己 | 思考题 |
|---|---|---|---|
| 1 | [`fs` README](../../../deepseek-harness/packages/fs/README.md) | Service Definition / Provider / Consumer 如何分工？ | Q1 / Q5 |
| 2 | [`tool-fs`](../../../deepseek-harness/packages/fs/tool-fs/src/index.ts) | 路径校验与写意图在哪里？ | Q4 |
| 3 | [`shell` README](../../../deepseek-harness/packages/shell/README.md) | shell backend 与 subprocess 的关系？ | Q1 |
| 4 | [`sandbox` README](../../../deepseek-harness/packages/sandbox/README.md) | 沙箱在什么阶段生效？ | Q2 |
| 5 | [`approval`](../../../deepseek-harness/packages/interaction/user-approval/src/index.ts) | ask 如何变成 allowed-once？ | Q3 |
| 6 | [`permission-presets`](../../../deepseek-harness/packages/interaction/permission-presets/src/index.ts) | 工具级权限如何组合？ | Q3 |

---

## 3. 核心概念

### 3.1 三角色

- **Service Definition**：`FsProvider` / `ShellProvider` / `Sandbox` / `ApprovalService`；
- **Provider**：本地 fs、本地 shell、NoSandbox、AllowAllApproval；
- **Consumer**：`read_file` / `write_file` / `bash` 工具。

工具只依赖接口，所以把 LocalFs 换成远程 FS、把 LocalShell 换成 SSH/沙箱后，工具不需要改。

### 3.2 路径逃逸

`LocalFs.resolve()`：

```ts
const absolute = isAbsolute(path) ? path : resolve(root, path)
const rel = relative(root, absolute)
if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('escapes workspace')
```

它必须在 provider 层执行，而不是工具里「顺手检查」；否则其他消费者可以绕过。

### 3.3 沙箱在 spawn 前

```ts
const argv = sandbox.wrap([shell, '-c', command])
spawn(argv[0], argv.slice(1), ...)
```

沙箱不是「跑完再检查」，而是决定实际启动的 argv。NoSandbox 直接返回原 argv；真实后端可能换成 `sandbox-exec`、bwrap、Landlock 包装。

### 3.4 审批 fail closed

写文件和 shell 是外部副作用；审批不可用/拒绝时直接失败，不执行。审批通过只对本次调用有效（allowed-once）。

---

## 4. 本课实现

| 文件 | 作用 | 真实对应 |
|---|---|---|
| [`src/capabilities.ts`](src/capabilities.ts) | LocalFs、LocalShell、Sandbox、Approval、工具 | `fs/*`、`shell/*`、`sandbox/*` |
| [`src/demo.ts`](src/demo.ts) | 临时工作区演示 | — |

工具：

- `read_file(path)`：读 UTF-8 文本；
- `write_file(path, content)`：审批后写；
- `bash(command, timeoutMs?)`：审批后跑 shell，返回 `{exitCode,stdout,stderr,timedOut}`。

---

## 5. 验收

| 测试 | 证明 |
|---|---|
| fs | 读写、路径逃逸拒绝 |
| shell | stdout/exit/timeout |
| sandbox | argv 在 spawn 前包装 |
| tools | 写/读/bash 经流水线 |
| approval | 拒绝时不执行 |
| path escape | 模型可见错误结果 |

---

## 6. 刻意简化了什么

| 真实 DSH | s13 | 影响 |
|---|---|---|
| Seatbelt/bwrap/Landlock | NoSandbox/RecordingSandbox | 教学 |
| 远程 SSH fs/shell | 只有本地 | 接口相同 |
| 文件先读后编辑、写意图事件 | 无 | 后续 |
| 权限预设/审批 UI | Allow/Deny | 语义相同 |
| PTY / 持久终端 | 无 | s16 之后 |

---

## 7. 练习

1. **只读工作区**：实现 `ReadOnlyFs`，写操作抛错；写测试。
2. **真实沙箱**：在 macOS 上用 `sandbox-exec` 包装 `bash`，验证允许/拒绝路径。
3. **审批策略**：按工具名/参数 allow/deny/ask，组合成 permission preset。
4. **远程 FS**：实现一个内存 FS provider，验证工具不改。
5. **输出上限**：bash 输出超过 N 字节时截断并标记。

---

## 8. 思考题（附源码位置与答案）

### Q1. 四个 seam 分别负责什么？

- fs：文件读写与路径解析；
- shell：命令执行；
- sandbox：进程启动前的 argv 包装；
- approval：副作用前的人类授权。

### Q2. 为什么沙箱必须在 spawn 前？

因为进程一旦启动，同进程代码无法可靠地「事后限制」它。沙箱必须决定实际执行的 argv/权限边界。

### Q3. 审批不可用为什么 fail closed？

写文件/执行命令有外部副作用；如果没人能批准却默认允许，就绕过了策略。正确行为是拒绝并让模型看到原因。

### Q4. 路径逃逸应该由谁阻止？

Provider 层。工具只是消费者；如果只在工具里检查，其他消费者（LSP、脚本、PTC）可以绕过。见 `LocalFs.resolve`。

### Q5. 换成远程后端时工具要改吗？

不需要。工具依赖 `FsProvider`/`ShellProvider` 接口；远程 provider 实现同一接口即可。真实 DSH 的 SSH fs/shell 就是这样替换本地提供方的。

---

## 9. 下一课：s14 · subagents / presets

s13 有了执行世界。s14 会加入委派：

- 子 agent 是「再开一个 loop」吗？
- spawn 与 fork 的语义差异？
- 深度/并发预算如何限制？
- 子会话如何持久化、如何继续？
- preset 如何给不同 agent 不同工具/提示词？

先读：[`subagent`](../../../deepseek-harness/packages/subagent/subagent/README.md) 与 [`preset`](../../../deepseek-harness/packages/preset/agent-preset-registry/README.md)。
