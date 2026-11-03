# 课程写作规范：把“架构说明”改成人能跟上的课

> 参考对象：[zero2Agent 的 DeepSeek Harness 系列](https://onefly.top/zero2Agent/learn-deepseek-harness/index.html)（社区解读）与 [DeepSeek Harness 官方文档](https://deepseek-harness.github.io/deepseek-harness/)。
>
> 这份文档不是要复制 zero2Agent 的文字，而是提炼它“为什么好读”，再结合官方事实，规定本课程后续的写法。

## 1. zero2Agent 做对了什么

读完它 DSH 模块的 13 篇，最值得借鉴的不是知识点，而是**叙述顺序**：

1. **先给一个会出事的场景**
   - 不是“本课介绍 Session Log”，而是“一个可变的 messages 数组，无法解释用户何时插话、审批是否拒绝、进程是超时还是被取消”。
   - 先让读者感到“我现在的做法会坏”，再给机制。

2. **先给判断，再给论据**
   - 例如“模型选择工具，不等于调用已经合法”。
   - 一句话把常见误解钉住，然后用表格/流程/失败模式解释。

3. **区分“事实”与“解释”**
   - 每篇末尾写“事实基线见官方 Architecture / 子系统文档”。
   - 社区文章里明显的版本差异、生态数字、实验结论，会标注来源或不确定性，不混成定论。

4. **把代价写出来**
   - 不是只列优点：插件化提高上限，也把依赖、生命周期、生态质量、版本兼容的成本带进运行时。
   - 读者因此知道“什么时候不该用”。

5. **用具体名字和数字**
   - `turn/start`、`ctx.tools`、`waterfall`、`replace`、`seq`、`maxDepth`。
   - 具体到读者能对照代码，而不是“一个请求会经过若干阶段”。

6. **结尾不是总结，而是下一问**
   - “如果 Loop 本身也能替换，下一次该看什么？”
   - 让课程像连续阅读，而不是 28 份彼此独立的说明书。

它的不足也要看见：

- 它是社区解读，不是官方规范；`rc.8`、生态数字、攻击成功率等会过时。
- 有些章节为了叙事会压缩细节，不能替代官方 API 文档。
- 它的“事实基线”仍然需要回到仓库源码确认。

## 1.1 13 篇的叙事地图

| zero2Agent | 它真正讲的问题 | 本课程对应 |
|---|---|---|
| 01 一切皆插件 | Harness 不是 Prompt 模板；没有特权内核 | s01 / s12 |
| 02 Cordis 五概念 | Plugin、Context、inject、事件、Effect/Fiber | s12 / s13 |
| 03 插件树与接缝 | Bundle/Profile/Patch；Definition–Provider–Consumer | s13 |
| 04 LLM 接缝 | 统一 Message/StreamChunk；replay；失败与恢复分离 | s09 |
| 05 Agent Loop | 控制面/执行面；Turn/Step/Request；日志派生请求 | s01 / s07 |
| 06 Tool Pipeline | 模型面/执行面/投影面；Guard 单调；并发保守 | s05 / s06 |
| 07 Session Log | 日志即事实；模型可见即已记录；Surface replace | s03 / s10 |
| 08 Inbox | followup/steer/inject；取消不是删除 | s08 |
| 09 Code Mode | 压缩接口，不是安全隔离；Binding/Runtime/Sandbox | s16 |
| 10 Compaction | 上下文是工作集；成本与缓存同一问题 | s11 |
| 11 安全边界 | 策略面独立；fail closed；审计 | s27 |
| 12 Subagent | 能力而非复制 Loop；能力预检 | s15 |
| 13 Runtime Surfaces | 运行时稳定，宿主可替换 | s22 / s23 / s24 |

这张表只借叙事结构，不把社区文章当事实来源。

## 2. 官方文档怎么用

优先级：

1. **架构与子系统文档**：边界、事件名、契约、失败语义。
2. **包 README**：具体 API、配置、已知限制。
3. **源码**：最终事实；文档与源码冲突时以源码为准。
4. **社区文章**：只作为叙事和问题意识的参考，不作为事实来源。

本课程常用的官方入口：

- [官方文档站](https://deepseek-harness.github.io/deepseek-harness/)
- [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)
- [Agent Lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.zh.md)
- [Cordis Primer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md)
- [Capability Seams](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.zh.md)
- [LLM Streaming](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/llm-streaming.zh.md)
- [Tools](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.zh.md)
- [Session](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.zh.md)
- [Testing](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/testing.zh.md)
- [DeepSeek Messages adapter](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-deepseek/README.zh.md)

## 3. 现在课程文字的问题

不是“不够长”，而是**太像架构摘要**：

- 开头就是“这一课学什么 / 为什么 / 场景”，三段模板化，没有读者自己的处境。
- 先给名词表，再给定义；读者不知道这些名词解决了哪个具体麻烦。
- “不是 A，而是 B”出现太频繁，像在背结论。
- 只讲设计，不讲**失败模式**和**代价**；读者无法判断什么时候不该用。
- 每节都像独立文档，缺少一条连续的“如果我这样做，会在哪里坏掉”的主线。
- 代码示例不少，但缺少一个从头到尾的**运行故事**：谁在什么时候写了哪条事件，下一步为什么看得见。
- 标题是“核心概念/实现/验收”，不是问题；读者很难从目录判断这一课到底在解决什么。

## 4. 新的单课结构

每课开头不超过 5 段，先让人进入场景：

1. **一个具体的下午**：谁在做什么，什么坏了。
2. **一句判断**：这节要立的规矩。
3. **一个真实 trace 或最小代码**：不先讲抽象图。
4. **代价与反例**：这样做贵在哪，什么时候不值得。
5. **设计检查**：3–5 个能拿去审自己代码的问题。

正文再展开：

```text
场景 → 失败路径 → 契约/事件 → 真实运行 → 取舍 → 设计检查 → 下一问
```

不要每课都填满七段；按内容删减，但**至少要有场景、失败路径、真实运行、代价**。

## 5. 语言规则

### 要

- 用第二人称或具体角色：“你让 agent 改一个测试……”
- 用真实名字：`turn/end`、`surfaceOp`、`guard`、`ctx.tools`。
- 先解释读者能看到的症状，再给术语。
- 一个比喻最多用一次；比喻之后立刻回到代码事实。
- 每节至少一个“如果……就会……”的失败句。
- 事实句后面给官方链接；不确定的写“截至当前版本”。

### 不要

- “本课将介绍……”
- “首先、其次、最后”三段式。
- 连续三个以上“不是 A，而是 B”。
- “极大地、显著地、全面地、赋能、闭环”这类空词。
- 把表格当装饰；表头必须是**取舍/责任/失败**，不是功能清单。
- 把“设计理念”写成口号；要能落到一个事件、一个字段、一个错误码。

## 6. 每课的验收

- [ ] 开头有一个具体场景，不是定义。
- [ ] 有一句能被反驳的判断。
- [ ] 有一个真实事件/代码 trace，读者能对照。
- [ ] 写了至少一个失败模式。
- [ ] 写了代价或“什么时候不该用”。
- [ ] 有 3–5 个设计检查问题。
- [ ] 官方事实链接与源码链接分开标注。
- [ ] 删掉模板化的“这一课学什么/为什么/场景”三段标题（可以保留其中一问，但不要三连）。

## 7. 改写顺序

1. s01 / s02 / s03：先建立“运行故事”的写法。
2. s04–s10：每课围绕一次真实 run 展开。
3. s11–s16：把取舍和失败模式写足。
4. s17–s24：外部能力与宿主，强调边界和协议。
5. s25–s28：质量与结课，少讲概念，多讲验收。

> 本规范先作为写作约束；具体课文按它逐课重写，不一次性批量替换成同一套句式。
