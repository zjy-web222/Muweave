import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store, createProject } from '../src/main/store'
import { Queue, RunningHub } from '../src/main/runninghub'
import { ModelAPI } from '../src/main/models'
import { defaultModel } from '../src/shared/models'
import { type AiTask, type Job, type Project } from '../src/shared/schema'
import { sortTasks } from '../src/shared/tasks'

let root: string, store: Store, queue: Queue, project: Project
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'muweave-task-management-'))
  store = new Store(root)
  project = store.save(createProject('Task management', '16:9', true))
  queue = new Queue(store, new RunningHub(() => ''), () => {})
})
afterEach(async () => {
  queue.stop()
  store.close()
  await rm(root, { recursive: true, force: true })
})
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
function video(status: Job['status'], createdAt = '2026-10-11T00:00:00.000Z'): Job {
  return {
    id: randomUUID(),
    projectId: project.id,
    shotId: project.shots[0].id,
    status,
    site: store.config().site,
    workflowId: '123',
    snapshot: project.shots[0],
    mappings: [],
    createdAt,
    updatedAt: createdAt,
    stopOnFailure: false,
    outputs: [],
    pollErrors: 0,
  }
}
function ai(status: AiTask['status'], createdAt: string): AiTask {
  return {
    kind: 'ai',
    id: randomUUID(),
    projectId: project.id,
    title: 'AI task',
    request: {
      type: 'generateStoryboard',
      projectId: project.id,
      episodeId: project.episodes[0].id,
      request: '',
    },
    status,
    attachments: [],
    createdAt,
    updatedAt: createdAt,
  }
}

describe('task management', () => {
  it('pins executing tasks across AI and video, then sorts by most recent scheduling time', () => {
    const running = video('running'),
      old = ai('queued', '2026-10-10T00:00:00.000Z')
    const recent = video('queued', '2026-10-11T03:00:00.000Z')
    const retried = { ...video('failed'), scheduledAt: '2026-10-11T04:00:00.000Z' }
    const input = [old, recent, running, retried]
    expect(sortTasks(input).map((task) => task.id)).toEqual([
      running.id,
      retried.id,
      recent.id,
      old.id,
    ])
    expect(input[0]).toBe(old)
  })

  it('aborts current AI work, rejects late results and lets newly submitted work run', async () => {
    let complete!: (result: { text: string }) => void
    let signal!: AbortSignal
    const processor = vi.fn(async (_task: AiTask, currentSignal: AbortSignal) => {
      signal = currentSignal
      return new Promise<{ text: string }>((resolve) => {
        complete = resolve
      })
    })
    queue.setAIProcessor(processor)
    const first = ai('queued', new Date().toISOString())
    const running = queue.enqueueAI(first.request, 'first')
    const waiting = queue.enqueueAI(
      {
        type: 'generateStoryboard',
        projectId: project.id,
        episodeId: project.episodes[0].id,
        request: 'another request',
      },
      'waiting',
    )
    const done = queue.waitAI(running)
    expect(queue.terminateAll()).toBe(2)
    expect(signal.aborted).toBe(true)
    expect(store.aiTask(waiting).status).toBe('cancelled')
    expect(store.config().paused).toBe(false)
    complete({ text: 'late result' })
    expect((await done).status).toBe('cancelled')
    expect(store.aiTask(running).resultText).toBeUndefined()
    expect(processor).toHaveBeenCalledTimes(1)
    processor.mockResolvedValueOnce({ text: 'new result' })
    const next = queue.enqueueAI(first.request, 'new task after stop all')
    expect(await queue.waitAI(next)).toMatchObject({ status: 'succeeded', resultText: 'new result' })
    expect(store.aiTask(waiting).status).toBe('cancelled')
    expect(processor).toHaveBeenCalledTimes(2)
  })

  it('clears a legacy global pause when stopping all and allows an explicit video retry', async () => {
    store.set('config', { ...store.config(), paused: true })
    const job = video('queued')
    store.saveJob(job)
    const api = {
      start: vi.fn().mockResolvedValue('new-paid-task'),
      status: vi.fn(),
    } as unknown as RunningHub
    queue = new Queue(store, api, () => {})
    expect(queue.terminateAll()).toBe(1)
    expect(store.config().paused).toBe(false)
    expect(store.job(job.id).status).toBe('cancelled')
    expect(api.start).not.toHaveBeenCalled()
    await queue.action(job.id, 'retry')
    await settle()
    expect(store.job(job.id)).toMatchObject({ status: 'running', taskId: 'new-paid-task' })
    expect(api.start).toHaveBeenCalledTimes(1)
  })

  it('retains the ID when terminating during a paid submission and cancels it once returned', async () => {
    const job = video('queued')
    store.saveJob(job)
    let finish!: (id: string) => void
    const api = {
      start: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve
          }),
      ),
      cancel: vi.fn().mockResolvedValue(undefined),
      status: vi.fn(),
    } as unknown as RunningHub
    queue = new Queue(store, api, () => {})
    queue.start()
    await settle()
    expect(store.job(job.id).status).toBe('submitting')
    queue.terminateAll()
    expect(store.job(job.id)).toMatchObject({ status: 'submitting', cancelRequested: true })
    finish('original-paid-task')
    await settle()
    expect(store.job(job.id)).toMatchObject({ status: 'cancelled', taskId: 'original-paid-task' })
    expect(api.start).toHaveBeenCalledTimes(1)
    expect(api.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'original-paid-task' }),
    )
  })

  it('keeps interrupted and unknown paid submissions available for manual verification after restart', async () => {
    const unknown = { ...video('submitting'), cancelRequested: true }
    store.saveJob(unknown)
    const api = { start: vi.fn(), status: vi.fn() } as unknown as RunningHub
    queue = new Queue(store, api, () => {})
    queue.start()
    await settle()
    expect(store.job(unknown.id)).toMatchObject({ status: 'uncertain', cancelRequested: true })
    await expect(queue.action(unknown.id, 'retry')).rejects.toThrow('待确认')
    expect(() => queue.deleteTask(unknown.id)).toThrow('任务结束')
    expect(api.start).not.toHaveBeenCalled()
  })

  it('keeps a create timeout uncertain even when stop all was requested during submission', async () => {
    const job = video('queued')
    store.saveJob(job)
    let fail!: (error: Error) => void
    const api = {
      start: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject
          }),
      ),
      cancel: vi.fn(),
      status: vi.fn(),
    } as unknown as RunningHub
    queue = new Queue(store, api, () => {})
    queue.start()
    await settle()
    queue.terminateAll()
    fail(new Error('connection lost after create'))
    await settle()
    expect(store.job(job.id)).toMatchObject({ status: 'uncertain', cancelRequested: true })
    expect(store.job(job.id).error).toContain('原提交结果未知')
    expect(api.start).toHaveBeenCalledTimes(1)
    expect(api.cancel).not.toHaveBeenCalled()
  })

  it('prevents query recovery and deletion from racing an in-flight remote cancellation', async () => {
    const job = { ...video('running'), taskId: 'original-remote' }
    store.saveJob(job)
    let finish!: () => void
    const api = {
      cancel: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      ),
    } as unknown as RunningHub
    queue = new Queue(store, api, () => {})
    queue.terminateAll()
    await expect(queue.action(job.id, 'attach', job.taskId)).rejects.toThrow('同步或终止')
    expect(() => queue.deleteTask(job.id)).toThrow('终止完成')
    finish()
    await settle()
    expect(store.job(job.id)).toMatchObject({ status: 'cancelled', taskId: 'original-remote' })
    queue.deleteTask(job.id)
    expect(store.jobs()).toEqual([])
  })

  it('does not resurrect a locally terminated video when an in-flight poll finishes', async () => {
    const job = {
      ...video('running'),
      taskId: 'existing-remote',
      model: defaultModel('video', 'minimax'),
    }
    store.saveJob(job)
    let finish!: (result: { status: string; urls: string[] }) => void
    const models = {
      videoResult: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
    } as unknown as ModelAPI
    queue = new Queue(store, new RunningHub(() => ''), () => {}, undefined, models)
    queue.start()
    queue.terminateAll()
    finish({ status: 'SUCCESS', urls: ['https://example.invalid/result.mp4'] })
    await settle()
    expect(store.job(job.id)).toMatchObject({ status: 'cancelled', taskId: 'existing-remote' })
    expect(store.project(project.id).media).toEqual([])
    expect(store.job(job.id).error).toContain('不支持远端取消')
  })

  it('deletes finished records without removing project media, and protects live dependencies', () => {
    const done = { ...video('failed'), batchId: 'batch-one' }
    const dependent = { ...video('queued'), batchId: 'batch-one', shotId: project.shots[1].id }
    store.saveJob(done)
    store.saveJob(dependent)
    expect(() => queue.deleteTask(done.id)).toThrow('同批')
    queue.terminateAll()
    queue.deleteTask(done.id)
    expect(store.jobs().some((task) => task.id === done.id)).toBe(false)
    expect(store.project(project.id)).toEqual(project)
    const finishedAI = ai('succeeded', new Date().toISOString())
    store.saveJob(finishedAI)
    queue.deleteTask(finishedAI.id)
    expect(store.aiTasks()).toEqual([])
  })

  it('allows explicit query recovery of a stopped remote video without resubmitting', async () => {
    const job = { ...video('cancelled'), taskId: 'keep-id', cancelRequested: true }
    store.saveJob(job)
    store.set('config', { ...store.config(), paused: true })
    const api = {
      status: vi.fn().mockResolvedValue('RUNNING'),
      start: vi.fn(),
    } as unknown as RunningHub
    queue = new Queue(store, api, () => {})
    await queue.action(job.id, 'attach', job.taskId)
    await settle()
    expect(store.job(job.id)).toMatchObject({
      status: 'running',
      taskId: 'keep-id',
      cancelRequested: false,
    })
    expect(api.start).not.toHaveBeenCalled()
  })

  it('propagates local cancellation to the official API request', async () => {
    let submitted!: () => void
    const started = new Promise<void>((resolve) => {
      submitted = resolve
    })
    const transport = vi.fn<typeof fetch>(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          })
          submitted()
        }),
    )
    const api = new ModelAPI(() => ({ key: 'fixture-key' }), transport),
      controller = new AbortController()
    const pending = api.text(
      defaultModel('text', 'openai'),
      'fixture prompt',
      undefined,
      [],
      controller.signal,
    )
    await started
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(transport).toHaveBeenCalledTimes(1)
  })
})
