import { mkdir, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import { type Job, type Config, type Project, type Shot, videoWorkflow } from '../shared/schema'
import { minimumDialogueDuration, spokenLines } from '../shared/director'
import { Store } from './store'
import { downloadVideo, extractLastFrame, importMedia } from './media'
import fallbackVideoWorkflow from './workflows/director-fl2va-api.json'

const envelope = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
})
export class RejectedRequest extends Error {
  constructor(message: string, public data?: unknown) { super(message) }
}
type ApiNode = { class_type: string; inputs: Record<string, unknown>; _meta?: Record<string, unknown> }
type ApiWorkflow = Record<string, ApiNode>
const apiWorkflowSchema = z.record(
  z.string(),
  z.object({ class_type: z.string(), inputs: z.record(z.string(), z.unknown()) }).passthrough(),
)
export function prepareVideoWorkflow(
  source: unknown,
  shot: Shot,
  aspect: Project['aspect'],
  frames: { first?: string; last?: string; references?: string[]; video?: string } = {},
  prompt = shot.videoPrompt.trim() || shot.action.trim(),
): ApiWorkflow {
  const graph = structuredClone(apiWorkflowSchema.parse(source)) as ApiWorkflow
  if (graph['13']?.class_type === 'RHMiniMaxH3Ref2VAEncode' &&
      graph['12']?.class_type === 'RHMiniMaxH3Ref2VATarget' &&
      graph['15']?.class_type === 'RHMiniMaxH3DualSigmaSampler') {
    const references = frames.references || []
    if (!references.length)
      return prepareVideoWorkflow(fallbackVideoWorkflow, shot, aspect, frames, prompt)
    if (references.length > 9) throw new Error('多参考图工作流最多支持 9 张参考图')
    if (!prompt) throw new Error(`${shot.title} 缺少视频提示词或镜头动作`)
    for (const [id, node] of Object.entries(graph)) {
      if (node.class_type === 'RHMiniMaxH3Ref2VAImageReference' ||
          (node.class_type === 'LoadImage' && ['4', '6'].includes(id))) delete graph[id]
    }
    let nextId = Math.max(0, ...Object.keys(graph).map(Number).filter(Number.isFinite)) + 1
    let previousReference: [string, number] | undefined
    for (const fileName of references) {
      const loadId = String(nextId++), referenceId = String(nextId++)
      graph[loadId] = { class_type: 'LoadImage', inputs: { image: fileName } }
      graph[referenceId] = {
        class_type: 'RHMiniMaxH3Ref2VAImageReference',
        inputs: { image: [loadId, 0], ...(previousReference ? { references: previousReference } : {}) },
      }
      previousReference = [referenceId, 0]
    }
    if (frames.video) {
      const loadId = String(nextId++), referenceId = String(nextId++)
      graph[loadId] = { class_type: 'LoadVideo', inputs: { file: frames.video, keep_audio: false, trim_time: 0 } }
      graph[referenceId] = {
        class_type: 'RHMiniMaxH3Ref2VAVideoReference',
        inputs: { video: [loadId, 0], references: previousReference, reference_type: 'video' },
      }
      previousReference = [referenceId, 0]
    }
    const size = {
      '16:9': [864, 480],
      '9:16': [480, 864],
      '1:1': [640, 640],
    }[aspect]
    graph['12'].inputs = {
      ...graph['12'].inputs,
      references: previousReference,
      aspect_ratio: aspect,
      duration_seconds: shot.duration,
      width: size[0],
      height: size[1],
    }
    graph['13'].inputs = { ...graph['13'].inputs, references: previousReference, prompt, ref_image_size: 'match' }
    graph['15'].inputs.seed = shot.seed
    return graph
  }
  const video = graph['17']
  if (video?.class_type !== 'MiniMaxH3ImageToVideo')
    throw new Error('指定工作流的视频节点已变化，请核对 RunningHub 工作流')
  if (!prompt) throw new Error(`${shot.title} 缺少视频提示词或镜头动作`)
  video.inputs.prompt = prompt
  // The supplied workflow uses 24 fps and rounds frame count to 17n + 5.
  const requestedFrames = Math.max(5, Math.round(shot.duration * 24))
  video.inputs.length = requestedFrames + ((5 - (requestedFrames % 17)) % 17)
  const resolution = graph['15']
  const aspectValue = {
    '16:9': '16:9 (Widescreen)',
    '9:16': '9:16 (Portrait Widescreen)',
    '1:1': '1:1 (Square)',
  }[aspect]
  if (resolution?.class_type === 'ResolutionSelector') {
    resolution.inputs.aspect_ratio = aspectValue
  } else {
    // API exports may inline front-end selector values into the video node.
    const ratio = aspect === '16:9' ? 16 / 9 : aspect === '9:16' ? 9 / 16 : 1
    video.inputs.width = Math.max(32, Math.round(Math.sqrt(400000 * ratio) / 32) * 32)
    video.inputs.height = Math.max(32, Math.round(Math.sqrt(400000 / ratio) / 32) * 32)
  }
  if (graph['16']?.class_type === 'RandomNoise') graph['16'].inputs.noise_seed = shot.seed
  let nextId = Math.max(0, ...Object.keys(graph).map(Number).filter(Number.isFinite)) + 1
  for (const slot of ['first', 'last'] as const) {
    const fileName = frames[slot]
    if (!fileName) continue
    const nodeId = String(nextId++)
    graph[nodeId] = { class_type: 'LoadImage', inputs: { image: fileName } }
    video.inputs[slot === 'first' ? 'first_frame' : 'last_frame'] = [nodeId, 0]
  }
  return graph
}
export function relevantAssets(p: Project, shot: Shot) {
  const scene = [shot.title, shot.scene, shot.action, shot.dialogue, shot.speaker, shot.videoPrompt].join(' ')
  return p.assets.filter((asset) =>
    shot.assetIds.includes(asset.id) ||
    (asset.name.length >= 2 && scene.includes(asset.name)),
  )
}
export function sameScene(previous: Shot | undefined, shot: Shot, p: Project) {
  if (!previous) return false
  const before = previous.scene.trim(), after = shot.scene.trim()
  if (before && after) {
    if (before === after) return true
    const [beforePlace, ...beforeContext] = before.split('·').map((part) => part.trim())
    const [afterPlace, ...afterContext] = after.split('·').map((part) => part.trim())
    const shorter = beforePlace.length <= afterPlace.length ? beforePlace : afterPlace
    const longer = beforePlace.length > afterPlace.length ? beforePlace : afterPlace
    return beforeContext.join('·') === afterContext.join('·') && shorter.length >= 4 &&
      longer.startsWith(shorter) && longer.length - shorter.length <= 8
  }
  const locations = new Set(p.assets.filter((a) => a.kind === 'location').map((a) => a.id))
  const sharedLocation = previous.assetIds.some((id) => locations.has(id) && shot.assetIds.includes(id))
  return sharedLocation || (!before && !after && !previous.assetIds.some((id) => locations.has(id)) &&
    !shot.assetIds.some((id) => locations.has(id)))
}
export function videoPromptWithAssets(
  p: Project, shot: Shot, continuing: boolean, hasFirstFrame: boolean,
  referenceLabels: string[] = [], hasVideoReference = false,
) {
  const base = shot.videoPrompt.trim() || shot.action.trim()
  const assets = relevantAssets(p, shot).slice(0, 12)
  const details = assets.map((asset) =>
    `${asset.kind} ${asset.name}: ${asset.description.slice(0, 350)}${asset.prompt ? `; ${asset.prompt.slice(0, 250)}` : ''}`,
  )
  const cast = p.assets.filter((a) => a.kind === 'character')
  const lines = spokenLines(shot.dialogue, shot.speaker)
  const voices = [...new Set([
    ...cast.map((a) => a.name),
    ...p.shots.flatMap((s) => spokenLines(s.dialogue, s.speaker).map((line) => line.speaker)).filter(Boolean),
    '未指定角色',
  ])]
  const speech = lines.map(({ speaker, words }) => {
    const resolved = speaker || (assets.filter((a) => a.kind === 'character').length === 1
      ? assets.find((a) => a.kind === 'character')?.name : '') || '未指定角色'
    const number = voices.indexOf(resolved) + 1
    const tag = /[\p{Script=Han}]/u.test(words) ? 'Chinese' : 'English'
    const voiceover = /^(旁白|voiceover|narrator)$/i.test(resolved)
    return `${resolved} (S${number || 1}) ${voiceover ? 'says in an off-screen voiceover' : 'speaks with natural lip sync'} exactly: <d>[${tag}] ${words}</d>${voiceover ? ' The on-screen characters keep their lips closed.' : ''}`
  })
  const alignment = referenceLabels.length
    ? `Use each tagged reference for its stated identity or location.${continuing ? ' Continue the prior shot immediately, matching its final pose, clothing, object positions, screen direction, set layout, and light.' : ''}`
    : continuing
    ? 'The first frame is the last frame of the previous shot. Continue the same action immediately, preserving faces, clothing, object positions, motion direction, set layout, and lighting.'
    : hasFirstFrame
      ? 'The supplied first frame is the opening composition. Preserve its subject identity, outfit, set geometry, and lighting.'
      : 'Keep established character identities, wardrobe, props, set geometry, and lighting unchanged across this project.'
  return [
    ...(referenceLabels.length ? [
      ...referenceLabels.map((label, index) => `<Picture ${index + 1}>: ${label}. Keep this reference consistent whenever it appears.`),
      ...(hasVideoReference ? ['<Video 1> is the preceding shot. Continue its action and camera direction without repeating its speech.'] : []),
    ] : hasFirstFrame ? [
      `For the target video, at 0.00 seconds, <Picture 1> is the exact first frame of [Shot 1]${continuing ? ' and the final frame of the previous shot' : ''}. Preserve the people, clothing, objects, layout, and lighting visible in that frame.`,
    ] : []),
    `integrated_multimodal_description: [Shot 1] ${alignment}`,
    `Project style: ${p.style || 'cinematic realism'}. Episode: ${p.episodes.find((e) => e.id === shot.episodeId)?.title || ''}. Scene: ${shot.scene || 'unspecified'}. Shot: ${shot.title}.`,
    `Visual action: ${shot.action}. Camera: ${shot.size}, ${shot.camera}. Lighting: ${shot.lighting}. Additional visual direction: ${base}.`,
    ...(details.length ? [`Continuity bible; treat these as fixed identities and objects in every shot where they appear:\n${details.join('\n')}`] : []),
    ...(lines.length ? [`The screenplay dialogue below is the ONLY speech in this shot. Do not paraphrase, translate, invent, or reorder any words. Keep the same speaker voice across shots.\n${speech.join('\n')}`]
      : ['This shot has no dialogue or voiceover. Do not generate spoken words, mumbling, or background conversation.']),
    `overall_soundscape: ${lines.length ? 'Natural location ambience and only the exact dialogue above; no extra voices.' : 'Natural location ambience only; no speech.'}`,
    'non_diegetic_music: None. No subtitles, text overlays, watermarks, or scene changes inside this shot.',
  ].join('\n')
}
export class RunningHub {
  constructor(
    private key: () => string,
    private transport: typeof fetch = fetch,
  ) {}
  async request(site: string, path: string, body: Record<string, unknown> | FormData) {
    if (!['https://www.runninghub.ai', 'https://www.runninghub.cn'].includes(site))
      throw new Error('RunningHub 站点无效')
    const key = this.key()
    if (!key) throw new Error('请先绑定 RunningHub API Key')
    const form = body instanceof FormData
    const response = await this.transport(site + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        ...(!form ? { 'Content-Type': 'application/json' } : {}),
      },
      body: form ? body : JSON.stringify({ ...body, apiKey: key }),
      signal: AbortSignal.timeout(form ? 120000 : 45000),
      redirect: 'error',
    })
    if (!response.ok) throw new Error(`RunningHub HTTP ${response.status}`)
    const result = envelope.parse(await response.json())
    if (result.code !== 0)
      throw new RejectedRequest(
        `RunningHub ${result.code}：${(result.msg || '请求未完成').replaceAll(key, '[已隐藏]')}`,
        result.data,
      )
    return result.data
  }
  async workflow(c: { site: string; workflowId: string }) {
    if (!c.workflowId) throw new Error('请填写 workflowId')
    const result = await this.request(c.site, '/api/openapi/getJsonApiFormat', {
      workflowId: c.workflowId,
    })
    const data = z.object({ prompt: z.string() }).parse(result)
    return apiWorkflowSchema.parse(JSON.parse(data.prompt))
  }
  async account(c: Config) {
    return this.request(c.site, '/uc/openapi/accountStatus', { apikey: this.key() })
  }
  async upload(site: string, file: string) {
    const form = new FormData()
    form.set('apiKey', this.key())
    form.set('fileType', 'input')
    form.set('file', new Blob([await readFile(file)]), basename(file))
    return z
      .object({ fileName: z.string().min(1) })
      .parse(await this.request(site, '/task/openapi/upload', form)).fileName
  }
  async start(
    j: Job,
    nodeInfoList: { nodeId: string; fieldName: string; fieldValue: string | number }[],
    workflow?: ApiWorkflow,
  ) {
    return z
      .object({
        taskId: z.union([z.string().regex(/^\d+$/), z.number().int().safe()]).transform(String),
      })
      .parse(
        await this.request(j.site, '/task/openapi/create', {
          workflowId: j.workflowId,
          nodeInfoList,
          ...(workflow ? { workflow: JSON.stringify(workflow) } : {}),
          ...(j.instanceType ? { instanceType: j.instanceType } : {}),
        }),
      ).taskId
  }
  async status(j: Job) {
    return z
      .string()
      .parse(await this.request(j.site, '/task/openapi/status', { taskId: j.taskId }))
      .toUpperCase()
  }
  async outputs(j: Job) {
    return z
      .array(z.object({ fileUrl: z.string().url(), fileType: z.string().optional() }))
      .parse(await this.request(j.site, '/task/openapi/outputs', { taskId: j.taskId }))
  }
  async failure(j: Job) {
    try {
      await this.outputs(j)
    } catch (error) {
      if (!(error instanceof RejectedRequest)) return undefined
      const reason = z.object({ failedReason: z.object({
        node_name: z.string().optional(),
        exception_message: z.string().optional(),
        traceback: z.string().optional(),
      }) }).safeParse(error.data)
      if (!reason.success) return undefined
      const detail = [reason.data.failedReason.node_name,
        reason.data.failedReason.exception_message,
        reason.data.failedReason.traceback].filter(Boolean).join('：')
      const key = this.key()
      return (key ? detail.replaceAll(key, '[已隐藏]') : detail).slice(0, 400)
    }
    return undefined
  }
  async cancel(j: Job) {
    await this.request(j.site, '/task/openapi/cancel', { taskId: j.taskId })
  }
}
export function inputsChanged(current: Shot, snapshot: Shot) {
  return current.assetIds.join(',') !== snapshot.assetIds.join(',') ||
    ['scene', 'action', 'dialogue', 'speaker', 'size', 'camera', 'lighting', 'imagePrompt',
      'videoPrompt', 'firstMediaId', 'lastMediaId', 'duration', 'seed'].some(
      (k) => current[k as keyof Shot] !== snapshot[k as keyof Shot],
    )
}
export class Queue {
  private busy = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  constructor(
    private store: Store,
    private api: RunningHub,
    private changed: () => void,
    private resourcesPath?: string,
  ) {}
  start() {
    for (const j of this.store.jobs()) {
      if (j.status === 'submitting') {
        j.status = j.taskId ? 'running' : 'uncertain'
        j.error = j.taskId
          ? undefined
          : '上次关闭发生在提交期间。请在 RunningHub 核实是否已产生任务，再绑定任务 ID。'
        this.store.saveJob(j)
      }
      if (j.status === 'downloading') {
        j.status = 'running'
        this.store.saveJob(j)
      }
    }
    this.timer = setInterval(() => void this.tick(), 5000)
    void this.tick()
  }
  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
  }
  enqueue(projectId: string, shotIds: string[], stopOnFailure: boolean) {
    const p = this.store.project(projectId)
    const instanceType = this.store.config().instanceType
    const selected = [...new Set(shotIds)].map((id) => {
      const s = p.shots.find((s) => s.id === id)
      if (!s) throw new Error('镜头不存在')
      return s
    })
    const selection = new Set(selected.map((shot) => shot.id))
    const fitted = new Map<string, number>()
    for (const s of selected) {
      if (
        this.store
          .jobs()
          .some(
            (j) =>
              j.projectId === projectId &&
              j.shotId === s.id &&
              ['queued', 'submitting', 'running', 'downloading', 'uncertain', 'paused'].includes(
                j.status,
              ),
          )
      )
        throw new Error(`${s.title} 已有未完成任务，请先处理原任务`)
      if (!(s.videoPrompt.trim() || s.action.trim()))
        throw new Error(`${s.title} 缺少视频提示词或镜头动作`)
      const required = minimumDialogueDuration(s.dialogue)
      if (s.duration > 15) throw new Error(`${s.title} 超过多参考图模型的 15 秒上限，请先拆分镜头`)
      if (required > s.duration) {
        if (required > 10)
          throw new Error(`${s.title} 的对白约需 ${required} 秒，请在导演台拆成多个镜头后再生成`)
        fitted.set(s.id, Math.max(4, required))
      }
      if (s.duration < 4) fitted.set(s.id, Math.max(4, fitted.get(s.id) || 0))
      const episodeShots = p.shots.filter((shot) => shot.episodeId === s.episodeId)
      const previous = episodeShots[episodeShots.findIndex((shot) => shot.id === s.id) - 1]
      if (sameScene(previous, s, p) && previous && !previous.videoMediaId && !selection.has(previous.id) &&
          !this.store.jobs().some((job) => job.shotId === previous.id &&
            ['queued', 'submitting', 'running', 'downloading', 'uncertain', 'paused'].includes(job.status)))
        throw new Error(`${s.title} 需要先生成上一镜头「${previous.title}」，才能使用它的末帧衔接`)
    }
    if (fitted.size) {
      for (const s of selected) {
        const duration = fitted.get(s.id)
        if (duration === undefined) continue
        s.duration = duration
        if (s.videoMediaId) s.stale = true
      }
      this.store.save(p)
    }
    const batchId = randomUUID(),
      now = new Date().toISOString()
    for (const s of selected) {
      const episodeShots = p.shots.filter((shot) => shot.episodeId === s.episodeId)
      const previous = episodeShots[episodeShots.findIndex((shot) => shot.id === s.id) - 1]
      const candidates = relevantAssets(p, s).filter((asset) =>
        asset.selectedMediaId &&
        p.media.some((media) => media.id === asset.selectedMediaId && media.kind === 'image'),
      ).sort((a, b) => ({ character: 0, location: 1, prop: 2 })[a.kind] -
        ({ character: 0, location: 1, prop: 2 })[b.kind])
      const visibleCharacter = candidates.find((asset) => asset.kind === 'character' &&
        [s.action, s.videoPrompt, s.dialogue, s.speaker].some((part) => part.includes(asset.name)))
      const reference = visibleCharacter || candidates.find((asset) => asset.kind === 'location') || candidates[0]
      const referenceMediaIds = [...new Set(candidates.map((asset) => asset.selectedMediaId!))].slice(0, 8)
      this.store.saveJob({
        id: randomUUID(),
        projectId,
        shotId: s.id,
        batchId,
        stopOnFailure,
        status: 'queued',
        site: videoWorkflow.site,
        workflowId: videoWorkflow.id,
        instanceType,
        previousShotId: sameScene(previous, s, p) ? previous?.id : undefined,
        referenceMediaId: reference?.selectedMediaId,
        referenceMediaIds,
        aspect: p.aspect,
        mappings: [],
        snapshot: structuredClone(s),
        createdAt: now,
        updatedAt: now,
        pollErrors: 0,
        outputs: [],
      })
    }
    this.changed()
    void this.tick()
    return fitted.size
  }
  private async tick() {
    if (this.stopped) return
    const jobs = this.store.jobs(),
      c = this.store.config()
    for (const j of jobs.filter((j) => j.status === 'running' && !this.busy.has(j.id)))
      void this.poll(j)
    if (c.paused) return
    let slots =
      c.concurrency -
      jobs.filter((j) => ['submitting', 'running', 'downloading', 'uncertain'].includes(j.status))
        .length
    for (const j of jobs.filter((j) => j.status === 'queued').reverse()) {
      if (slots <= 0) break
      if (j.previousShotId) {
        const project = this.store.project(j.projectId)
        const previous = project.shots.find((shot) => shot.id === j.previousShotId)
        const pending = jobs.some((other) => other.id !== j.id &&
          other.projectId === j.projectId && other.shotId === j.previousShotId &&
          ['queued', 'submitting', 'running', 'downloading', 'uncertain', 'paused'].includes(other.status))
        const failedInBatch = jobs.some((other) => other.batchId === j.batchId &&
          other.shotId === j.previousShotId && ['failed', 'cancelled'].includes(other.status))
        if (pending || failedInBatch || !previous?.videoMediaId) {
          const reason = pending ? '等待上一镜头完成后自动衔接' :
            failedInBatch ? '上一镜头生成失败，连续生成已暂停' :
              '上一镜头没有可用视频，连续生成已暂停'
          if (j.error !== reason || (!pending && j.status !== 'paused')) {
            j.error = reason
            if (!pending) j.status = 'paused'
            this.save(j)
          }
          continue
        }
      }
      if (
        j.stopOnFailure &&
        jobs.some((o) => o.batchId === j.batchId && ['failed', 'uncertain'].includes(o.status))
      ) {
        j.status = 'paused'
        j.error = '同组任务失败，已暂停后续镜头'
        this.store.saveJob(j)
        this.changed()
        continue
      }
      slots--
      void this.submit(j)
    }
  }
  private save(j: Job) {
    this.store.saveJob(j)
    this.changed()
  }
  private async submit(j: Job) {
    if (this.busy.has(j.id)) return
    this.busy.add(j.id)
    let sent = false
    try {
      j.status = 'submitting'
      j.error = undefined
      this.save(j)
      const p = this.store.project(j.projectId),
        uploads: Record<string, string> = {}
      const nodeInfoList: { nodeId: string; fieldName: string; fieldValue: string | number }[] = []
      if (j.instanceType) {
        const source = await this.api.workflow(j)
        const multiReference = source['13']?.class_type === 'RHMiniMaxH3Ref2VAEncode'
        const frames: { first?: string; last?: string; references: string[]; video?: string } = { references: [] }
        const referenceLabels: string[] = []
        const addImage = async (mediaId: string, label: string) => {
          if (frames.references.length >= 9) return
          const media = p.media.find((item) => item.id === mediaId && item.kind === 'image')
          if (!media) throw new Error(`缺少${label}的图片素材`)
          frames.references.push(await this.api.upload(j.site, this.store.file(p.id, media.file)))
          referenceLabels.push(label)
        }
        let continuing = false
        if (j.previousShotId) {
          const previous = p.shots.find((shot) => shot.id === j.previousShotId)
          const video = p.media.find((media) => media.id === previous?.videoMediaId && media.kind === 'video')
          if (!video) throw new Error('上一镜头视频缺失，未提交本镜头')
          const frame = this.store.file(p.id, `downloads/chain-${j.id}.png`)
          await mkdir(this.store.file(p.id, 'downloads'), { recursive: true })
          try {
            await extractLastFrame(this.store.file(p.id, video.file), frame, this.resourcesPath)
            frames.first = await this.api.upload(j.site, frame)
            frames.references.push(frames.first)
            referenceLabels.push('上一镜头的末帧；保持场景、人物、服装和物件连续')
          } finally {
            await rm(frame, { force: true })
          }
          if (multiReference)
            frames.video = await this.api.upload(j.site, this.store.file(p.id, video.file))
          continuing = true
        }
        if (!continuing && j.snapshot.firstMediaId) {
          await addImage(j.snapshot.firstMediaId, '当前镜头的开场构图')
          frames.first = frames.references[0]
        }
        if (j.snapshot.lastMediaId) {
          await addImage(j.snapshot.lastMediaId, '当前镜头的收尾构图')
          frames.last = frames.references.at(-1)
        }
        const assetMediaIds = j.referenceMediaIds || (j.referenceMediaId ? [j.referenceMediaId] : [])
        for (const mediaId of assetMediaIds) {
          if (mediaId === j.snapshot.firstMediaId || mediaId === j.snapshot.lastMediaId) continue
          const asset = p.assets.find((item) => item.selectedMediaId === mediaId)
          await addImage(mediaId, asset ? `${asset.kind} ${asset.name}` : '关联资产')
        }
        if (!frames.first) frames.first = frames.references[0]
        const workflow = prepareVideoWorkflow(
          source, j.snapshot, j.aspect || p.aspect, frames,
          videoPromptWithAssets(p, j.snapshot, continuing, !!frames.first,
            multiReference ? referenceLabels : [], !!frames.video),
        )
        if (this.store.job(j.id).status === 'cancelled') return
        sent = true
        j.taskId = await this.api.start(j, nodeInfoList, workflow)
        j.status = 'running'
        this.save(j)
        return
      }
      for (const m of j.mappings) {
        let value = m.value
        if (m.source === 'prompt') value = j.snapshot.videoPrompt || j.snapshot.action
        if (m.source === 'duration') value = String(j.snapshot.duration)
        if (m.source === 'seed') value = String(j.snapshot.seed)
        if (m.source === 'first' || m.source === 'last') {
          const mediaId = m.source === 'first' ? j.snapshot.firstMediaId : j.snapshot.lastMediaId,
            media = p.media.find((m) => m.id === mediaId)
          if (!media) throw new Error(`缺少${m.source === 'first' ? '首' : '尾'}帧素材`)
          value =
            uploads[media.id] ||
            (uploads[media.id] = await this.api.upload(j.site, this.store.file(p.id, media.file)))
        }
        nodeInfoList.push({ nodeId: m.nodeId, fieldName: m.fieldName, fieldValue: value })
      }
      if (this.store.job(j.id).status === 'cancelled') return
      sent = true
      j.taskId = await this.api.start(j, nodeInfoList)
      j.status = 'running'
      this.save(j)
    } catch (e) {
      j.status = sent && !(e instanceof RejectedRequest) ? 'uncertain' : 'failed'
      j.error = e instanceof Error ? e.message : '提交失败'
      this.save(j)
    } finally {
      this.busy.delete(j.id)
    }
  }
  private async poll(j: Job) {
    this.busy.add(j.id)
    try {
      const status = await this.api.status(j)
      if (this.store.job(j.id).status === 'cancelled') return
      if (['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status)) {
        j.status = status.startsWith('CANCEL') ? 'cancelled' : 'failed'
        let detail: string | undefined
        if (j.status === 'failed') {
          try { detail = await this.api.failure(j) } catch { /* preserve the final task state */ }
        }
        j.error = detail ? `RunningHub 任务失败：${detail}` : `远端任务状态：${status}`
        this.save(j)
        return
      }
      if (status !== 'SUCCESS') {
        if (!['RUNNING', 'QUEUED', 'PENDING'].includes(status))
          throw new Error(`未知远端状态：${status}`)
        j.pollErrors = 0
        if (j.error) {
          j.error = undefined
          this.save(j)
        }
        return
      }
      j.status = 'downloading'
      this.save(j)
      const outputs = await this.api.outputs(j)
      const videos = outputs.filter(
        (o) =>
          /\.(mp4|webm|mov)(\?|$)/i.test(o.fileUrl) ||
          ['mp4', 'webm', 'mov', 'video'].includes(o.fileType || ''),
      )
      if (!videos.length) throw new Error('工作流没有返回视频，请检查视频输出节点')
      for (const output of videos) {
        if (j.outputs.includes(output.fileUrl)) continue
        const existing = this.store
          .project(j.projectId)
          .media.find((m) => m.taskId === `${j.taskId}:${output.fileUrl}`)
        if (!existing) {
          const file = await downloadVideo(this.store, j.projectId, output.fileUrl)
          try {
            await importMedia(
              this.store,
              j.projectId,
              j.shotId,
              'video',
              file,
              j.snapshot.videoPrompt,
              `${j.taskId}:${output.fileUrl}`,
            )
          } finally {
            await rm(file, { force: true })
          }
        }
        j.outputs.push(output.fileUrl)
        this.save(j)
      }
      this.store.update(j.projectId, (p) => {
        const s = p.shots.find((s) => s.id === j.shotId)
        if (s) s.stale = inputsChanged(s, j.snapshot)
      })
      j.status = 'succeeded'
      j.error = undefined
      j.pollErrors = 0
      this.save(j)
    } catch (e) {
      if (this.store.job(j.id).status === 'cancelled') return
      j.pollErrors++
      j.error =
        (e instanceof Error ? e.message : '查询失败') + '；保留任务 ID，可继续查询，不会重新计费。'
      j.status = j.pollErrors >= 5 ? 'paused' : 'running'
      this.save(j)
    } finally {
      this.busy.delete(j.id)
    }
  }
  async action(id: string, action: 'cancel' | 'retry' | 'resume' | 'attach', taskId?: string) {
    const j = this.store.job(id)
    if (action !== 'cancel' && !this.store.project(j.projectId).shots.some((shot) => shot.id === j.shotId))
      throw new Error('旧剧本镜头已存档，不能重新提交视频任务')
    if (this.busy.has(id)) throw new Error('任务正在同步或下载，请稍后重试')
    this.busy.add(id)
    try {
      if (action === 'cancel') {
        if (j.status === 'submitting')
          throw new Error('正在提交；请等返回任务 ID 后再取消，避免任务状态不确定')
        if (j.taskId && ['running', 'paused', 'downloading'].includes(j.status))
          await this.api.cancel(j)
        j.status = 'cancelled'
        j.error = '已取消；已发生的远端费用以 RunningHub 为准'
      }
      if (action === 'attach') {
        if (!taskId) throw new Error('请输入 RunningHub 任务 ID')
        j.taskId = taskId
        j.status = 'running'
        j.pollErrors = 0
        j.error = undefined
      }
      if (action === 'resume') {
        if (j.status !== 'paused') throw new Error('只有暂停任务可以继续')
        j.status = j.taskId ? 'running' : 'queued'
        j.pollErrors = 0
        j.error = undefined
      }
      if (action === 'retry') {
        if (j.status !== 'failed' && j.status !== 'cancelled')
          throw new Error('仅失败或已取消任务可以重新提交；待确认任务请先核实远端状态')
        if (
          this.store
            .jobs()
            .some(
              (o) =>
                o.id !== j.id &&
                o.shotId === j.shotId &&
                ['queued', 'running', 'submitting', 'downloading', 'uncertain', 'paused'].includes(
                  o.status,
                ),
            )
        )
          throw new Error('该镜头已有未完成任务')
        j.taskId = undefined
        j.status = 'queued'
        j.outputs = []
        j.error = undefined
        j.pollErrors = 0
      }
      this.save(j)
    } finally {
      this.busy.delete(id)
    }
    void this.tick()
  }
}
