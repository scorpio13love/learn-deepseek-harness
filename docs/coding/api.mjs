/**
 * AI Coding Lab 的本地 API：运行 TS 测试 + 转发 DeepSeek Messages。
 * 只绑定在本机站点服务器上；key 永远不下发到浏览器。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { tasks } from './tasks.mjs'

const MAX_BODY = 256 * 1024
const RUN_TIMEOUT = 8000
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'
const BASE = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic').replace(/\/$/, '')

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function body(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('request too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function publicTask(task) {
  return {
    id: task.id,
    title: task.title,
    lesson: task.lesson,
    knowledge: task.knowledge,
    prompt: task.prompt,
    starter: task.starter,
    answer: task.answer,
    source: task.source ?? null,
    tests: task.tests.map((_, index) => `test ${index + 1}`),
  }
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, RUN_TIMEOUT)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

function parseTap(stdout, expected) {
  const results = new Map()
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(not ok|ok)\s+\d+\s+-\s+(.+)$/)
    if (match) results.set(match[2].trim(), match[1] === 'ok')
  }
  return expected.map((name, index) => ({
    name,
    pass: results.get(name) ?? false,
    index: index + 1,
  }))
}

async function runTests(task, code) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-coding-'))
  try {
    await writeFile(join(dir, 'submission.ts'), code, 'utf8')
    const testFile = [
      "import test from 'node:test'",
      "import assert from 'node:assert/strict'",
      "import * as s from './submission.ts'",
      '',
      ...task.tests.flatMap((body, index) => [
        `test(${JSON.stringify(`test ${index + 1}`)}, () => {`,
        body,
        '})',
        '',
      ]),
    ].join('\n')
    await writeFile(join(dir, 'test.ts'), testFile, 'utf8')
    const result = await run(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', 'test.ts'], { cwd: dir })
    const tests = parseTap(result.stdout, task.tests.map((_, index) => `test ${index + 1}`))
    const compileError = /SyntaxError|TypeError|ERR_UNSUPPORTED_TYPESCRIPT|Cannot find module|Error:/.test(result.stderr) && tests.every(test => !test.pass)
    return {
      ok: result.code === 0 && tests.every(test => test.pass),
      tests,
      stdout: result.stdout.slice(-12000),
      stderr: result.stderr.slice(-12000),
      compileError,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function askModel(task, code, message, history, keyOverride, mode = 'chat') {
  const key = keyOverride || process.env.DEEPSEEK_API_KEY
  if (!key) {
    const error = new Error('DEEPSEEK_API_KEY 未配置：在页面“配置 Key”里填入，或用 `DEEPSEEK_API_KEY=... node site/serve.mjs` 启动')
    error.status = 503
    throw error
  }
  const system = mode === 'test'
    ? '你是连接测试助手。只回复：OK'
    : `你是 Learn DeepSeek Harness 的 AI coding 教练。用户在本地 TypeScript 编辑器里完成一道题，测试在本地 Node 运行。请用中文回答。
不要直接替用户写完整个答案；优先解释概念、指出测试失败原因、给下一步可执行的小提示。用户明确要求时再给局部代码。
题目：${task.title}
课程：${task.lesson}
知识点：${task.knowledge}
任务：${task.prompt}
当前代码：
\`\`\`ts
${code.slice(0, 12000)}
\`\`\``
  const messages = mode === 'test'
    ? [{ role: 'user', content: '只回复 OK' }]
    : [
      ...history.filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string').slice(-8).map(item => ({ role: item.role, content: item.content.slice(0, 6000) })),
      { role: 'user', content: message.slice(0, 6000) },
    ]
  const response = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: mode === 'test' ? 32 : 900, system, messages }),
    signal: AbortSignal.timeout(45000),
  })
  if (!response.ok) {
    const text = await response.text()
    const error = new Error(`模型请求失败 ${response.status}: ${text.slice(0, 500)}`)
    error.status = response.status === 401 ? 401 : 502
    throw error
  }
  const data = await response.json()
  const text = Array.isArray(data.content)
    ? data.content.filter(block => block.type === 'text').map(block => block.text).join('')
    : ''
  return text || '(模型没有返回文本)'
}

export async function handleCodingApi(request, response, url) {
  try {
    if (request.method === 'GET' && url.pathname === '/api/coding/health') {
      return json(response, 200, {
        ok: true,
        keyConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
        model: MODEL,
        base: BASE,
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/coding/tasks') {
      return json(response, 200, { tasks: tasks.map(publicTask) })
    }
    if (request.method === 'POST' && url.pathname === '/api/coding/run') {
      const data = await body(request)
      const task = tasks.find(item => item.id === data.taskId)
      if (!task) return json(response, 404, { error: 'unknown task' })
      if (typeof data.code !== 'string' || data.code.length > 100000) return json(response, 400, { error: 'invalid code' })
      return json(response, 200, await runTests(task, data.code))
    }
    if (request.method === 'POST' && url.pathname === '/api/coding/test') {
      const key = request.headers['x-deepseek-key']
      const text = await askModel(null, '', '只回复 OK', [], typeof key === 'string' ? key : undefined, 'test')
      return json(response, 200, { ok: true, text, model: MODEL })
    }
    if (request.method === 'POST' && url.pathname === '/api/coding/chat') {
      const data = await body(request)
      const task = tasks.find(item => item.id === data.taskId)
      if (!task) return json(response, 404, { error: 'unknown task' })
      if (typeof data.message !== 'string' || data.message.trim().length === 0) return json(response, 400, { error: 'empty message' })
      if (typeof data.code !== 'string' || data.code.length > 100000) return json(response, 400, { error: 'invalid code' })
      const key = request.headers['x-deepseek-key']
      const text = await askModel(task, data.code, data.message, Array.isArray(data.history) ? data.history : [], typeof key === 'string' ? key : undefined)
      return json(response, 200, { text })
    }
    return json(response, 404, { error: 'not found' })
  } catch (error) {
    const status = error?.status ?? (error?.message === 'request too large' ? 413 : 500)
    return json(response, status, { error: error instanceof Error ? error.message : String(error) })
  }
}
