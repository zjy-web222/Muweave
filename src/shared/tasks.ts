import type { AiTask, Job } from './schema'

export type Task = AiTask | Job
export const isExecutingTask = (task: Task) =>
  ['submitting', 'running', 'downloading'].includes(task.status)
export const isFinishedTask = (task: Task) =>
  ['succeeded', 'failed', 'cancelled'].includes(task.status)
export const isAITask = (task: Task): task is AiTask => 'kind' in task && task.kind === 'ai'
export const taskScheduledAt = (task: Task) => task.scheduledAt || task.createdAt
export function sortTasks(tasks: Task[]) {
  return [...tasks].sort(
    (a, b) =>
      Number(isExecutingTask(b)) - Number(isExecutingTask(a)) ||
      taskScheduledAt(b).localeCompare(taskScheduledAt(a)),
  )
}
