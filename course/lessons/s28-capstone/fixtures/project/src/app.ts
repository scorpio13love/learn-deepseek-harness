export interface Task {
  id: number
  title: string
  done: boolean
}

const tasks: Task[] = []

// TODO: reject empty titles before adding a task
export function addTask(id: number, title: string): Task {
  const task: Task = { id, title, done: false }
  tasks.push(task)
  return task
}

export function listTasks(): Task[] {
  return [...tasks]
}

export function completeTask(id: number): boolean {
  const task = tasks.find(candidate => candidate.id === id)
  if (task === undefined) return false
  task.done = true
  return true
}

if (import.meta.url === `file://${process.argv[1]}`) {
  addTask(1, 'write the capstone')
  console.log(listTasks())
}
