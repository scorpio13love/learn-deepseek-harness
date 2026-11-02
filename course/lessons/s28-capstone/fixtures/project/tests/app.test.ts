import assert from 'node:assert/strict'
import { test } from 'node:test'

import { addTask, completeTask, listTasks } from '../src/app.ts'
import { normalizeTitle, slugify } from '../src/util.ts'

// TODO: cover duplicate ids and empty titles
test('add and complete a task', () => {
  const task = addTask(1, 'demo')
  assert.equal(task.done, false)
  assert.equal(completeTask(1), true)
  assert.equal(listTasks().length > 0, true)
})

test('normalizeTitle', () => {
  assert.equal(normalizeTitle('  hello  '), 'hello')
  assert.equal(slugify('Hello World'), 'hello-world')
})
