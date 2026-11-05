#!/usr/bin/env node
/**
 * 学习第 x 课时，把第 x-1 课的代码复制到 course/practice/。
 *
 *   node scripts/learn.mjs 6
 *   node scripts/learn.mjs s06
 *
 * - 清空 course/practice/ 里的旧代码
 * - 保留 course/practice/.env
 * - 不复制 source lesson 的 .env / node_modules
 */
import { cp, mkdir, readdir, rm, stat, copyFile, chmod } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lessonsDir = join(root, 'course', 'lessons')
const practice = join(root, 'course', 'practice')

function fail(message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

const dryRun = process.argv.includes('--dry-run')
const raw = process.argv.slice(2).find(value => !value.startsWith('--'))
if (raw === undefined) {
  fail('用法：node scripts/learn.mjs <课号>\n例如：node scripts/learn.mjs 6  # 复制 s05 到 practice')
}
const match = String(raw).match(/^s?0*(\d{1,2})$/i)
if (match === null) fail(`无法识别课号：${raw}。请用 6 / s06 这样的格式。`)
const x = Number(match[1])
if (x < 2 || x > 28) fail(`课号范围是 2–28；第 ${x} 课没有“上一课”可复制。`)
const previous = x - 1
const prefix = `s${String(previous).padStart(2, '0')}-`

const entries = await readdir(lessonsDir, { withFileTypes: true })
const sourceName = entries.find(entry => entry.isDirectory() && entry.name.startsWith(prefix))?.name
if (sourceName === undefined) fail(`找不到 ${prefix}* 课程目录。`)
const source = join(lessonsDir, sourceName)

await mkdir(practice, { recursive: true })
const envPath = join(practice, '.env')
const hadEnv = await stat(envPath).then(info => info.isFile()).catch(() => false)
const oldEntries = await readdir(practice)
if (dryRun) {
  console.log(`\n[dry-run] 将清空 course/practice/（保留 .env），然后复制：`)
  console.log(`  course/lessons/${sourceName}/ → course/practice/`)
  process.exit(0)
}
for (const name of oldEntries) {
  if (name === '.env') continue
  await rm(join(practice, name), { recursive: true, force: true })
}

const sourceEntries = await readdir(source, { withFileTypes: true })
for (const entry of sourceEntries) {
  if (entry.name === '.env' || entry.name === 'node_modules' || entry.name === '.git') continue
  await cp(join(source, entry.name), join(practice, entry.name), { recursive: true })
}

// 如果 practice 原本没有 .env，回落使用上一课的 .env；有则绝不覆盖。
if (!hadEnv) {
  const sourceEnv = join(source, '.env')
  const hasSourceEnv = await stat(sourceEnv).then(info => info.isFile()).catch(() => false)
  if (hasSourceEnv) {
    await copyFile(sourceEnv, envPath)
    await chmod(envPath, 0o600)
  }
}

console.log(`\n✓ 已准备第 ${x} 课：s${String(previous).padStart(2, '0')} → course/practice/`)
console.log(`  来源：course/lessons/${sourceName}`)
console.log(`  目标：course/practice/`)
console.log(`  旧代码：已清空`)
console.log(`  .env：${hadEnv ? '保留 practice 原有文件' : '已从上一课补入（如果没有则跳过）'}`)
console.log(`\n下一步：\n  cd course/practice\n  node src/demo.ts\n  node --test tests/*.test.ts\n`)
