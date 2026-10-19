import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Store, createProject } from '../src/main/store'
import { PrevisExporter } from '../src/main/previs'
import {
  exportArchive,
  restoreArchive,
  ffmpegBinaries,
  fitPrevisContinuityVideo,
  importMedia,
} from '../src/main/media'
import {
  blankPrevisPlan,
  cameraAt,
  objectAt,
  putKey,
  previsSource,
  isPrevisCurrent,
  validateGlb,
  previsPlanSchema,
  type PrevisObject,
} from '../src/shared/previs'
import { defaultConfig, randomId } from '../src/shared/schema'
import { defaultModel } from '../src/shared/models'
import {
  Queue,
  RunningHub,
  prepareVideoWorkflow,
  videoPromptWithAssets,
} from '../src/main/runninghub'
import graph from './fixtures/director-ref2va-api.json'

const object: PrevisObject = {
  id: 'actor',
  name: '演员',
  kind: 'person',
  position: [0, 0, 0],
  yaw: 0,
  scale: [1, 1, 1],
  color: '#aa8866',
  hidden: false,
  locked: false,
}
let root: string, store: Store, exporter: PrevisExporter
const queues: Queue[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'muweave-previs-'))
  store = new Store(root)
  exporter = new PrevisExporter(store)
  store.set('config', { ...defaultConfig, paused: true })
})
afterEach(async () => {
  for (const queue of queues.splice(0)) queue.stop()
  await exporter.cancel()
  store.close()
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function project() {
  const p = createProject('3D 预演测试', '16:9', true),
    shot = p.shots[0]
  shot.duration = 5
  shot.dialogue = ''
  shot.speaker = ''
  shot.action = '走向桌子'
  p.previsScenes = [{ id: 'scene', name: '片场', revision: 1, objects: [structuredClone(object)] }]
  shot.previs = blankPrevisPlan('scene')
  shot.previs.revision = 1
  return store.save(p)
}
async function retainPrevis() {
  const p = project(),
    shot = p.shots[0],
    file = join(root, 'previs.mp4')
  await writeFile(file, 'video fixture; enqueue must not decode or submit')
  const media = await importMedia(
    store,
    p.id,
    shot.id,
    'previs',
    file,
    '',
    undefined,
    undefined,
    undefined,
    previsSource(p.previsScenes![0], shot.previs!, shot.duration, p.aspect),
  )
  store.update(p.id, (p) => {
    p.shots[0].usePrevis = true
  })
  return { p: store.project(p.id), media }
}
function queue() {
  const queue = new Queue(store, {} as RunningHub, () => {})
  queues.push(queue)
  return queue
}

describe('seekable previs', () => {
  it('creates UUIDs in an opaque MCP iframe without randomUUID', () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
    vi.stubGlobal('crypto', { getRandomValues })
    try {
      const first = randomId()
      expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(randomId()).not.toBe(first)
    } finally { vi.unstubAllGlobals() }
  })
  it('evaluates arbitrary times identically, clamps endpoints and keeps action phase seekable', () => {
    const plan = blankPrevisPlan('scene')
    plan.tracks = [
      {
        objectId: object.id,
        keys: [
          { time: 0, position: [0, 0, 0], yaw: 0 },
          { time: 5, position: [10, 0, 5], yaw: 90 },
        ],
        actions: [{ start: 1, end: 4, kind: 'walk', speed: 2 }],
      },
    ]
    const middle = objectAt(object, plan, 2.5)
    expect(middle).toEqual({ position: [5, 0, 2.5], yaw: 45, pose: 'walk', phase: 3 })
    objectAt(object, plan, 5)
    objectAt(object, plan, 0)
    expect(objectAt(object, plan, 2.5)).toEqual(middle)
    expect(objectAt(object, plan, 20).position).toEqual([10, 0, 5])
    expect(objectAt(object, plan, 4).pose).toBe('idle')
    plan.camera = [plan.camera[0], { ...plan.camera[0], time: 5, position: [0, 5, 9], fov: 65 }]
    expect(cameraAt(plan, 2.5).fov).toBe(55)
    expect(putKey(plan.camera, { ...plan.camera[0], fov: 30 })).toHaveLength(2)
    expect(
      previsPlanSchema.safeParse({ ...plan, camera: [...plan.camera].reverse() }).success,
    ).toBe(false)
  })
  it('retains previs and its exact source through ZIP migration and detects changes', async () => {
    const { p, media } = await retainPrevis()
    expect(isPrevisCurrent(p, p.shots[0])).toBe(true)
    expect(p.shots[0].videoMediaId).toBeUndefined()
    const archive = join(root, 'project.zip')
    await exportArchive(store, p.id, archive)
    const restored = await restoreArchive(store, archive)
    expect(restored.previsScenes).toEqual(p.previsScenes)
    expect(restored.shots[0].previsMediaId).toBe(media.id)
    expect(isPrevisCurrent(restored, restored.shots[0])).toBe(true)
    restored.previsScenes![0].revision++
    expect(isPrevisCurrent(restored, restored.shots[0])).toBe(false)
  })
})
describe('paid video previs boundary', () => {
  it('freezes the selected video version at enqueue and blocks obsolete or unsupported inputs', async () => {
    const { p, media } = await retainPrevis(),
      q = queue()
    q.enqueue(p.id, [p.shots[0].id], false)
    const job = store.jobs()[0]
    expect(job.previsMediaId).toBe(media.id)
    expect(job.snapshot.previs?.revision).toBe(1)
    store.update(p.id, (p) => {
      p.previsScenes![0].revision++
      p.shots[1].previs = p.shots[0].previs
      p.shots[1].previsMediaId = media.id
      p.shots[1].usePrevis = true
    })
    expect(store.jobs()[0].previsMediaId).toBe(media.id)
    expect(() => q.enqueue(p.id, [p.shots[1].id], false)).toThrow('过期')
    store.set('config', {
      ...defaultConfig,
      paused: true,
      models: { ...defaultConfig.models, video: defaultModel('video', 'kling') },
    })
    expect(() => q.enqueue(p.id, [p.shots[1].id], false)).toThrow('当前仅接入')
  })
  it('does not silently stretch an existing reference or create a task when duration needs fitting', async () => {
    const { p } = await retainPrevis()
    store.update(p.id, (p) => {
      p.shots[0].duration = 1
      p.media[0].previsSource = previsSource(p.previsScenes![0], p.shots[0].previs!, 1, p.aspect)
    })
    expect(() => queue().enqueue(p.id, [p.shots[0].id], false)).toThrow('时长需要调整')
    expect(store.jobs()).toHaveLength(0)
    expect(store.project(p.id).shots[0].duration).toBe(1)
  })
  it('submits the pinned previs with its proxy-to-character mapping even after the scene changes', async () => {
    const { p, media } = await retainPrevis()
    const resolveWorkflow: { value?: (value: typeof graph) => void } = {}
    const api = {
      workflow: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveWorkflow.value = resolve
          }),
      ),
      upload: vi
        .fn()
        .mockImplementation(async (_site: string, file: string) => file.split(/[\\/]/).at(-1)),
      start: vi.fn().mockResolvedValue('task-previs'),
    } as unknown as RunningHub
    store.set('config', { ...defaultConfig, paused: false })
    const q = new Queue(store, api, () => {})
    queues.push(q)
    q.enqueue(p.id, [p.shots[0].id], false)
    await vi.waitFor(() => expect(resolveWorkflow.value).toBeDefined())
    store.update(p.id, (p) => {
      p.previsScenes![0].objects[0].name = 'changed after enqueue'
      p.previsScenes![0].revision++
    })
    resolveWorkflow.value!(graph)
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1))
    const submitted = vi.mocked(api.start).mock.calls[0][2]!
    expect(
      Object.values(submitted).some(
        (node) =>
          node.class_type === 'LoadVideo' && node.inputs.file === media.file.split('/').at(-1),
      ),
    ).toBe(true)
    expect(submitted['13'].inputs.prompt).toContain('represents 演员')
    expect(submitted['13'].inputs.prompt).not.toContain('changed after enqueue')
  })
  it('chains separate continuity/audio and silent previs nodes and labels them accurately', () => {
    const p = project(),
      shot = p.shots[0]
    const result = prepareVideoWorkflow(graph, shot, p.aspect, {
      references: ['actor.png'],
      video: 'previous.mp4',
      videoHasAudio: true,
      previs: 'previs.mp4',
    })
    const videos = Object.entries(result).filter(
      ([, node]) => node.class_type === 'RHMiniMaxH3Ref2VAVideoReference',
    )
    expect(videos).toHaveLength(2)
    expect(videos[0][1].inputs.reference_type).toBe('video_audio')
    expect(videos[1][1].inputs.reference_type).toBe('video')
    expect(videos[1][1].inputs.references).toEqual([videos[0][0], 0])
    expect(result['13'].inputs.references).toEqual([videos[1][0], 0])
    const loader = Object.values(result).find(
      (node) => node.class_type === 'LoadVideo' && node.inputs.file === 'previs.mp4',
    )!
    expect(loader.inputs.keep_audio).toBe(false)
    const prompt = videoPromptWithAssets(
      p,
      shot,
      true,
      true,
      ['previous final frame'],
      true,
      shot,
      0,
      '',
      true,
    )
    expect(prompt).toContain('<Video 1> is the preceding shot')
    expect(prompt).toContain('<Video 2> is the CURRENT shot')
    const first = videoPromptWithAssets(p, shot, false, false, [], false, undefined, 0, '', true)
    expect(first).toContain('<Video 1> is the CURRENT shot')
    expect(first).not.toContain('<Video 1> is the preceding shot')
    expect(
      prepareVideoWorkflow(graph, shot, p.aspect, { previs: 'previs.mp4' })['13'].class_type,
    ).toBe('RHMiniMaxH3Ref2VAEncode')
  })
  it('rejects a 14 second previs when continuity also requires at least 2 seconds', async () => {
    const { p } = await retainPrevis()
    const first = p.shots[0],
      second = p.shots[1]
    first.scene = second.scene = 'same room'
    second.duration = 14
    second.dialogue = ''
    second.action = 'walk'
    second.usePrevis = true
    second.previs = first.previs
    const file = join(root, 'long-previs.mp4')
    await writeFile(file, 'pinned previs fixture')
    store.save(p)
    await importMedia(
      store,
      p.id,
      second.id,
      'previs',
      file,
      '',
      undefined,
      undefined,
      undefined,
      previsSource(p.previsScenes![0], second.previs!, 14, p.aspect),
    )
    expect(() => queue().enqueue(p.id, [first.id, second.id], false)).toThrow('最长 13 秒')
    expect(store.jobs()).toHaveLength(0)
  })
})
describe('local output and model import boundaries', () => {
  it('fits the real predecessor tail into the remaining video budget while keeping audio', async () => {
    const binaries = ffmpegBinaries(),
      input = join(root, 'previous.mp4'),
      output = join(root, 'tail.mp4')
    await promisify(execFile)(binaries.ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x90:r=24:d=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4',
      '-shortest',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      input,
    ])
    expect(await fitPrevisContinuityVideo(input, output, 2)).toBe(output)
    const { stdout } = await promisify(execFile)(binaries.ffprobe, [
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      output,
    ])
    const info = JSON.parse(stdout)
    expect(Number(info.format.duration)).toBeGreaterThanOrEqual(2)
    expect(Number(info.format.duration)).toBeLessThanOrEqual(2.05)
    expect(
      info.streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio'),
    ).toBe(true)
    expect(await fitPrevisContinuityVideo(input, output, 5)).toBe(input)
    await expect(fitPrevisContinuityVideo(input, output, 1)).rejects.toThrow('至少保留 2 秒')
  }, 30000)
  it('rejects incorrect or missing frames, encodes exact frame count without audio and preserves final video', async () => {
    const p = project()
    store.update(p.id, (p) => {
      p.shots[0].duration = 1
    })
    const session = JSON.parse(await exporter.start(p.id, p.shots[0].id, 'video'))
    await expect(exporter.finish(p.id, p.shots[0].id, session.sessionId)).rejects.toThrow(
      '尚未渲染完整',
    )
    await expect(exporter.frame(session.sessionId, 0, new Uint8Array(12))).rejects.toThrow('格式')
    const png = join(root, 'frame.png'),
      binaries = ffmpegBinaries()
    await promisify(execFile)(binaries.ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=blue:s=${session.width}x${session.height}`,
      '-frames:v',
      '1',
      '-y',
      png,
    ])
    const bytes = await readFile(png)
    await expect(exporter.frame(session.sessionId, 1, bytes)).rejects.toThrow('顺序')
    for (let index = 0; index < session.count; index++)
      await exporter.frame(session.sessionId, index, bytes)
    const media = await exporter.finish(p.id, p.shots[0].id, session.sessionId)
    const { stdout } = await promisify(execFile)(binaries.ffprobe, [
      '-v',
      'error',
      '-show_streams',
      '-of',
      'json',
      store.file(p.id, media.file),
    ])
    const streams = JSON.parse(stdout).streams
    expect(streams).toHaveLength(1)
    expect(streams[0].codec_type).toBe('video')
    expect(Number(streams[0].nb_frames)).toBe(24)
    expect(isPrevisCurrent(store.project(p.id), store.project(p.id).shots[0])).toBe(true)
    expect(store.project(p.id).shots[0].videoMediaId).toBeUndefined()
    await expect(exporter.frame(session.sessionId, 0, bytes)).rejects.toThrow('失效')
  }, 30000)
  it('rejects GLB external URIs before loading', () => {
    function glb(uri?: string) {
      const source = JSON.stringify({ asset: { version: '2.0' }, buffers: uri ? [{ uri }] : [] })
      const json = Buffer.from(source.padEnd(Math.ceil(source.length / 4) * 4, ' ')),
        output = Buffer.alloc(20 + json.length)
      output.writeUInt32LE(0x46546c67, 0)
      output.writeUInt32LE(2, 4)
      output.writeUInt32LE(output.length, 8)
      output.writeUInt32LE(json.length, 12)
      output.writeUInt32LE(0x4e4f534a, 16)
      json.copy(output, 20)
      return output
    }
    expect(() => validateGlb(glb())).not.toThrow()
    expect(() => validateGlb(glb('https://example.com/texture.png'))).toThrow('外部地址')
    expect(() => validateGlb(new Uint8Array(10))).toThrow()
  })
})
