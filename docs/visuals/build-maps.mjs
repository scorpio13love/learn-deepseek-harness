#!/usr/bin/env node
/**
 * 生成 28 张课程机制地图（docs/visuals/maps/sNN.svg）。
 * 纯 SVG、无外部依赖；每课一张“本课地图”，README 顶部的图片也由它提供。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, 'maps')

const palette = {
  core: { accent: '#5b5bd6', soft: '#ecebff', label: 'CORE' },
  context: { accent: '#0c93ad', soft: '#e5f8fb', label: 'CONTEXT' },
  composition: { accent: '#8b5cf6', soft: '#f1eafe', label: 'COMPOSITION' },
  execution: { accent: '#b87412', soft: '#fff3dd', label: 'EXECUTION' },
  product: { accent: '#158a63', soft: '#e8f8f1', label: 'PRODUCT' },
  quality: { accent: '#b33a3a', soft: '#fbeaea', label: 'QUALITY' },
}

const lessons = [
  ['s01-agent-loop', 1, 'agent loop', '一次文本 turn 的完整闭环', 'core', ['User prompt', 'turn / step', 'DeepSeek SSE', 'StreamAssembler', 'assistant/message'], 'core/agent-loop/src/agent.ts'],
  ['s02-tool-round-trip', 2, 'tool round-trip', '工具调用如何回到下一轮请求', 'core', ['assistant tool-call', 'ToolRegistry', 'tool/result', 'surface append', 'next request'], 'core/agent-loop/src/agent.ts'],
  ['s03-session-log', 3, 'session log', 'append-only 事实与 surface 视图', 'core', ['events[]', 'surface[]', 'deriveMessages', 'ChatRequest', 'replace 不改日志'], 'core/session/src/{index,surface}.ts'],
  ['s04-streaming', 4, 'stream & attempt', 'chunk 如何变成可回放的 attempt', 'core', ['SSE chunk', 'StreamAssembler', 'AssistantStreamAttempt', 'assistant/message', 'assistant/attempt'], 'llm/llm/src/{assembler,assistant-stream}.ts'],
  ['s05-tool-contract', 5, 'tool contract', '作者写 TS，模型看 JSON Schema', 'core', ['TS DSL', 'JSON Schema', 'validate args', 'ToolSet', 'output contract'], 'core/tools/src/{schema,contracts}.ts'],
  ['s06-tool-runtime', 6, 'tool runtime', '一次工具调用的运行时流水线', 'core', ['tool/call', 'guard', 'approval', 'batch execute', 'result / recovery'], 'core/tools/src/{pipeline,batch}.ts'],
  ['s07-system-prompt', 7, 'system prompt', '提示词是组装结果，不是字符串常量', 'context', ['sections', 'variables', 'contexts', 'head admission', 'ChatRequest'], 'core/system-prompt/src/index.ts'],
  ['s08-inbox-steering', 8, 'inbox / steering', '运行中的 agent 如何接收输入', 'context', ['user input', 'inbox queues', 'claim', 'step / turn', 'agent'], 'core/agent-loop/src/{inbox,agent}.ts'],
  ['s09-llm-seam', 9, 'LLM seam', '模型调用是可替换的 I/O 边界', 'context', ['ChatRequest', 'prepareCall', 'provider', 'capabilities', 'retry / response'], 'llm/llm/src/{call-config,retry-policy}.ts'],
  ['s10-persistence', 10, 'persistence', '会话如何活过进程重启', 'context', ['append event', 'flush barrier', 'JSONL', 'restore / repair', 'fork / resume'], 'session/session-persistence/src/index.ts'],
  ['s11-compaction', 11, 'compaction', '上下文压力下改变模型视图', 'context', ['token pressure', 'prune results', 'summarize', 'surface replace', 'next request'], 'compaction/compaction-basic/src/index.ts'],
  ['s12-plugin-kernel', 12, 'plugin kernel', '能力如何变成可卸载的插件', 'composition', ['Context', 'Service', 'Fiber', 'effect', 'scope'], 'vendor/cordis/src/{context,fiber,events}.ts'],
  ['s13-composition-boot', 13, 'composition / boot', 'profile、bundle、patch 如何叠加', 'composition', ['profile', 'bundle', 'patch', 'required entry', 'boot'], 'boot/app-boot, bundle/base'],
  ['s14-capability-seams', 14, 'capability seams', 'agent 如何安全地碰真实世界', 'execution', ['tool call', 'fs / shell', 'sandbox', 'approval', 'result'], 'fs/tool-fs, shell, sandbox'],
  ['s15-subagents-presets', 15, 'subagents / presets', '委派、隔离与预算', 'execution', ['parent agent', 'spawn', 'child session', 'preset / budget', 'result'], 'subagent/subagent/src/manager.ts'],
  ['s16-ptc', 16, 'PTC', '模型写代码调用 tools.*', 'execution', ['model code', 'run_code', 'tools.*', 'result / error', 'next request'], 'ptc-runtime/ptc-runtime'],
  ['s17-mcp-skills-commands', 17, 'MCP / skills / commands', '不修改 loop 的外部能力', 'execution', ['MCP server', 'tools/list', 'tools/call', 'tool result', 'assistant'], 'mcp/mcp-client, skill, interaction/commands'],
  ['s18-skills-commands', 18, 'skills / commands', '技能目录与斜杠命令', 'execution', ['SKILL.md', 'catalog', 'load_skill', 'slash command', 'host dispatch'], 'skill/skill, interaction/commands'],
  ['s19-browser-use', 19, 'browser use', '浏览器 provider 与会话', 'execution', ['agent tool', 'browser provider', 'page / DOM', 'click / screenshot', 'result'], 'browser-use/browser-use'],
  ['s20-computer-use-i', 20, 'computer use I', '应用、窗口、AX 与截图', 'execution', ['CUA provider', 'app / window', 'AX snapshot', 'screenshot', 'model'], 'computer-use/computer-use, experimental/cua'],
  ['s21-computer-use-ii', 21, 'computer use II', '坐标、动作、权限与失效', 'execution', ['screenshot', 'coordinate', 'action', 'verify / stale', 'next step'], 'experimental/cua-macos, cua'],
  ['s22-web', 22, 'web', '投影、SSE 与断线重连', 'product', ['session events', 'projection', 'snapshot', 'SSE', 'client'], 'session/session-projection, host/webserver'],
  ['s23-sdk-headless', 23, 'SDK / headless', '把 harness 变成进程外服务', 'product', ['client', 'JSON-RPC', 'SDK server', 'agent', 'session/event'], 'sdk/protocol, sdk/server'],
  ['s24-client-ui', 24, 'client UI', '事件如何变成可渲染卡片', 'product', ['events', 'action cards', 'HTML', 'client', 'reconnect'], 'client/ui-renderer'],
  ['s25-observability-eval', 25, 'observability / eval', 'span、回放与快照', 'quality', ['span', 'trace', 'record / replay', 'snapshot', 'eval report'], 'telemetry/otel, snapshots'],
  ['s26-eval', 26, 'eval / fault injection', '可重复的 scenario 与故障矩阵', 'quality', ['scenario', 'record', 'replay', 'fault', 'report'], 'docs/testing.zh.md, snapshots'],
  ['s27-security', 27, 'security / permissions', '路径、审批、redaction 与授权', 'quality', ['tool input', 'path guard', 'approval', 'redaction', 'audit'], 'sandbox, interaction/user-approval'],
  ['s28-capstone', 28, 'capstone', '用完整 harness 跑真实任务', 'quality', ['task', 'agent loop', 'tools', 'artifacts', 'eval report'], 'core/agent-loop/src/agent.ts'],
]

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

function mapSvg([slug, n, title, subtitle, part, nodes, anchor]) {
  const p = palette[part]
  const count = nodes.length
  const margin = 52
  const gap = count >= 6 ? 24 : count === 5 ? 36 : 46
  const width = Math.min(190, Math.floor((1200 - margin * 2 - gap * (count - 1)) / count))
  const start = (1200 - (width * count + gap * (count - 1))) / 2
  const nodeY = 152
  const nodeH = 106
  const node = (label, i) => {
    const x = start + i * (width + gap)
    return `<g>
      <rect x="${x}" y="${nodeY}" width="${width}" height="${nodeH}" rx="14" fill="#ffffff" stroke="#dfe3ef"/>
      <rect x="${x}" y="${nodeY}" width="${width}" height="4" rx="2" fill="${p.accent}"/>
      <circle cx="${x + 22}" cy="${nodeY + 30}" r="12" fill="${p.soft}"/>
      <text x="${x + 22}" y="${nodeY + 34}" text-anchor="middle" font-size="10" font-family="SFMono-Regular, Consolas, monospace" fill="${p.accent}">${String(i + 1).padStart(2, '0')}</text>
      <text x="${x + 42}" y="${nodeY + 35}" font-size="${label.length > 18 ? 11 : label.length > 13 ? 12.5 : 14}" font-weight="650" fill="#161a2c">${esc(label)}</text>
      <text x="${x + 16}" y="${nodeY + 72}" font-size="9" font-family="SFMono-Regular, Consolas, monospace" fill="#a0a6b6">step ${i + 1}</text>
    </g>`
  }
  const arrows = nodes.slice(0, -1).map((_, i) => {
    const x1 = start + i * (width + gap) + width
    const x2 = x1 + gap
    const y = nodeY + nodeH / 2
    return `<path d="M${x1 + 4} ${y} H${x2 - 6}" stroke="#c9cfdf" stroke-width="1.5" marker-end="url(#arrow)"/>`
  }).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="420" viewBox="0 0 1200 420" role="img" aria-labelledby="title desc">
  <title id="title">s${String(n).padStart(2, '0')} ${esc(title)} 本课地图</title>
  <desc id="desc">${esc(subtitle)}</desc>
  <defs>
    <pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M30 0H0V30" fill="none" stroke="#303a63" stroke-opacity=".04"/></pattern>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10" fill="#c9cfdf"/></marker>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f8f9fc"/><stop offset="1" stop-color="#eef2fa"/></linearGradient>
  </defs>
  <rect width="1200" height="420" fill="url(#bg)"/><rect width="1200" height="420" fill="url(#grid)"/>
  <text x="52" y="48" font-size="10" letter-spacing=".12em" font-family="SFMono-Regular, Consolas, monospace" fill="${p.accent}">S${String(n).padStart(2, '0')} · ${p.label} · LESSON MAP</text>
  <text x="52" y="82" font-size="25" font-weight="720" letter-spacing="-.02em" fill="#161a2c">${esc(title)} <tspan fill="${p.accent}">/</tspan> <tspan font-size="19" font-weight="500" fill="#343b54">${esc(subtitle)}</tspan></text>
  ${arrows}
  ${nodes.map(node).join('\n')}
  <line x1="52" y1="326" x2="1148" y2="326" stroke="#e3e6ef"/>
  <text x="52" y="356" font-size="10" letter-spacing=".1em" font-family="SFMono-Regular, Consolas, monospace" fill="#8b91a5">新增边界</text>
  <text x="52" y="378" font-size="13" fill="#343b54">${esc(subtitle)}</text>
  <text x="1148" y="356" text-anchor="end" font-size="9" font-family="SFMono-Regular, Consolas, monospace" fill="#8b91a5">SOURCE ANCHOR</text>
  <text x="1148" y="378" text-anchor="end" font-size="10" font-family="SFMono-Regular, Consolas, monospace" fill="#5b5bd6">${esc(anchor)}</text>
  <text x="52" y="406" font-size="9" font-family="SFMono-Regular, Consolas, monospace" fill="#a0a6b6">Learn DeepSeek Harness · 28 lessons v3</text>
</svg>`
}

await mkdir(outDir, { recursive: true })
for (const lesson of lessons) {
  const [, n] = lesson
  await writeFile(resolve(outDir, `s${String(n).padStart(2, '0')}.svg`), mapSvg(lesson))
}
console.log(`wrote ${lessons.length} maps -> ${outDir}`)
