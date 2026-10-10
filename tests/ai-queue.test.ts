import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store, createProject } from '../src/main/store'
import { Queue, RunningHub } from '../src/main/runninghub'
import { aiTaskSchema, type AiRequest, type AiTask } from '../src/shared/schema'

let root: string, store: Store, queue: Queue
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'muweave-ai-queue-'))
  store = new Store(root)
  queue = new Queue(store, new RunningHub(() => ''), () => {})
})
afterEach(async () => {
  queue.stop()
  vi.useRealTimers()
  store.close()
  await rm(root, { recursive: true, force: true })
})
const requests = (project = store.save(createProject('AI queue', '16:9', true))): AiRequest[] => [
  { type: 'generateImage', projectId: project.id, ownerId: project.assets[0].id, slot: 'reference' },
  { type: 'scriptChatGenerate', projectId: project.id, episodeId: project.episodes[0].id, request: '继续剧本', attachmentIds: [] },
  { type: 'generateStoryboard', projectId: project.id, episodeId: project.episodes[0].id, request: '生成两个镜头' },
]

describe('shared persistent AI queue', () => {
  it('serializes mixed image, chat and storyboard requests in submission order and deduplicates active requests', async () => {
    const input = requests(), started: string[] = []
    let finish!: (value: { text: string }) => void, active = 0, maxActive = 0
    queue.setAIProcessor(async (task) => {
      started.push(task.request.type)
      maxActive = Math.max(maxActive, ++active)
      const result = await new Promise<{ text: string }>((resolve) => { finish = resolve })
      active--
      return result
    })
    const ids = input.map((request) => queue.enqueueAI(request, request.type))
    expect(queue.enqueueAI(input[1], 'Repeated click')).toBe(ids[1])
    expect(store.aiTask(ids[0]).status).toBe('running')
    expect(store.aiTask(ids[1]).status).toBe('queued')
    expect(store.jobs()).toEqual([])
    for (let i = 0; i < ids.length; i++) {
      const done = queue.waitAI(ids[i])
      finish({ text: `result ${i}` })
      expect(await done).toMatchObject({ status: 'succeeded', resultText: `result ${i}` })
    }
    expect(started).toEqual(input.map((request) => request.type))
    expect(maxActive).toBe(1)
  })

  it('cancels only waiting tasks, advances after failure and retries only on an explicit action', async () => {
    const input = requests()
    let reject!: (reason: Error) => void
    const processor = vi.fn(async () => await new Promise<{ text: string }>((_resolve, fail) => { reject = fail }))
    queue.setAIProcessor(processor)
    const running = queue.enqueueAI(input[0], 'image')
    const cancelled = queue.enqueueAI(input[1], 'chat')
    const next = queue.enqueueAI(input[2], 'storyboard')
    const cancelledWait = queue.waitAI(cancelled)
    await queue.aiAction(cancelled, 'cancel')
    expect((await cancelledWait).status).toBe('cancelled')
    await expect(queue.aiAction(running, 'cancel')).rejects.toThrow('尚未开始')
    const failure = queue.waitAI(running)
    reject(new Error('Unknown remote outcome: check before retry'))
    expect((await failure).status).toBe('failed')
    expect(processor).toHaveBeenCalledTimes(2)
    expect(store.aiTask(next).status).toBe('running')
    const nextFailure = queue.waitAI(next)
    reject(new Error('quota exceeded'))
    await nextFailure
    expect(processor).toHaveBeenCalledTimes(2)
    queue.setAIProcessor(async () => ({ text: 'manual retry result' }))
    await queue.aiAction(running, 'retry')
    expect((await queue.waitAI(running)).resultText).toBe('manual retry result')
    expect(store.aiTask(cancelled).status).toBe('cancelled')
  })

  it('restores waiting work from SQLite but never resubmits a previously running task', async () => {
    const input = requests(), now = new Date().toISOString()
    const interrupted: AiTask = {
      kind: 'ai', id: randomUUID(), projectId: input[0].projectId, title: 'interrupted',
      request: input[0], attachments: [], status: 'running', createdAt: now, updatedAt: now,
    }
    store.saveJob(interrupted)
    store.set('config', { ...store.config(), paused: true })
    const waiting = queue.enqueueAI(input[1], 'waiting')
    queue.stop()
    store.close()
    store = new Store(root)
    queue = new Queue(store, new RunningHub(() => ''), () => {})
    const processor = vi.fn(async (_task: AiTask) => ({ text: 'restored' }))
    queue.setAIProcessor(processor)
    vi.useFakeTimers()
    queue.start()
    expect(store.aiTask(interrupted.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('手动重试') })
    expect(store.aiTask(waiting).status).toBe('queued')
    expect(processor).not.toHaveBeenCalled()
    store.set('config', { ...store.config(), paused: false })
    await vi.advanceTimersByTimeAsync(5000)
    expect((await queue.waitAI(waiting)).status).toBe('succeeded')
    expect(processor).toHaveBeenCalledTimes(1)
    expect(processor.mock.calls[0][0].request.type).toBe('scriptChatGenerate')
  })

  it('does not confuse projects with identical prompts or accept mismatched task ownership', async () => {
    const first = requests()[1], second = requests()[1]
    store.set('config', { ...store.config(), paused: true })
    const one = queue.enqueueAI(first, 'one'), two = queue.enqueueAI(second, 'two')
    expect(one).not.toBe(two)
    expect(() => aiTaskSchema.parse({ ...store.aiTask(one), projectId: second.projectId })).toThrow('任务项目不一致')
  })

  it('fails oversized output without blocking the next task', async () => {
    const input = requests()
    queue.setAIProcessor(async (task) => ({ text: task.request.type === 'generateImage' ? 'x'.repeat(200001) : 'valid' }))
    const one = queue.enqueueAI(input[0], 'oversized'), two = queue.enqueueAI(input[1], 'next')
    expect((await queue.waitAI(one)).status).toBe('failed')
    expect((await queue.waitAI(two)).status).toBe('succeeded')
    expect(store.aiTask(one).resultText).toBeUndefined()
  })
})
