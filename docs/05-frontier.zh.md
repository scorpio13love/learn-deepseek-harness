# 前沿观察：RSI、Super-agent 与 Harness 行业

> 这不是课程正文，而是一页**拓展阅读**。目的不是追新闻，而是建立判断框架：哪些是模型能力，哪些是推理基础设施，哪些只是 harness 层的工程演进。

## 0. 先把四个词分开

| 层 | 在解决什么 | 代表 |
|---|---|---|
| 基础模型 | 权重、预训练、后训练、推理能力 | DeepSeek 模型 |
| 推理基础设施 | 怎么高吞吐、低延迟地服务模型 | DeepInfer |
| Agent Harness | 怎样让模型持续运行、调用工具、恢复、审批、评测 | DeepSeek Harness |
| Agent 产品 | 用户看到的任务系统、IDE、Web、SDK | Super-agent、Coding Agent |

很多“RSI 来了”“AI 自己造 AI”的标题，实际发生在 **Harness 层**，不是模型权重层。先把层分清楚，才不会把工程闭环误读成模型自我进化。

---

## 1. DeepSeek 的 RSI：进展在 Harness，不在权重

### 现在发生的是什么

近期围绕“梁文锋用沙盒开启 RSI”的报道，描述的是一条**受控的自我改进回路**：

```text
Agent 在沙盒里提出改进
  → 修改/生成插件、工具或 harness 代码
  → 运行测试和评估
  → 保留有效改动
  → 人类审查后进入下一轮
```

这叫 **harness-level RSI**：让 agent 参与改进 agent 的运行框架、工具和插件，而不是让基础模型无监督地改写自己的权重。

### 它为什么有意义

- 工具、插件、提示词、审批策略、评测用例都可以被 agent 反复试验；
- 沙盒提供可回滚的试验场；
- 测试和评估把“看起来更好”变成可验证的改动；
- 人类审查仍然是安全边界。

### 它不是什么

- 不是“模型已经能递归自我改进权重”；
- 不是“无需人类、无需评测的自治进化”；
- 不是“RSI 已经达到 AGI 门槛”。

> 判断标准：如果一篇报道没有说明**改了什么、怎么验证、谁批准、失败如何回滚**，它大概率只是把“agent 写插件”包装成了 RSI。

参考：

- [梁文锋用沙盒开启 RSI · 钛媒体](https://www.tmtpost.com/8151587.html)
- [Liang Wenfeng activates RSI with the sandbox · 36Kr](https://eu.36kr.com/en/p/3996973213505408)

---

## 2. Super-agent：已经落地为“任务系统”，但仍在早期

### 它是什么

DeepSeek 开源的 Super-agent，不是“更聪明的单次对话”，而是把 agent 变成一个**持续运行的任务系统**：

- 不再只等用户 `@` 或发一条消息；
- 主动领取、拆解、执行任务；
- 可以持续运行，不需要人一直当“保姆”；
- 编程任务可以自主执行；
- 任务可以排队、分派、回收结果。

### 落地程度

| 维度 | 状态 |
|---|---|
| 开源代码 | 已落地 |
| 开发者可用 | 已落地，仍在快速迭代 |
| 企业生产 SLA | 早期 |
| 完全无人值守 | 不是，仍需要审批、预算和失败收口 |
| 通用“超级智能” | 不是 |

更准确的说法是：**Super-agent 是一个可持续运行的 agent 任务系统，而不是一个已经通过图灵测试的超级智能。**

参考：

- [DeepSeek 开源 Super-agent · 36Kr](https://www.36kr.com/p/4052484771681158)
- [DeepSeek Super-agent 架构解析 · 阿里云开发者社区](https://developer.aliyun.com/article/1779111)
- [DeepSeek Harness 正式发布 · 36Kr](https://eu.36kr.com/zh/p/3952918063774852)

---

## 3. DeepInfer：推理侧的生产栈，不是 Agent Harness

DeepInfer 是 DeepSeek 开源的**大模型推理框架**，解决的是“模型怎么被高效地服务”：

- 面向 DeepSeek 模型的高吞吐、低延迟推理；
- 兼容 NVIDIA 与昇腾等硬件；
- 强调生产环境的服务能力，而不是 agent 控制流；
- 据报道支持大规模集群吞吐和长周期 KV Cache。

它和本课程的 Harness 是**上下游关系**：

```text
Agent Harness
  → 发模型请求
  → DeepInfer / 推理服务
  → GPU/NPU
```

DeepInfer 的进步会降低 agent 的推理成本、提高并发和响应速度，但它不负责 turn/step、工具审批、会话恢复和 eval。不要把“推理框架开源”误读成“agent 框架开源”。

参考：

- [DeepSeek 开源推理框架 DeepInfer · 凤凰网](https://i.ifeng.com/c/8xNa7mI3a8J)
- [DeepSeek DeepInfer GitHub](https://github.com/deepseek-ai/deepinfer)
- [DeepSeek open-sources DeepInfer · TNW](https://thenextweb.com/news/deepseek-deepinfer-open-source-inference-engine)

---

## 4. Harness 行业最近在发生什么

### 4.1 Harness 从“提示词外壳”变成基础设施

行业讨论的重点已经从“怎么写 system prompt”转向：

- 长任务如何恢复；
- 工具调用如何审批、并发、超时；
- 子 agent 如何隔离和计预算；
- 运行过程如何记录、回放、评测；
- 多客户端如何共享同一份事实。

也就是说，**Harness Pattern 正在从论文命题变成基础设施架构**。

参考：

- [The Harness Pattern Is No Longer a Thesis · Forkast](https://forkast.news/the-harness-pattern-is-no-longer-a-thesis-it-is-the-infrastructure-architecture/)
- [The Agent Stack Just Became a Commodity · Forkast](https://forkast.news/the-agent-stack-just-became-a-commodity/)

### 4.2 自动演化开始围绕 Harness，而不是只围绕 Prompt

近期出现的 HarnesX、PluginRSI 等工作，方向都是：

- 自动生成/组合插件；
- 用评测反馈筛选 harness 变体；
- 把“agent 改 agent 的运行框架”变成可复用流程；
- 在沙盒里做可回滚实验。

这和 DeepSeek 的沙盒 RSI 是同一类问题：**怎么让改进可验证、可回滚、可审计**。

参考：

- [Xiaomi HarnesX auto-evolution framework](https://www.digitaltoday.co.kr/en/view/74920/xiaomi-research-team-unveils-harnesx-auto-evolution-framework-for-ai-agent-harnesses)
- [PluginRSI: Recursive Improvement of Agent Harnesses](https://arxiv.org/html/2609.32423v2)

### 4.3 竞争点从“模型能不能做”转向“运行时可不可靠”

当模型能力逐渐商品化，差异化越来越落在：

- sandbox / approval / 权限；
- 工具生态和 MCP；
- 会话恢复、压缩、fork；
- 观测、回放、eval；
- 多端（Web / SDK / IDE / 桌面）的一致投影。

换句话说：**模型是发动机，Harness 是底盘、刹车、仪表盘和维修手册。** 只看发动机马力，无法判断一辆车能不能上路。

### 4.4 长任务、主动 agent、多 agent 成为产品形态

Super-agent、Deep Agents、subagent 编排的共同方向：

- 从“一问一答”变成“持续任务”；
- 从“用户 @ 才动”变成“发现任务就领取”；
- 从“一个 agent 全干”变成“主 agent + 子 agent + 工具”；
- 从“最终文本”变成“日志、产物、评测报告”。

但真正落地时，瓶颈通常不是模型智商，而是：

- 失败恢复；
- 权限和副作用；
- 预算；
- 可观测性；
- 人类审批的交互成本。

参考：

- [LangChain Deep Agents overview](https://docs.langchain.com/oss/javascript/deepagents/overview)
- [LangChain: better models alone won't get your agent there · VentureBeat](https://venturebeat.com/orchestration/langchains-ceo-argues-that-better-models-alone-wont-get-your-ai-agent-to)

---

## 5. 一张判断表：看到“前沿进展”先问五个问题

| 问题 | 为什么重要 |
|---|---|
| 改的是模型权重、推理框架，还是 harness？ | 决定它是不是“RSI” |
| 有没有官方代码/论文/可复现实验？ | 区分产品发布和二手解读 |
| 改进如何验证？ | 没有 eval 的“更好”不可信 |
| 失败如何回滚？ | 沙盒、审批、日志是安全边界 |
| 有没有真实生产案例？ | demo、开源、生产 SLA 是三件事 |

### 一句话总结

```text
DeepSeek 的 RSI：有受控的 harness 级进展，不是权重级递归自我改进。
Super-agent：已开源落地为任务系统，但企业级完全自治仍在早期。
DeepInfer：推理侧生产栈，不是 agent harness。
Harness 行业：从提示词技巧变成运行时基础设施，竞争点是可靠性、权限和评测。
```

---

## 6. 延伸阅读

- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness 文档](https://deepseek-harness.github.io/deepseek-harness/)
- [DeepInfer](https://github.com/deepseek-ai/deepinfer)
- [RSI Arena](https://arxiv.org/abs/2610.33624)
- [PluginRSI](https://arxiv.org/abs/2609.32423)
- [The Harness Pattern · Forkast](https://forkast.news/the-harness-pattern-is-no-longer-a-thesis-it-is-the-infrastructure-architecture/)
- [The Agent Stack Just Became a Commodity · Forkast](https://forkast.news/the-agent-stack-just-became-a-commodity/)

> 前沿信息会快速变化。本文只保留“分层 + 判断框架”，具体版本、指标和发布日期请以官方仓库与论文为准。
