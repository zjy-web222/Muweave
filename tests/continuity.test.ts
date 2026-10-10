import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, createProject } from '../src/main/store'
import { importMedia } from '../src/main/media'
import { Queue, RunningHub } from '../src/main/runninghub'
import { ModelAPI } from '../src/main/models'
import { blankShot, defaultConfig, type Project } from '../src/shared/schema'
import { defaultModel, defaultModels } from '../src/shared/models'
import { planVideoContinuity, sameScene } from '../src/shared/continuity'
import graph from './fixtures/director-ref2va-api.json'

let root: string, store: Store
const queues: Queue[] = []
const ffmpeg = promisify(execFile)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'muweave-boundaries-'))
  store = new Store(root)
  store.set('config', { ...defaultConfig, paused: true })
})
afterEach(async () => {
  for (const queue of queues.splice(0)) queue.stop()
  vi.restoreAllMocks()
  store.close()
  await rm(root, { recursive: true, force: true })
})
function project() {
  const p = createProject('boundary continuity', '16:9', true)
  p.shots = Array.from({ length: 5 }, (_, i) => ({
    ...blankShot(p.episodes[0].id),
    title: `镜头 ${i + 1}`,
    scene: '咖啡馆·内·日',
    action: `只执行动作 ${i + 1}`,
    dialogue: `角色：对白 ${i + 1}`,
    speaker: '角色',
    duration: 5,
  }))
  return store.save(p)
}
async function retain(p: Project, indexes: number[], file?: string) {
  const path = file || join(root, 'placeholder.mp4')
  if (!file) await writeFile(path, 'fixture video, not decoded by planner tests')
  for (const i of indexes) await importMedia(store, p.id, p.shots[i].id, 'video', path)
  return store.project(p.id)
}
async function clip(name: string, start: string, end: string) {
  const file = join(root, `${name}.mp4`)
  await ffmpeg(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${start}:s=160x90:r=24:d=0.5`,
      '-f',
      'lavfi',
      '-i',
      `color=c=${end}:s=160x90:r=24:d=0.5`,
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      file,
    ],
    { windowsHide: true, timeout: 15000 },
  )
  return file
}
async function pixel(path: string) {
  const { stdout } = await ffmpeg(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      path,
      '-vf',
      'scale=1:1',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { windowsHide: true, timeout: 15000, encoding: 'buffer' },
  )
  return [...stdout.subarray(0, 3)]
}
function queue(api: RunningHub, models?: ModelAPI) {
  const q = new Queue(store, api, () => {}, undefined, models)
  queues.push(q)
  return q
}
function unpause(q: Queue) {
  store.set('config', { ...store.config(), paused: false })
  q.start()
}

describe('retained video boundary planning', () => {
  it('leaves missing neighbours unset instead of blocking or skipping to distant videos', async () => {
    let p = project()
    p = await retain(p, [0, 4])
    expect(planVideoContinuity(p, p.shots[2], new Set([p.shots[2].id]))).toEqual({
      previous: undefined,
      next: undefined,
    })
    queue({} as RunningHub).enqueue(p.id, [p.shots[2].id], false)
    expect(store.jobs()[0].previousShotId).toBeUndefined()
    expect(store.jobs()[0].nextVideoMediaId).toBeUndefined()
  })
  it('pins both retained video versions for a single replacement', async () => {
    const p = await retain(project(), [0, 1, 2])
    queue({} as RunningHub).enqueue(p.id, [p.shots[1].id], false)
    expect(store.jobs()[0]).toMatchObject({
      previousShotId: p.shots[0].id,
      previousVideoMediaId: p.shots[0].videoMediaId,
      nextShotId: p.shots[2].id,
      nextVideoMediaId: p.shots[2].videoMediaId,
    })
  })
  it('chains consecutive replacements through NEW outputs and only targets a retained successor', async () => {
    const p = await retain(project(), [0, 1, 2, 3, 4])
    queue({} as RunningHub).enqueue(p.id, [p.shots[2].id, p.shots[1].id], false)
    const first = store.jobs().find((j) => j.shotId === p.shots[1].id)!
    const second = store.jobs().find((j) => j.shotId === p.shots[2].id)!
    expect(first.previousVideoMediaId).toBe(p.shots[0].videoMediaId)
    expect(first.nextVideoMediaId).toBeUndefined()
    expect(second.previousShotId).toBe(p.shots[1].id)
    expect(second.previousVideoMediaId).toBeUndefined()
    expect(second.nextVideoMediaId).toBe(p.shots[3].videoMediaId)
  })
  it('reconnects disjoint replacements to the retained shot between them', async () => {
    const p = await retain(project(), [0, 1, 2, 3, 4])
    const selected = new Set([p.shots[1].id, p.shots[3].id])
    expect(planVideoContinuity(p, p.shots[1], selected).next?.videoMediaId).toBe(
      p.shots[2].videoMediaId,
    )
    expect(planVideoContinuity(p, p.shots[3], selected).previous?.videoMediaId).toBe(
      p.shots[2].videoMediaId,
    )
  })
  it('does not cross an explicit scene change or episode boundary', async () => {
    const p = await retain(project(), [0, 2])
    p.shots[0].scene = '公园·外·日'
    p.shots[2].scene = '咖啡馆·内·夜'
    expect(planVideoContinuity(p, p.shots[1], new Set([p.shots[1].id]))).toEqual({
      previous: undefined,
      next: undefined,
    })
    expect(sameScene({ ...p.shots[1], episodeId: 'different-episode' }, p.shots[1], p)).toBe(false)
  })
  it('does not use a successor being changed by another active task', async () => {
    const p = await retain(project(), [2])
    const q = queue({} as RunningHub)
    q.enqueue(p.id, [p.shots[2].id], false)
    expect(
      planVideoContinuity(p, p.shots[1], new Set([p.shots[1].id]), store.jobs()).next,
    ).toBeUndefined()
  })
  it('rejects an unsupported Hailuo end target before creating paid work', async () => {
    const p = await retain(project(), [2])
    store.set('config', {
      ...store.config(),
      models: { ...defaultModels, video: defaultModel('video', 'minimax') },
    })
    expect(() => queue({} as RunningHub).enqueue(p.id, [p.shots[1].id], false)).toThrow(
      '不支持尾帧控制',
    )
    expect(store.jobs()).toHaveLength(0)
  })
})

describe('actual video frames sent to generation', () => {
  it('keeps a successor-only closing target separate from asset identity images, without inventing a first frame', async () => {
    let p = project()
    p = await retain(p, [2], await clip('successor-only', 'blue', 'yellow'))
    const portrait = join(root, 'identity.png')
    await writeFile(
      portrait,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    )
    await importMedia(store, p.id, p.assets[0].id, 'reference', portrait)
    store.update(p.id, (current) => {
      current.shots[1].assetIds = [p.assets[0].id]
    })
    const api = {
      workflow: vi.fn().mockResolvedValue(graph),
      status: vi.fn().mockResolvedValue('RUNNING'),
      upload: vi.fn(async (_site: string, file: string) => file.split(/[\\/]/).at(-1)),
      start: vi.fn().mockResolvedValue('fixture-end-only'),
    } as unknown as RunningHub
    const q = queue(api)
    q.enqueue(p.id, [p.shots[1].id], false)
    unpause(q)
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1), { timeout: 15000 })
    const prompt = String(vi.mocked(api.start).mock.calls[0][2]!['13'].inputs.prompt)
    expect(prompt).toContain('end in the state of <Picture 1>')
    expect(prompt).not.toContain('At 0.00 seconds')
    expect(
      Object.values(vi.mocked(api.start).mock.calls[0][2]!).filter(
        (n) => n.class_type === 'RHMiniMaxH3Ref2VAImageReference',
      ),
    ).toHaveLength(2)
  }, 20000)
  it('sends the predecessor LAST and successor FIRST frame as labelled Ref2VA boundaries, keeping dialogue separate', async () => {
    let p = project()
    p = await retain(p, [0], await clip('before', 'red', 'green'))
    p = await retain(p, [2], await clip('after', 'blue', 'yellow'))
    const uploaded: number[][] = []
    const api = {
      workflow: vi.fn().mockResolvedValue(graph),
      status: vi.fn().mockResolvedValue('RUNNING'),
      upload: vi.fn(async (_site: string, file: string) => {
        if (file.endsWith('.png')) uploaded.push(await pixel(file))
        return file.split(/[\\/]/).at(-1)!
      }),
      start: vi.fn().mockResolvedValue('fixture-ref2va'),
    } as unknown as RunningHub
    const q = queue(api)
    q.enqueue(p.id, [p.shots[1].id], false)
    unpause(q)
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1), { timeout: 15000 })
    expect(uploaded).toHaveLength(2)
    expect(uploaded[0][1]).toBeGreaterThan(100)
    expect(uploaded[0][0]).toBeLessThan(15)
    expect(uploaded[1][2]).toBeGreaterThan(220)
    expect(uploaded[1][1]).toBeLessThan(15)
    const request = vi.mocked(api.start).mock.calls[0][2]!
    const prompt = String(request['13'].inputs.prompt)
    expect(prompt).toContain('begin from <Picture 1>')
    expect(prompt).toContain('end in the state of <Picture 2>')
    expect(prompt).toContain('only the current screenplay action')
    expect(prompt).toContain('对白 2')
    expect(prompt).not.toContain('对白 1')
    expect(prompt).not.toContain('对白 3')
    expect(
      Object.values(request).filter(
        (node) => node.class_type === 'RHMiniMaxH3Ref2VAImageReference',
      ),
    ).toHaveLength(2)
  }, 25000)
  it('keeps pinned retained versions even if selected videos change while queued, including native Kling tail control', async () => {
    let p = project()
    p = await retain(p, [0], await clip('original-before', 'red', 'green'))
    p = await retain(p, [2], await clip('original-after', 'blue', 'yellow'))
    store.set('config', {
      ...store.config(),
      models: { ...defaultModels, video: defaultModel('video', 'kling') },
    })
    const api = new ModelAPI(() => ({ key: 'fixture' }))
    const submit = vi
      .spyOn(api, 'startVideo')
      .mockImplementation(async (job, prompt, first, last) => {
        expect(job.remoteKind).toBe('image2video')
        expect(prompt).toContain('尾帧是当前镜头的结束目标')
        expect((await pixel(first!))[1]).toBeGreaterThan(100)
        expect((await pixel(last!))[2]).toBeGreaterThan(220)
        return 'fixture-kling'
      })
    vi.spyOn(api, 'videoResult').mockResolvedValue({ status: 'RUNNING', urls: [] })
    const q = queue({} as RunningHub, api)
    q.enqueue(p.id, [p.shots[1].id], false)
    const pinned = store.jobs()[0]
    const changed = await clip('changed', 'white', 'black')
    p = await retain(p, [0, 2], changed)
    expect(p.shots[0].videoMediaId).not.toBe(pinned.previousVideoMediaId)
    expect(p.shots[2].videoMediaId).not.toBe(pinned.nextVideoMediaId)
    unpause(q)
    await vi.waitFor(() => expect(store.jobs()[0].status).toBe('running'), { timeout: 15000 })
    expect(submit).toHaveBeenCalledTimes(1)
  }, 25000)
  it('uses the newly completed predecessor in a partial batch and reconnects the retained successor', async () => {
    let p = project()
    p = await retain(p, [0, 1, 2], await clip('old', 'red', 'red'))
    p = await retain(p, [3], await clip('retained', 'blue', 'yellow'))
    const api = {
      workflow: vi.fn().mockResolvedValue(graph),
      status: vi.fn().mockResolvedValue('RUNNING'),
      upload: vi.fn(async (_site: string, file: string) => {
        if (file.endsWith('chain-' + current.id + '.png'))
          expect((await pixel(file))[1]).toBeGreaterThan(100)
        return file.split(/[\\/]/).at(-1)!
      }),
      start: vi.fn().mockResolvedValue('fixture-next'),
    } as unknown as RunningHub
    const q = queue(api)
    q.enqueue(p.id, [p.shots[2].id, p.shots[1].id], false)
    const before = store.jobs().find((j) => j.shotId === p.shots[1].id)!
    const current = store.jobs().find((j) => j.shotId === p.shots[2].id)!
    await retain(p, [1], await clip('new', 'red', 'green'))
    before.status = 'succeeded'
    store.saveJob(before)
    unpause(q)
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1), { timeout: 15000 })
    const job = vi.mocked(api.start).mock.calls[0][0]
    expect(job.shotId).toBe(p.shots[2].id)
    expect(job.previousVideoMediaId).toBeUndefined()
    expect(job.nextVideoMediaId).toBe(p.shots[3].videoMediaId)
    expect(String(vi.mocked(api.start).mock.calls[0][2]!['13'].inputs.prompt)).toContain(
      'end in the state of <Picture 2>',
    )
  }, 25000)
  it('never falls back to a replaced old predecessor when its new task fails', async () => {
    const p = await retain(project(), [0, 1, 2, 3])
    const api = { start: vi.fn() } as unknown as RunningHub
    const q = queue(api)
    q.enqueue(p.id, [p.shots[1].id, p.shots[2].id], false)
    const failed = store.jobs().find((j) => j.shotId === p.shots[1].id)!
    failed.status = 'failed'
    store.saveJob(failed)
    unpause(q)
    await vi.waitFor(() =>
      expect(store.jobs().find((j) => j.shotId === p.shots[2].id)?.status).toBe('paused'),
    )
    expect(api.start).not.toHaveBeenCalled()
  })
  it('fails before submission if a pinned successor video has disappeared', async () => {
    const p = await retain(project(), [2])
    const api = {
      workflow: vi.fn().mockResolvedValue(graph),
      start: vi.fn(),
    } as unknown as RunningHub
    const q = queue(api)
    q.enqueue(p.id, [p.shots[1].id], false)
    store.update(p.id, (current) => {
      current.media = current.media.filter((m) => m.id !== p.shots[2].videoMediaId)
    })
    unpause(q)
    await vi.waitFor(() => expect(store.jobs()[0].status).toBe('failed'))
    expect(store.jobs()[0].error).toContain('保留的后镜头视频缺失')
    expect(api.start).not.toHaveBeenCalled()
  })
})
