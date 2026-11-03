# 可视化规范

课程里的图不是装饰，而是和代码一起维护的**教学源文件**。

## 目标

每节课至少有三件视觉资产：

1. **本课地图**：一张思维导图 / 架构图，回答“这节课在全局的哪里”
2. **机制动画**：一个可播放、可单步的 HTML 动画，回答“数据怎么流动”
3. **代码地图**：文件 / 类 / 函数与数据流，回答“代码在哪里”

README 里放静态首帧或 GIF；网站里放可交互版本。

## 当前资产

| 文件 | 说明 |
|---|---|
| `s01-loop.html` | s01 的交互式动画：chunk → assembler → message → session |
| `s01-loop.gif` | 1120×630，10fps，11.6s 循环，README 用 |
| `s01-loop.mp4` | 1280×720，10fps，网站/演示用 |
| `s01-loop-poster.png` | 静态首帧，备用封面 |
| `s02-tools.html` / `.gif` / `.mp4` | s02 tool round-trip 原型 |
| `s03-surface.html` / `.gif` / `.mp4` | s03 surface/replace 原型 |
| `s08-inbox.html` / `.gif` / `.mp4` | s08 inbox/steering 原型 |
| `maps/s01.svg` … `maps/s28.svg` | 28 张本课机制地图 |
| `build-maps.mjs` | 生成 28 张地图的脚本 |
| `build-s01.sh` … `build-s08.sh` | 从 HTML 重新生成 GIF/MP4 的脚本 |

## 生成

依赖：

```sh
playwright --version          # Playwright CLI
'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --version
gifski --version
ffmpeg -version
```

生成：

```sh
node docs/visuals/build-maps.mjs
./docs/visuals/build-s01.sh
./docs/visuals/build-s02.sh
./docs/visuals/build-s03.sh
./docs/visuals/build-s08.sh
```

`s01-loop.html` 支持可点击幕导航和确定性帧：

```text
?capture=1&frame=42
```

`build-s01.sh` 用 Playwright 逐帧截图，再用 gifski/ffmpeg 合成。没有网络、没有 AI 生图，每一帧都可复现。

## 设计规则

- **一图一个结论**：不要把所有事件塞进一张图。
- **用真实数据**：`calc({expression:"(12+30)*2"})`、`seq #03`、`tool/result`，不用 `foo/bar`。
- **颜色有语义**：

  | 颜色 | 含义 |
  |---|---|
  | 靛蓝 | 模型 / request / assembler |
  | 青色 | 文本流 / 正常输出 |
  | 琥珀 | 工具调用 / 外部副作用 |
  | 绿色 | 已提交 / 完成 |
  | 灰色 | 未发生 / 日志事实 |

- **动效必须能单步**：轮播是展示，单步才是学习。
- **GIF ≤ 8 秒**，循环播放；复杂流程用 HTML/视频。
- **每张图有 alt 文本**，并且和代码中的事件名一致。
- **图也要可 diff**：优先 HTML/SVG/Mermaid，GIF/MP4 是生成物。

## 已落地原型

| 原型 | 讲什么 | 文件 |
|---|---|---|
| s01 loop | chunk → assembler → message → event | `s01-loop.*` |
| s02 tool round-trip | tool-call → execute → tool/result → next step | `s02-tools.*` |
| s03 surface | 事件日志 → surface → derive → replace | `s03-surface.*` |
| s08 inbox | followup / steer / inject → claim | `s08-inbox.*` |

## 后续课程视觉

| 课 | 机制图 |
|---|---|
| s02 tool round-trip | 模型 → tool call → pipeline → tool result → 下一步 |
| s03 session log | 事件日志、surface 指针、replace 前后 |
| s04 stream & attempt | SSE chunk → timed stream → attempt 生命周期 |
| s05 tool contract | TS DSL → JSON Schema → 模型 |
| s06 tool runtime | guard → approval → batch → execute |
| s07 prompt | sections → assemble → head 准入 |
| s08 inbox | next-turn / next-step 两条队列 |
| s09 provider | provider seam + retry |
| s10 persistence | JSONL / flush / 崩溃修复 |
| s11 compaction | token 压力 → 裁剪 → 摘要 → replace |
| s12 plugin | Context / Fiber / effect 树 |
| s13 boot | profile / bundle / patch 分层 |
| s14 capabilities | fs / shell / sandbox / approval |
| s15 subagents | 父子会话、深度预算 |
| s16 PTC | 代码调用工具、持久对象 |
| s17 MCP | stdio JSON-RPC 握手 |
| s18 browser use | browser provider → session → DOM/截图 |
| s19–20 computer use | app/window/AX/截图/坐标/权限 |
| s21 web | projection + SSE + 重连 |
| s22 SDK | JSON-RPC 进程边界 |
| s23 client UI | action cards / 审批 |
| s24 observability | span / replay / snapshot |
