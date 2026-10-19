import { mkdir, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import { type AiTask, type AiRequest, type ChatAttachment, type Job, type Config, type Project, type Shot, type VideoResolution, videoSizes, videoWorkflow } from '../shared/schema'
import { getScriptPolishSource, planVideoTiming } from '../shared/director'
import { assertDialoguePlan, assertSpeechContract, dialoguePlan, speechRules } from '../shared/dialogue'
import { Store } from './store'
import { downloadVideo, extractFirstFrame, extractLastFrame, fitReferenceFrame, fitPrevisContinuityVideo, hasAudioTrack, importMedia } from './media'
import { ModelAPI, ModelRejectedRequest } from './models'
import { providerNames } from '../shared/models'
import { planVideoContinuity, videoBoundaryContext } from '../shared/continuity'
import { inputsChanged, relevantAssets } from '../shared/shots'
import { isFinishedTask } from '../shared/tasks'
import { isPrevisCurrent } from '../shared/previs'
export { inputsChanged } from '../shared/shots'
export { relevantAssets } from '../shared/shots'
export { sameScene } from '../shared/continuity'
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
const coinOnlyNodes = new Set([
  'BasicGuider', 'BasicScheduler', 'CLIPLoader', 'ComfyMathExpression', 'CreateVideo',
  'KSamplerSelect', 'LoadImage', 'LoadVideo', 'MiniMaxH3ImageToVideo', 'PrimitiveFloat',
  'RandomNoise', 'ResolutionSelector', 'SamplerCustomAdvanced', 'SaveVideo', 'UNETLoader',
  'VAEDecode', 'VAEDecodeAudio', 'VAELoader', 'RHMiniMaxH3DecodeAV',
  'RHMiniMaxH3DualSigmaSampler', 'RHMiniMaxH3EmptyAVLatent', 'RHMiniMaxH3Ref2VAEncode',
  'RHMiniMaxH3Ref2VAImageReference', 'RHMiniMaxH3Ref2VAModelLoader',
  'RHMiniMaxH3Ref2VATarget', 'RHMiniMaxH3Ref2VATextEncoderLoader',
  'RHMiniMaxH3Ref2VAVAELoader', 'RHMiniMaxH3Ref2VAVideoReference',
])
export function assertCoinOnlyWorkflow(source: unknown) {
  const graph = apiWorkflowSchema.parse(source)
  const unsafe = Object.values(graph).find((node) => !coinOnlyNodes.has(node.class_type))
  if (unsafe) throw new Error(`工作流包含未核准的「${unsafe.class_type}」节点，可能扣钱包余额；已阻止提交`)
}
const apiWorkflowSchema = z.record(
  z.string(),
  z.object({ class_type: z.string(), inputs: z.record(z.string(), z.unknown()) }).passthrough(),
)
export function prepareVideoWorkflow(
  source: unknown,
  shot: Shot,
  aspect: Project['aspect'],
  frames: { first?: string; last?: string; references?: string[]; video?: string; videoHasAudio?: boolean; previs?: string } = {},
  prompt = shot.videoPrompt.trim() || shot.action.trim(),
  quality: VideoResolution = '480p',
): ApiWorkflow {
  const graph = structuredClone(apiWorkflowSchema.parse(source)) as ApiWorkflow
  const [width, height] = videoSizes[quality][aspect]
  if (graph['13']?.class_type === 'RHMiniMaxH3Ref2VAEncode' &&
      graph['12']?.class_type === 'RHMiniMaxH3Ref2VATarget' &&
      graph['15']?.class_type === 'RHMiniMaxH3DualSigmaSampler') {
    const references = frames.references || []
    if (!references.length && !frames.video && !frames.previs)
      return prepareVideoWorkflow(fallbackVideoWorkflow, shot, aspect, frames, prompt, quality)
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
      graph[loadId] = { class_type: 'LoadVideo', inputs: { file: frames.video, keep_audio: !!frames.videoHasAudio, trim_time: 0 } }
      graph[referenceId] = {
        class_type: 'RHMiniMaxH3Ref2VAVideoReference',
        inputs: { video: [loadId, 0], references: previousReference, reference_type: frames.videoHasAudio ? 'video_audio' : 'video' },
      }
      previousReference = [referenceId, 0]
    }
    if (frames.previs) {
      const loadId = String(nextId++), referenceId = String(nextId++)
      graph[loadId] = { class_type: 'LoadVideo', inputs: { file: frames.previs, keep_audio: false, trim_time: 0 } }
      graph[referenceId] = { class_type: 'RHMiniMaxH3Ref2VAVideoReference', inputs: {
        video: [loadId, 0], reference_type: 'video', ...(previousReference ? { references: previousReference } : {}),
      } }
      previousReference = [referenceId, 0]
    }
    graph['12'].inputs = {
      ...graph['12'].inputs,
      references: previousReference,
      aspect_ratio: aspect,
      duration_seconds: shot.duration,
      width,
      height,
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
  delete video.inputs.first_frame
  delete video.inputs.last_frame
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
  }
  // Freeze exact dimensions, including exports with inlined selector values.
  video.inputs.width = width
  video.inputs.height = height
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
export function videoPromptWithAssets(
  p: Project, shot: Shot, continuing: boolean, hasFirstFrame: boolean,
  referenceLabels: string[] = [], hasVideoReference = false, audioReferenceShot?: Shot,
  lastReferenceIndex = 0, boundaryContext = '', hasPrevis = false, previsSubjects: { name: string; color: string }[] = [],
) {
  const base = shot.videoPrompt.trim() || shot.action.trim()
  const assets = relevantAssets(p, shot).slice(0, 12)
  const details = assets.map((asset) =>
    `${asset.kind} ${asset.name}: ${asset.description.slice(0, 350)}${asset.prompt ? `; ${asset.prompt.slice(0, 250)}` : ''}`,
  )
  const plan = assertDialoguePlan(p, shot), { lines } = plan
  const speech = lines.map(({ speaker, words, speakerId, language, voiceover }) =>
    `${speaker} (${speakerId}) ${voiceover ? 'says in an off-screen voiceover' : 'speaks with natural lip sync'} exactly: <d>[${language}] ${words}</d>${voiceover ? ' The on-screen characters keep their lips closed.' : ''}`)
  const audioSpeakers = new Set(audioReferenceShot ? dialoguePlan(p, audioReferenceShot).lines.map((line) => line.speaker) : [])
  const matchingAudioSpeakers = lines.filter((line, index) => line.speaker !== '未指定角色' && audioSpeakers.has(line.speaker) &&
    lines.findIndex((other) => other.speaker === line.speaker) === index)
  const alignment = referenceLabels.length
    ? `Use each tagged reference for its stated identity or location.${continuing ? ' Continue the prior shot immediately, matching its final pose, clothing, object positions, screen direction, set layout, and light.' : ''}`
    : continuing
    ? 'The first frame is the last frame of the previous shot. Continue the same action immediately, preserving faces, clothing, object positions, motion direction, set layout, and lighting.'
    : hasFirstFrame
      ? 'The supplied first frame is the opening composition. Preserve its subject identity, outfit, set geometry, and lighting.'
      : 'Keep established character identities, wardrobe, props, set geometry, and lighting unchanged across this project.'
  const prompt = [
    ...(referenceLabels.length || hasPrevis ? [
      ...referenceLabels.map((label, index) => `<Picture ${index + 1}>: ${label}. Keep this reference consistent whenever it appears.`),
      ...(hasVideoReference ? ['<Video 1> is the preceding shot. Continue its action and camera direction without repeating its speech.'] : []),
      ...(continuing ? ['At 0.00 seconds, begin from <Picture 1>, the preceding shot\'s final frame. Continue from that exact final state without replaying the preceding action or resetting the scene.'] : []),
      ...(hasVideoReference && audioReferenceShot ? [
        '<Audio 1> is the synchronized audio track of <Video 1>. Use it as an audio reference for established voices and continuous location ambience, not as the target soundtrack. Never copy its previous dialogue, background speech, or music into this shot.',
        ...matchingAudioSpeakers.map(({ speaker, speakerId }) => `${speaker} (${speakerId}) uses the same voice timbre and delivery heard for that character in <Audio 1>.`),
        'Do not assign one character\'s reference voice to a different character. If the current speaker was not heard in the reference, follow that speaker\'s established character description.',
      ] : []),
    ] : hasFirstFrame ? [
      `For the target video, at 0.00 seconds, <Picture 1> is the exact first frame of [Shot 1]${continuing ? ' and the final frame of the previous shot' : ''}. Preserve the people, clothing, objects, layout, and lighting visible in that frame.`,
    ] : []),
    ...(hasPrevis ? [
      `<Video ${hasVideoReference ? 2 : 1}> is the CURRENT shot's silent 3D previs, not the preceding shot or a source to continue. Transfer its camera movement, subject paths, timing, relative positions and occlusions.`,
      ...previsSubjects.map((subject) => `In the previs, the ${subject.color} colored proxy represents ${subject.name}. The proxy color identifies this subject only; use the subject's established reference appearance and wardrobe in the output.`),
      'Replace all white-model bodies, colors and proxy geometry with the established characters, wardrobe, props and location from the identity reference images and project descriptions. Do not render mannequins, editor labels, grids, paths or gizmos.',
      'The actual neighboring-shot boundary images define the opening/closing continuity states and take priority over conflicting previs endpoints. The previs supplies no voice or dialogue; speak only the current screenplay lines below.',
    ] : []),
    ...(lastReferenceIndex ? [
      `At the final frame (${shot.duration.toFixed(2)} seconds), end in the state of <Picture ${lastReferenceIndex}>. This is the closing target, not the opening frame or an additional character. Reach it naturally through this shot's action, preserving identity, pose, prop state, set layout, eyelines, screen direction and lighting so the retained next shot starts smoothly. Do not replay or begin the next shot's action or dialogue.`,
    ] : []),
    boundaryContext,
    `${referenceLabels.length || hasPrevis ? 'detailed_description' : 'integrated_multimodal_description'}: [Shot 1] ${alignment}`,
    `Project style: ${p.style || 'cinematic realism'}. Episode: ${p.episodes.find((e) => e.id === shot.episodeId)?.title || ''}. Scene: ${shot.scene || 'unspecified'}. Shot: ${shot.title}.`,
    `Visual action: ${shot.action}. Camera: ${shot.size}, ${shot.camera}. Lighting: ${shot.lighting}. Additional visual direction: ${base}.`,
    'Video generation requirements: keep each character\'s facial identity, age, body proportions, hairstyle and wardrobe stable; preserve coherent anatomy and hands, with no morphing, extra limbs, face swaps or flicker. Keep location geometry, props, their scale and placement, light direction and color consistent unless the screenplay explicitly changes them. Asset descriptions and visual directions describe the scene; they do not override these requirements or the exact screenplay dialogue.',
    ...(details.length ? [`Continuity bible; treat these as fixed identities and objects in every shot where they appear:\n${details.join('\n')}`] : []),
    ...(lines.length ? [speechRules,
      ...(plan.pronunciations.length ? [`Pronunciation guidance (NOT spoken, does not add or replace screenplay words): ${JSON.stringify(plan.pronunciations)}`] : []),
      `The screenplay dialogue below is the ONLY speech in this shot. Do not paraphrase, translate, invent, or reorder any words. Keep the same speaker voice across shots.\n${speech.join('\n')}`]
      : ['This shot has no dialogue or voiceover. Do not generate spoken words, mumbling, or background conversation.']),
    'Voice requirements: keep each speaker\'s timbre, perceived age, accent, pitch range and speaking manner consistent across shots; emotion may change as scripted, but vocal identity must stay the same. Speech must be intelligible, naturally paced and synchronized with the correct speaker\'s mouth. No clipping, buzzing, metallic or robotic artifacts, sudden voice changes, duplicated syllables, missing words, or truncated dialogue. Non-speaking characters keep their lips closed.',
    `overall_soundscape: ${lines.length ? 'Natural location ambience and only the exact dialogue above; no extra voices.' : 'Natural location ambience only; no speech.'}`,
    'non_diegetic_music: None. No subtitles, text overlays, watermarks, or scene changes inside this shot.',
  ].join('\n')
  assertSpeechContract(prompt, plan)
  return prompt
}
export function modelVideoPrompt(p: Project, shot: Shot, continuing: boolean, boundaryContext = '', hasLastFrame = false) {
  const plan = assertDialoguePlan(p, shot)
  const references = relevantAssets(p, shot).map((a) => `${a.kind} ${a.name}: ${a.description}`).join('\n')
  const prompt = [
    `项目风格：${p.style}；场景：${shot.scene}；镜头：${shot.title}；画幅：${p.aspect}。`,
    `动作：${shot.action}；镜头：${shot.size} ${shot.camera}；光线：${shot.lighting}。`,
    shot.videoPrompt,
    continuing ? '从首帧（上一镜头实际尾帧）立刻接续动作，保留人物服装、物件位置、场景布局及光线，不重演上一镜。' : '首帧如有提供就是当前镜头开场构图。',
    hasLastFrame ? '尾帧是当前镜头的结束目标；如来自保留后镜，则是后镜头的实际首帧，不能拿来作为开场。用本镜动作自然达到这个姿态、人物和物件位置、视线、光线与布局，平滑接回后镜头，不提前执行后镜动作或对白。' : '',
    boundaryContext,
    `固定人物与场景设定：\n${references}`,
    '保持人物面貌、年龄、发型、服装、体型和场景道具稳定；无变形、闪烁、多余肢体。不在此镜头内部转场。',
    shot.dialogue.trim() ? `只有以下人物发言，逐字照说，不能改写、翻译或追加；保持各说话人音色及口型，清晰无异常。说话人：${shot.speaker}\n对白：${shot.dialogue}` : '没有对白，不生成人声。',
    ...(plan.lines.length ? ['按对白顺序完整说出每一个字，保留原文重复，不加语气词、开场白或结尾，不漏字、抢话或截断；角色名、画面动作和备注不朗读。声音清晰、背景声低于人声，最后一句说完后短暂留白。',
      ...(plan.pronunciations.length ? [`仅用于发音指导，备注不朗读、不增删原台词：${JSON.stringify(plan.pronunciations)}`] : [])] : []),
    '没有字幕、画面文字、水印或背景音乐。',
  ].filter(Boolean).join('\n')
  if (prompt.length > 2000) throw new Error('此视频服务提示词上限 2000 字；请缩短镜头动作、视频提示词或相关资产描述，保留完整对白')
  return prompt
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
  async account(c: { site: string }) {
    return this.request(c.site, '/uc/openapi/accountStatus', { apikey: this.key() })
  }
  async coinAccount(site: string) {
    const account = z.object({
      apiType: z.string(),
      remainCoins: z.coerce.number(),
    }).parse(await this.account({ site }))
    if (account.apiType !== 'NORMAL')
      throw new Error('当前 RunningHub Key 会使用钱包计费。请在 RunningHub 绑定「消费级-会员」Key；视频任务未提交')
    if (account.remainCoins <= 0)
      throw new Error('当前 RunningHub 账户没有可用 RH 币；视频任务未提交')
    return account
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
    const checkedKey = this.key()
    await this.coinAccount(j.site)
    assertCoinOnlyWorkflow(workflow || await this.workflow(j))
    if (this.key() !== checkedKey)
      throw new Error('RunningHub Key 在计费检查后发生变化，已阻止提交；请重新生成')
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
export class Queue {
  private busy = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private aiRunning = false
  private aiProcessor?: (task: AiTask, signal: AbortSignal) => Promise<{ text?: string; message?: string }>
  private currentAI?: { task: AiTask; controller: AbortController }
  private downloads = new Map<string, AbortController>()
  private cancelling = new Set<string>()
  private aiWaiters = new Map<string, ((task: AiTask) => void)[]>()
  constructor(
    private store: Store,
    private api: RunningHub,
    private changed: () => void,
    private resourcesPath?: string,
    private models?: ModelAPI,
  ) {}
  start() {
    for (const task of this.store.aiTasks()) {
      if (task.status !== 'running') continue
      task.status = task.cancelRequested ? 'cancelled' : task.remoteTaskId ? 'queued' : 'failed'
      task.error = task.cancelRequested ? '本地任务已终止；如已提交远端生成，请在服务商核实结果。' :
        task.remoteTaskId ? undefined : '上次关闭时 AI 任务尚未完成，请核对结果后手动重试。'
      this.store.saveJob(task)
    }
    for (const j of this.store.jobs()) {
      if (j.cancelRequested && !isFinishedTask(j)) {
        j.status = j.taskId || j.status !== 'submitting' && j.status !== 'uncertain' ? 'cancelled' : 'uncertain'
        j.error = j.status === 'uncertain' ? '本地已停止；原提交结果未知，请先在服务商核实并绑定任务 ID。' :
          '本地任务已终止；如已提交远端生成，请在服务商核实结果。'
        this.store.saveJob(j)
        continue
      }
      if (j.status === 'submitting') {
        j.status = j.taskId ? 'running' : 'uncertain'
        j.error = j.taskId
          ? undefined
          : '上次关闭发生在提交期间。请在所用服务商核实是否已产生任务，再绑定任务 ID。'
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
  setAIProcessor(processor: NonNullable<Queue['aiProcessor']>) {
    this.aiProcessor = processor
  }
  enqueueAI(request: AiRequest, title: string, attachments: ChatAttachment[] = []) {
    const polishSource = request.type === 'scriptChatGenerate' && request.polishTurnId
      ? getScriptPolishSource(this.store.project(request.projectId), request.episodeId, request.polishTurnId)
      : undefined
    const model = structuredClone(this.store.config().models[request.type === 'generateImage' ? 'image' : 'text'])
    const active = this.store.aiTasks().filter((task) => ['queued', 'running'].includes(task.status))
    const existing = active.find((task) => JSON.stringify(task.request) === JSON.stringify(request) &&
      (!task.model || JSON.stringify(task.model) === JSON.stringify(model)))
    if (existing) return existing.id
    if (active.length >= 100) throw new Error('AI 队列最多保留 100 个待处理任务')
    const now = new Date().toISOString(), task: AiTask = {
      kind: 'ai', id: randomUUID(), projectId: request.projectId, title, request: structuredClone(request),
      attachments, status: 'queued', createdAt: now, updatedAt: now,
      model,
      ...(polishSource ? { polishSource } : {}),
    }
    this.store.saveJob(task)
    this.changed()
    void this.tickAI()
    return task.id
  }
  waitAI(id: string): Promise<AiTask> {
    const task = this.store.aiTask(id)
    if (!['queued', 'running'].includes(task.status)) return Promise.resolve(task)
    return new Promise((resolve) => this.aiWaiters.set(id, [...(this.aiWaiters.get(id) || []), resolve]))
  }
  private finishAI(task: AiTask) {
    this.store.saveJob(task)
    this.changed()
    for (const resolve of this.aiWaiters.get(task.id) || []) resolve(task)
    this.aiWaiters.delete(task.id)
  }
  async aiAction(id: string, action: 'cancel' | 'retry') {
    const task = this.store.aiTask(id)
    if (action === 'cancel') {
      if (task.status !== 'queued') throw new Error('只能取消尚未开始的 AI 任务')
      task.status = 'cancelled'
      this.finishAI(task)
    } else {
      if (!['failed', 'cancelled'].includes(task.status)) throw new Error('仅失败或已取消的 AI 任务可以重试')
      this.store.project(task.projectId)
      if (this.store.aiTasks().filter((other) => ['queued', 'running'].includes(other.status)).length >= 100)
        throw new Error('AI 队列最多保留 100 个待处理任务')
      if (this.store.aiTasks().some((other) => other.id !== task.id &&
          ['queued', 'running'].includes(other.status) && JSON.stringify(other.request) === JSON.stringify(task.request)))
        throw new Error('相同 AI 请求已在队列中')
      task.status = 'queued'
      task.error = undefined
      task.startedAt = undefined
      task.scheduledAt = new Date().toISOString()
      task.cancelRequested = false
      task.resultText = undefined
      task.message = undefined
      this.store.saveJob(task)
      this.changed()
      void this.tickAI()
    }
  }
  private async tickAI() {
    if (this.stopped || this.aiRunning || !this.aiProcessor || this.store.config().paused) return
    const task = this.store.aiTasks().reverse().find((task) => task.status === 'queued')
    if (!task) return
    this.aiRunning = true
    const controller = new AbortController()
    this.currentAI = { task, controller }
    task.status = 'running'
    task.startedAt = new Date().toISOString()
    this.store.saveJob(task)
    this.changed()
    try {
      this.store.project(task.projectId)
      const result = await this.aiProcessor(task, controller.signal)
      controller.signal.throwIfAborted()
      if ((result.text?.length || 0) > 200000) throw new Error('AI 结果超过保存上限，请拆分任务后重试')
      task.resultText = result.text
      task.message = result.message
      task.status = 'succeeded'
    } catch (cause) {
      task.status = controller.signal.aborted ? 'cancelled' : 'failed'
      task.error = controller.signal.aborted ? '本地任务已终止；如已提交远端生成，请在服务商核实结果。' :
        (cause instanceof Error ? cause.message : 'AI 生成失败').slice(0, 2500)
    } finally {
      try { this.finishAI(task) }
      finally {
        this.currentAI = undefined
        this.aiRunning = false
        void this.tickAI()
      }
    }
  }
  enqueue(projectId: string, shotIds: string[], stopOnFailure: boolean) {
    const p = this.store.project(projectId)
    const config = this.store.config()
    const { instanceType, videoResolution } = config
    const model = config.models.video
    const selected = [...new Set(shotIds)].map((id) => {
      const s = p.shots.find((s) => s.id === id)
      if (!s) throw new Error('镜头不存在')
      return s
    }).sort((a, b) => p.episodes.findIndex((ep) => ep.id === a.episodeId) -
      p.episodes.findIndex((ep) => ep.id === b.episodeId) || p.shots.indexOf(a) - p.shots.indexOf(b))
    const selection = new Set(selected.map((shot) => shot.id))
    const plans = new Map(selected.map((s) => [s.id, planVideoContinuity(p, s, selection, this.store.jobs())]))
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
      assertDialoguePlan(p, s)
      const timing = planVideoTiming(s, model.provider)
      if (s.usePrevis) {
        if (model.provider !== 'runninghub') throw new Error(`${s.title} 已启用白模视频参考，当前仅接入 RunningHub H3 Ref2VA；请切换服务或关闭预演参考`)
        if (!isPrevisCurrent(p, s)) throw new Error(`${s.title} 的预演视频缺失或已过期，请保存并重新导出白模视频`)
        if (timing.duration !== s.duration) throw new Error(`${s.title} 的生成时长需要调整为 ${timing.duration} 秒，请先修改镜头时长并重新导出预演`)
        if (plans.get(s.id)?.previous && Math.ceil(s.duration * 24) / 24 > 13) throw new Error(`${s.title} 同时需要前镜与预演参考，白模最长 13 秒；请缩短镜头或关闭预演参考，H3 参考视频总时长最多 15 秒`)
      }
      if (timing.issue === 'dialogue')
        throw new Error(`${s.title} 的对白约需 ${timing.required} 秒，超过所选视频模型的 ${timing.maximum} 秒上限；请在导演台拆成多个镜头后再生成`)
      if (timing.issue === 'duration')
        throw new Error(`${s.title} 超过所选视频模型的 ${timing.maximum} 秒上限，请先拆分镜头`)
      if (model.provider === 'minimax' && (s.lastMediaId || plans.get(s.id)?.next)) throw new Error(`${s.title} 需要尾帧衔接，所选海螺接口不支持尾帧控制，请使用可灵或 RunningHub`)
      if (['kling', 'doubao'].includes(model.provider) && (s.lastMediaId || plans.get(s.id)?.next) &&
          !s.firstMediaId && !plans.get(s.id)?.previous)
        throw new Error(`${s.title} 只有尾帧参考；当前所选接口需要同时提供首帧，请设置首帧或使用 RunningHub`)
      if (timing.duration !== s.duration) fitted.set(s.id, timing.duration)

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
      const plan = plans.get(s.id)!
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
        videoResolution: model.provider === 'runninghub' ? videoResolution : undefined,
        previousShotId: plan.previous?.shotId,
        previousVideoMediaId: plan.previous?.videoMediaId,
        nextShotId: plan.next?.shotId,
        nextVideoMediaId: plan.next?.videoMediaId,
        referenceMediaId: reference?.selectedMediaId,
        referenceMediaIds,
        previsMediaId: s.usePrevis ? s.previsMediaId : undefined,
        previsSubjects: s.usePrevis ? p.previsScenes?.find((scene) => scene.id === s.previs?.sceneId)?.objects.filter((object) => !object.hidden)
          .map((object) => ({ name: p.assets.find((asset) => asset.id === object.assetId)?.name || object.name, color: object.color })) : undefined,
        aspect: p.aspect,
        mappings: [],
        snapshot: structuredClone(s),
        createdAt: now,
        updatedAt: now,
        pollErrors: 0,
        outputs: [],
        model: structuredClone(model),
      })
    }
    this.changed()
    void this.tick()
    return fitted.size
  }
  private async tick() {
    if (this.stopped) return
    void this.tickAI()
    const jobs = this.store.jobs(),
      c = this.store.config()
    for (const j of jobs.filter((j) => j.status === 'running' && !this.busy.has(j.id)))
      void this.poll(j)
    if (c.paused) return
    let slots =
      Math.min(1, c.concurrency) -
      jobs.filter((j) => ['submitting', 'running', 'downloading', 'uncertain'].includes(j.status))
        .length
    for (const j of jobs.filter((j) => j.status === 'queued').reverse()) {
      if (slots <= 0) break
      const project = this.store.project(j.projectId)
      const orderedShots = project.episodes.flatMap((episode) => project.shots.filter((shot) => shot.episodeId === episode.id))
      const position = orderedShots.findIndex((shot) => shot.id === j.shotId)
      const earlierPending = jobs.some((other) => other.id !== j.id &&
        other.projectId === j.projectId && other.batchId === j.batchId &&
        ['queued', 'submitting', 'running', 'downloading', 'uncertain', 'paused'].includes(other.status) &&
        orderedShots.findIndex((shot) => shot.id === other.shotId) >= 0 &&
        orderedShots.findIndex((shot) => shot.id === other.shotId) < position)
      if (earlierPending) {
        const reason = '等待同批较早镜头完成后按顺序生成'
        if (j.error !== reason) { j.error = reason; this.save(j) }
        continue
      }
      if (j.previousShotId && !j.previousVideoMediaId) {
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
  private save(j: Job, respectCancellation = true) {
    const current = this.store.job(j.id)
    if (respectCancellation && current.cancelRequested) {
      j.cancelRequested = true
      if (current.status === 'cancelled' && j.status !== 'cancelled') {
        j.status = 'cancelled'
        j.error = current.error
      }
    }
    this.store.saveJob(j)
    this.changed()
  }
  private stoppedVideo(j: Job) {
    const current = this.store.job(j.id)
    return !!current.cancelRequested || current.status === 'cancelled'
  }
  private beforeSubmit(j: Job) {
    if (!this.stoppedVideo(j)) return false
    j.status = 'cancelled'
    j.error = '已在付费提交前终止任务'
    this.save(j)
    return true
  }
  private submitted(j: Job) {
    j.status = 'running'
    if (this.stoppedVideo(j)) {
      j.status = 'cancelled'
      j.error = '已终止本地任务；远端任务 ID 已保留'
      this.save(j)
      void this.cancelRemote(j)
    } else this.save(j)
  }
  private async cancelRemote(j: Job) {
    if (!j.taskId) return
    this.cancelling.add(j.id)
    try {
      if (j.model && j.model.provider !== 'runninghub') {
        j.error = '本地已终止；此服务不支持远端取消，请在服务商控制台核实或取消。任务 ID 已保留。'
      } else {
        await this.api.cancel(j)
        j.error = '本地已终止，远端取消请求已完成；已产生费用以服务商为准。'
      }
    } catch {
      j.error = '本地已终止，远端取消未确认；请在服务商控制台核实。任务 ID 已保留。'
    } finally {
      this.save(j)
      this.cancelling.delete(j.id)
    }
  }
  terminateAll() {
    let count = 0
    for (const saved of this.store.aiTasks().filter((task) => !isFinishedTask(task))) {
      const active = this.currentAI?.task.id === saved.id ? this.currentAI : undefined
      const task = active?.task || saved
      task.cancelRequested = true
      task.error = active ? '正在终止本地任务…' : '本地任务已终止；如已提交远端生成，请在服务商核实结果。'
      if (!active) task.status = 'cancelled'
      this.store.saveJob(task)
      active?.controller.abort()
      if (!active) this.finishAI(task)
      count++
    }
    for (const j of this.store.jobs().filter((job) => !isFinishedTask(job))) {
      j.cancelRequested = true
      if (j.status === 'submitting' && this.busy.has(j.id)) {
        j.error = '正在终止：等待提交返回任务 ID，不会再次提交。'
      } else if (j.status === 'uncertain') {
        j.error = '本地已停止；原提交结果未知，请先在服务商核实并绑定任务 ID。'
      } else {
        j.status = 'cancelled'
        j.error = '已终止本地任务'
      }
      this.save(j)
      this.downloads.get(j.id)?.abort()
      if (j.status === 'cancelled' && j.taskId) void this.cancelRemote(j)
      count++
    }
    this.store.set('config', { ...this.store.config(), paused: false })
    this.changed()
    return count
  }
  deleteTask(id: string) {
    const task = this.store.aiTasks().find((task) => task.id === id) || this.store.job(id)
    if (!isFinishedTask(task) || this.busy.has(id) || this.cancelling.has(id) || this.currentAI?.task.id === id)
      throw new Error('请等待任务结束或终止完成后再删除记录')
    if (!('kind' in task) && task.status !== 'succeeded' && task.batchId && this.store.jobs().some((other) =>
      other.id !== id && other.batchId === task.batchId && !isFinishedTask(other)))
      throw new Error('同批镜头仍依赖此任务记录，请先完成或终止同批任务')
    this.store.db.prepare('DELETE FROM jobs WHERE id=?').run(id)
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
      assertDialoguePlan(p, j.snapshot)
      if (j.model && j.model.provider !== 'runninghub') {
        if (!this.models) throw new Error('视频服务不可用')
        await mkdir(this.store.file(p.id, 'downloads'), { recursive: true })
        const frame = this.store.file(p.id, `downloads/chain-${j.id}.png`)
        const fitted = this.store.file(p.id, `downloads/reference-${j.id}.png`)
        const endFrame = this.store.file(p.id, `downloads/end-${j.id}.png`)
        const fittedEnd = this.store.file(p.id, `downloads/end-reference-${j.id}.png`)
        const mediaFile = (id?: string) => {
          const media = p.media.find((m) => m.id === id && m.kind === 'image')
          return media ? this.store.file(p.id, media.file) : undefined
        }
        let first = mediaFile(j.snapshot.firstMediaId)
        let last = mediaFile(j.snapshot.lastMediaId)
        try {
          if (j.previousShotId) {
            const previous = p.shots.find((s) => s.id === j.previousShotId)
            const video = p.media.find((m) => m.id === (j.previousVideoMediaId || previous?.videoMediaId) && m.kind === 'video' && m.ownerId === j.previousShotId)
            if (!video) throw new Error('上一镜头视频缺失，未提交本镜头')
            await extractLastFrame(this.store.file(p.id, video.file), frame, this.resourcesPath)
            first = frame
          }
          if (j.nextVideoMediaId) {
            const video = p.media.find((m) => m.id === j.nextVideoMediaId && m.kind === 'video' && m.ownerId === j.nextShotId)
            if (!video) throw new Error('保留的后镜头视频缺失，未提交本镜头')
            await extractFirstFrame(this.store.file(p.id, video.file), endFrame, this.resourcesPath)
            last = endFrame
          }
          if (first) { await fitReferenceFrame(first, fitted, j.aspect || p.aspect, this.resourcesPath); first = fitted }
          if (last) { await fitReferenceFrame(last, fittedEnd, j.aspect || p.aspect, this.resourcesPath); last = fittedEnd }
          if (j.model.provider === 'minimax' && !first && (j.aspect || p.aspect) !== '16:9')
            throw new Error('海螺竖屏或方形视频需要首帧，请先生成对应比例的镜头首帧')
          j.remoteKind = first ? 'image2video' : 'text2video'
          this.save(j)
          const prompt = modelVideoPrompt(p, j.snapshot, !!j.previousShotId, videoBoundaryContext(p, j), !!last)
          if (this.beforeSubmit(j)) return
          sent = true
          j.taskId = await this.models.startVideo(j, prompt, first, last)
          this.submitted(j)
        } finally {
          for (const file of [frame, fitted, endFrame, fittedEnd]) await rm(file, { force: true })
        }
        return
      }
      const nodeInfoList: { nodeId: string; fieldName: string; fieldValue: string | number }[] = []
      if (j.instanceType) {
        const source = await this.api.workflow(j)
        const multiReference = source['13']?.class_type === 'RHMiniMaxH3Ref2VAEncode'
        if (j.previsMediaId && !multiReference) throw new Error('当前云端工作流不是 H3 Ref2VA，不能接收预演视频；未提交付费任务')
        const frames: { first?: string; last?: string; references: string[]; video?: string; videoHasAudio?: boolean; previs?: string } = { references: [] }
        const referenceLabels: string[] = []
        let lastReferenceIndex = 0
        const addImage = async (mediaId: string, label: string) => {
          if (frames.references.length >= 9) return
          const media = p.media.find((item) => item.id === mediaId && item.kind === 'image')
          if (!media) throw new Error(`缺少${label}的图片素材`)
          frames.references.push(await this.api.upload(j.site, this.store.file(p.id, media.file)))
          referenceLabels.push(label)
        }
        let continuing = false
        let audioReferenceShot: Shot | undefined
        if (j.previousShotId) {
          const previous = p.shots.find((shot) => shot.id === j.previousShotId)
          const video = p.media.find((media) => media.id === (j.previousVideoMediaId || previous?.videoMediaId) && media.kind === 'video' && media.ownerId === j.previousShotId)
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
          if (multiReference) {
            const previousVideo = this.store.file(p.id, video.file)
            const trimmed = this.store.file(p.id, `downloads/previs-chain-${j.id}.mp4`)
            try {
              const input = j.previsMediaId ? await fitPrevisContinuityVideo(previousVideo, trimmed, 15 - Math.ceil(j.snapshot.duration * 24) / 24, this.resourcesPath) : previousVideo
              frames.videoHasAudio = await hasAudioTrack(input, this.resourcesPath)
              frames.video = await this.api.upload(j.site, input)
            } finally { await rm(trimmed, { force: true }) }
            if (frames.videoHasAudio) audioReferenceShot = previous
          }
          continuing = true
        }
        if (!continuing && j.snapshot.firstMediaId) {
          await addImage(j.snapshot.firstMediaId, '当前镜头的开场构图')
          frames.first = frames.references[0]
        }
        if (j.nextVideoMediaId) {
          const video = p.media.find((media) => media.id === j.nextVideoMediaId && media.kind === 'video' && media.ownerId === j.nextShotId)
          if (!video) throw new Error('保留的后镜头视频缺失，未提交本镜头')
          const frame = this.store.file(p.id, `downloads/end-${j.id}.png`)
          await mkdir(this.store.file(p.id, 'downloads'), { recursive: true })
          try {
            await extractFirstFrame(this.store.file(p.id, video.file), frame, this.resourcesPath)
            frames.last = await this.api.upload(j.site, frame)
            frames.references.push(frames.last)
            referenceLabels.push('保留的后镜头实际首帧；仅作为本镜收尾目标，平滑接回后镜头')
            lastReferenceIndex = frames.references.length
          } finally { await rm(frame, { force: true }) }
        } else if (j.snapshot.lastMediaId) {
          await addImage(j.snapshot.lastMediaId, '当前镜头的收尾构图')
          frames.last = frames.references.at(-1)
          lastReferenceIndex = frames.references.length
        }
        const assetMediaIds = j.referenceMediaIds || (j.referenceMediaId ? [j.referenceMediaId] : [])
        for (const mediaId of assetMediaIds) {
          if (mediaId === j.snapshot.firstMediaId || mediaId === j.snapshot.lastMediaId) continue
          const asset = p.assets.find((item) => item.selectedMediaId === mediaId)
          await addImage(mediaId, asset ? `${asset.kind} ${asset.name}` : '关联资产')
        }
        if (j.previsMediaId) {
          const media = p.media.find((m) => m.id === j.previsMediaId && m.ownerId === j.shotId && m.kind === 'video' && m.slot === 'previs')
          if (!media) throw new Error('入队时固定的预演视频缺失，未提交付费任务')
          frames.previs = await this.api.upload(j.site, this.store.file(p.id, media.file))
        }
        const workflow = prepareVideoWorkflow(
          source, j.snapshot, j.aspect || p.aspect, frames,
          videoPromptWithAssets(p, j.snapshot, continuing, !!frames.first,
            multiReference ? referenceLabels : [], !!frames.video, audioReferenceShot,
            multiReference ? lastReferenceIndex : frames.last ? frames.first ? 2 : 1 : 0,
            videoBoundaryContext(p, j), !!frames.previs, j.previsSubjects),
          j.videoResolution || '480p',
        )
        if (this.beforeSubmit(j)) return
        sent = true
        j.taskId = await this.api.start(j, nodeInfoList, workflow)
        this.submitted(j)
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
      if (this.beforeSubmit(j)) return
      sent = true
      j.taskId = await this.api.start(j, nodeInfoList)
      this.submitted(j)
    } catch (e) {
      j.status = sent && !(e instanceof RejectedRequest) && !(e instanceof ModelRejectedRequest) ? 'uncertain' : 'failed'
      j.error = e instanceof Error ? e.message : '提交失败'
      if (this.stoppedVideo(j)) {
        j.cancelRequested = true
        if (!sent) j.status = 'cancelled'
        else if (j.status === 'uncertain') j.error = '本地已停止；原提交结果未知，请先在服务商核实并绑定任务 ID。'
      }
      this.save(j)
    } finally {
      this.busy.delete(j.id)
    }
  }
  private async poll(j: Job) {
    this.busy.add(j.id)
    const controller = new AbortController()
    this.downloads.set(j.id, controller)
    try {
      const external = j.model && j.model.provider !== 'runninghub' ? await this.models!.videoResult(j) : undefined
      const status = external?.status || await this.api.status(j)
      if (this.stoppedVideo(j)) return
      if (['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status)) {
        j.status = status.startsWith('CANCEL') ? 'cancelled' : 'failed'
        let detail: string | undefined
        if (j.status === 'failed') {
          try { if (!external) detail = await this.api.failure(j) } catch { /* preserve the final task state */ }
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
      const outputs = external ? external.urls.map((fileUrl) => ({ fileUrl, fileType: 'video' })) : await this.api.outputs(j)
      if (this.stoppedVideo(j)) return
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
          const file = await downloadVideo(this.store, j.projectId, output.fileUrl, controller.signal, j.model?.provider)
          try {
            controller.signal.throwIfAborted()
            await importMedia(
              this.store,
              j.projectId,
              j.shotId,
              'video',
              file,
              j.snapshot.videoPrompt,
              `${j.taskId}:${output.fileUrl}`,
              undefined,
              controller.signal,
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
      if (this.stoppedVideo(j)) return
      j.pollErrors++
      j.error =
        (e instanceof Error ? e.message : '查询失败') + '；保留任务 ID，可继续查询，不会重新计费。'
      j.status = j.pollErrors >= 5 ? 'paused' : 'running'
      this.save(j)
    } finally {
      this.downloads.delete(j.id)
      this.busy.delete(j.id)
    }
  }
  async action(id: string, action: 'cancel' | 'retry' | 'resume' | 'attach', taskId?: string) {
    const j = this.store.job(id)
    if (action !== 'cancel' && !this.store.project(j.projectId).shots.some((shot) => shot.id === j.shotId))
      throw new Error('旧剧本镜头已存档，不能重新提交视频任务')
    if (this.busy.has(id) || this.cancelling.has(id)) throw new Error('任务正在同步或终止，请稍后重试')
    this.busy.add(id)
    try {
      if (action === 'cancel') {
        if (j.status === 'submitting')
          throw new Error('正在提交；请等返回任务 ID 后再取消，避免任务状态不确定')
        if (j.taskId && j.model && j.model.provider !== 'runninghub')
          throw new Error('此服务不支持远端取消，任务仍可继续查询；请在服务商控制台核实或取消')
        if (j.taskId && ['running', 'paused', 'downloading'].includes(j.status))
          await this.api.cancel(j)
        j.status = 'cancelled'
        j.error = '已取消；已发生的远端费用以 RunningHub 为准'
      }
      if (action === 'attach') {
        if (!taskId) throw new Error('请输入远端任务 ID')
        j.taskId = taskId
        j.cancelRequested = false
        j.status = 'running'
        j.pollErrors = 0
        j.error = undefined
      }
      if (action === 'resume') {
        if (j.status !== 'paused') throw new Error('只有暂停任务可以继续')
        j.status = j.taskId ? 'running' : 'queued'
        j.cancelRequested = false
        j.pollErrors = 0
        j.scheduledAt = new Date().toISOString()
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
        j.scheduledAt = new Date().toISOString()
        j.cancelRequested = false
      }
      this.save(j, action === 'cancel')
    } finally {
      this.busy.delete(id)
    }
    void this.tick()
  }
}
