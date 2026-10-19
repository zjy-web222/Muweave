import { z } from 'zod'
import { previsSceneSchema, previsPlanSchema, previsSourceSchema } from './previs'
import { defaultModels, modelsSchema, modelSelectionSchema, modelChannelSchema } from './models'

export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const text = z.string().max(200000)
export const mediaSchema = z.object({
  id,
  kind: z.enum(['image', 'video', 'audio', 'export', 'model']),
  name: z.string().max(200),
  file: z.string().max(500),
  slot: z.enum(['first', 'last', 'video', 'audio', 'reference', 'export', 'previs', 'composition', 'model']),
  ownerId: id,
  prompt: text.default(''),
  createdAt: z.string(),
  taskId: z.string().optional(),
  previsSource: previsSourceSchema.optional(),
})
export type Media = z.infer<typeof mediaSchema>
export const assetSchema = z.object({
  id,
  kind: z.enum(['character', 'location', 'prop']),
  name: z.string().max(200),
  description: text,
  prompt: text,
  selectedMediaId: id.optional(),
})
export type Asset = z.infer<typeof assetSchema>
export const shotSchema = z.object({
  id,
  episodeId: id,
  title: z.string().max(200),
  scene: z.string().max(200).default(''),
  action: text,
  dialogue: text,
  speaker: z.string().max(200).default(''),
  pronunciationNotes: z.string().max(2000).optional(),
  imagePrompt: text,
  videoPrompt: text,
  size: z.string().max(100).default('中景'),
  camera: z.string().max(200).default('固定'),
  lighting: z.string().max(200).default('自然光'),
  duration: z.number().min(1).max(120),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(42),
  assetIds: z.array(id).max(100).default([]),
  firstMediaId: id.optional(),
  lastMediaId: id.optional(),
  videoMediaId: id.optional(),
  audioMediaId: id.optional(),
  previs: previsPlanSchema.optional(),
  previsMediaId: id.optional(),
  usePrevis: z.boolean().optional(),
  approved: z.boolean().default(false),
  stale: z.boolean().default(false),
})
export type Shot = z.infer<typeof shotSchema>
export const shotBatchPatchSchema = z.object({
  scene: shotSchema.shape.scene.removeDefault().optional(),
  size: shotSchema.shape.size.removeDefault().optional(),
  camera: shotSchema.shape.camera.removeDefault().optional(),
  lighting: shotSchema.shape.lighting.removeDefault().optional(),
  duration: shotSchema.shape.duration.optional(),
  assetIds: shotSchema.shape.assetIds.removeDefault().optional(),
}).strict().refine((patch) => Object.values(patch).some((value) => value !== undefined), '请选择需要应用的参数')
export type ShotBatchPatch = z.infer<typeof shotBatchPatchSchema>
export const scriptArchiveSchema = z.object({
  id,
  episodeId: id,
  title: z.string().max(200),
  script: text,
  shots: z.array(shotSchema).max(2000),
  createdAt: z.string(),
})
export type ScriptArchive = z.infer<typeof scriptArchiveSchema>
export const chatAttachmentSchema = z.object({
  id,
  name: z.string().min(1).max(255),
  size: z
    .number()
    .int()
    .min(0)
    .max(50 * 1024 * 1024),
  file: z.string().regex(/^chat\/[a-zA-Z0-9_-]{1,100}$/),
})
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>
export const scriptPolishDirectionSchema = z.object({
  title: z.string().trim().min(1).max(40),
  instruction: z.string().trim().min(1).max(300),
})
export const scriptChatTurnSchema = z.object({
  id,
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(10000),
  script: text.optional(),
  analysis: z.string().max(5000).optional(),
  polishDirections: z.array(scriptPolishDirectionSchema).length(2).optional(),
  polishSkipped: z.boolean().optional(),
  polishSourceTurnId: id.optional(),
  attachments: z.array(chatAttachmentSchema).max(10).optional(),
  createdAt: z.string(),
})
export type ScriptChatTurn = z.infer<typeof scriptChatTurnSchema>
export const projectSchema = z.object({
  id,
  title: z.string().min(1).max(200),
  description: text,
  aspect: z.enum(['16:9', '9:16', '1:1']),
  style: z.string().max(200),
  source: text,
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().min(0),
  episodes: z
    .array(
      z.object({
        id,
        title: z.string().max(200),
        script: text,
        scriptChat: z.array(scriptChatTurnSchema).default([]),
      }),
    )
    .max(200),
  shots: z.array(shotSchema).max(2000),
  scriptArchives: z.array(scriptArchiveSchema).default([]),
  assets: z.array(assetSchema).max(1000),
  previsScenes: z.array(previsSceneSchema).max(200).optional(),
  media: z.array(mediaSchema).max(10000),
  groups: z
    .array(
      z.object({
        id,
        title: z.string().max(100),
        shotIds: z.array(id).max(500),
        stopOnFailure: z.boolean().default(false),
      }),
    )
    .max(200),
  layout: z.record(
    z.string().max(150),
    z.object({ x: z.number().finite(), y: z.number().finite() }),
  ),
  viewport: z
    .object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.1).max(3) })
    .optional(),
})
export type Project = z.infer<typeof projectSchema>
export const mappingSchema = z.object({
  nodeId: z.string().regex(/^\d+$/),
  fieldName: z.string().min(1).max(100),
  source: z.enum(['prompt', 'first', 'last', 'seed', 'duration', 'fixed']),
  value: z.string().max(5000).default(''),
})
export type Mapping = z.infer<typeof mappingSchema>
export const videoWorkflow = {
  site: 'https://www.runninghub.cn',
  id: '2105215916815511553',
  instanceType: 'plus',
} as const
export const videoResolutionSchema = z.enum(['480p', '768p'])
export type VideoResolution = z.infer<typeof videoResolutionSchema>
export const videoSizes = {
  '480p': { '16:9': [864, 480], '9:16': [480, 864], '1:1': [640, 640] },
  '768p': { '16:9': [1344, 768], '9:16': [768, 1344], '1:1': [1024, 1024] },
} as const
export const configSchema = z.object({
  site: z.enum(['https://www.runninghub.ai', 'https://www.runninghub.cn']),
  workflowId: z.string().regex(/^\d*$/).max(100),
  mappings: z.array(mappingSchema).max(100),
  instanceType: z.enum(['default', 'plus']).default('plus'),
  videoResolution: videoResolutionSchema.default('480p'),
  concurrency: z.number().int().min(1).max(4),
  ffmpeg: z.string().max(1000),
  theme: z.enum(['light', 'dark']),
  locale: z.enum(['zh', 'en']).default('zh'),
  paused: z.boolean(),
  models: modelsSchema.default(defaultModels),
})
export type Config = z.infer<typeof configSchema>
export const defaultConfig: Config = {
  site: videoWorkflow.site,
  workflowId: videoWorkflow.id,
  mappings: [],
  instanceType: videoWorkflow.instanceType,
  videoResolution: '480p',
  concurrency: 1,
  ffmpeg: 'ffmpeg',
  theme: 'light',
  locale: 'zh',
  paused: false,
  models: structuredClone(defaultModels),
}
export const jobSchema = z.object({
  id,
  projectId: id,
  shotId: id,
  batchId: id.optional(),
  stopOnFailure: z.boolean().default(false),
  status: z.enum([
    'queued',
    'submitting',
    'running',
    'downloading',
    'succeeded',
    'failed',
    'uncertain',
    'paused',
    'cancelled',
  ]),
  taskId: z.string().optional(),
  site: z.string(),
  workflowId: z.string(),
  instanceType: z.enum(['default', 'plus']).optional(),
  videoResolution: videoResolutionSchema.optional(),
  previousShotId: id.optional(),
  previousVideoMediaId: id.optional(),
  nextShotId: id.optional(),
  nextVideoMediaId: id.optional(),
  referenceMediaId: id.optional(),
  referenceMediaIds: z.array(id).max(9).optional(),
  aspect: projectSchema.shape.aspect.optional(),
  mappings: z.array(mappingSchema),
  snapshot: shotSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().optional(),
  scheduledAt: z.string().optional(),
  cancelRequested: z.boolean().optional(),
  pollErrors: z.number().default(0),
  outputs: z.array(z.string()).default([]),
  model: modelSelectionSchema.optional(),
  remoteKind: z.enum(['text2video', 'image2video']).optional(),
  previsMediaId: id.optional(),
  previsSubjects: z.array(z.object({ name: z.string().max(200), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) })).max(100).optional(),
})
export type Job = z.infer<typeof jobSchema>
export const aiRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('scriptChatGenerate'), projectId: id, episodeId: id,
    request: z.string().max(2000), attachmentIds: z.array(id).max(10).default([]),
    polishTurnId: id.optional() }),
  z.object({ type: z.literal('generateText'), projectId: id, episodeId: id,
    kind: z.enum(['script', 'assets', 'storyboard']), prompt: text }),
  z.object({ type: z.literal('generateStoryboard'), projectId: id, episodeId: id,
    request: z.string().max(2000).default('') }),
  z.object({ type: z.literal('generateImage'), projectId: id, ownerId: id,
    slot: z.enum(['first', 'last', 'reference']),
    prompt: z.string().trim().min(1).max(12000).optional() }),
])
export type AiRequest = z.infer<typeof aiRequestSchema>
export const aiTaskSchema = z.object({
  kind: z.literal('ai'), id, projectId: id, title: z.string().max(300),
  request: aiRequestSchema,
  attachments: z.array(chatAttachmentSchema).max(10).default([]),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  createdAt: z.string(), updatedAt: z.string(), startedAt: z.string().optional(),
  scheduledAt: z.string().optional(), cancelRequested: z.boolean().optional(),
  error: z.string().max(2500).optional(), resultText: text.optional(),
  message: z.string().optional(),
  model: modelSelectionSchema.optional(),
  polishSource: z.object({ turnId: id, script: text }).optional(),
  remoteTaskId: z.string().max(200).optional(),
  remoteQueryUrl: z.string().url().max(1000).optional(),
}).refine((task) => task.projectId === task.request.projectId, '任务项目不一致')
export type AiTask = z.infer<typeof aiTaskSchema>
export const snapshotSchema = z.object({
  projects: z.array(projectSchema),
  jobs: z.array(jobSchema),
  aiTasks: z.array(aiTaskSchema).default([]),
  config: configSchema,
  hasKey: z.boolean(),
  chatgptOpen: z.boolean(),
  dataPath: z.string(),
  exporting: z.boolean(),
  credentials: z.record(z.string(), z.boolean()).default({}),
  modelServicesReady: z.boolean().default(false),
  videoResolutionReady: z.boolean().default(false),
  dialogueRulesReady: z.boolean().default(false),
})
export type Snapshot = z.infer<typeof snapshotSchema>
export const replySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), state: snapshotSchema, message: z.string().optional(),
    text: z.string().optional(), download: z.string().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type Reply = z.infer<typeof replySchema>
const pid = { projectId: id }
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot') }),
  z.object({
    type: z.literal('create'),
    title: z.string().min(1).max(200),
    aspect: z.enum(['16:9', '9:16', '1:1']),
    demo: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('project'),
    ...pid,
    patch: z.object({
      title: z.string().min(1).max(200).optional(),
      description: text.optional(),
      source: text.optional(),
      style: z.string().max(200).optional(),
    }),
  }),
  z.object({
    type: z.literal('episode'),
    ...pid,
    episodeId: id.optional(),
    title: z.string().max(200),
    script: text,
  }),
  z.object({ type: z.literal('deleteEpisode'), ...pid, episodeId: id }),
  z.object({ type: z.literal('scriptChat'), ...pid, episodeId: id, turn: scriptChatTurnSchema }),
  z.object({ type: z.literal('scriptChatPolishDecision'), ...pid, episodeId: id, turnId: id, skipped: z.boolean() }),
  z.object({
    type: z.literal('scriptChatPickFiles'),
    ...pid,
    max: z.number().int().min(1).max(10),
  }),
  ...aiRequestSchema.options,
  z.object({ type: z.literal('aiEnqueue'), request: aiRequestSchema }),
  z.object({ type: z.literal('aiTask'), taskId: id, action: z.enum(['cancel', 'retry']) }),
  z.object({ type: z.literal('codexStatus') }),
  z.object({ type: z.literal('codexLogin') }),
  z.object({ type: z.literal('shot'), ...pid, shot: shotSchema }),
  z.object({ type: z.literal('savePrevis'), ...pid, shotId: id, scene: previsSceneSchema, plan: previsPlanSchema }),
  z.object({ type: z.literal('previsOutput'), ...pid, shotId: id, action: z.enum(['start', 'finish', 'cancel']),
    sessionId: z.string().uuid().optional(), format: z.enum(['image', 'video']).optional(), time: z.number().min(0).max(120).optional() }),
  z.object({ type: z.literal('batchShots'), ...pid, episodeId: id,
    shotIds: z.array(id).min(1).max(2000), patch: shotBatchPatchSchema,
    assetMode: z.enum(['merge', 'replace']).default('merge') }),
  z.object({ type: z.literal('deleteShot'), ...pid, shotId: id }),
  z.object({ type: z.literal('reorder'), ...pid, shotId: id, delta: z.enum(['up', 'down']) }),
  z.object({ type: z.literal('asset'), ...pid, asset: assetSchema }),
  z.object({ type: z.literal('uploadAssetImage'), ...pid, kind: assetSchema.shape.kind }),
  z.object({ type: z.literal('deleteAsset'), ...pid, assetId: id }),
  z.object({
    type: z.literal('layout'),
    ...pid,
    layout: projectSchema.shape.layout,
    viewport: projectSchema.shape.viewport,
  }),
  z.object({
    type: z.literal('group'),
    ...pid,
    title: z.string().min(1).max(100),
    shotIds: z.array(id).min(1).max(500),
    stopOnFailure: z.boolean(),
  }),
  z.object({ type: z.literal('deleteGroup'), ...pid, groupId: id }),
  z.object({ type: z.literal('importSource'), ...pid, episodeId: id }),
  z.object({ type: z.literal('parse'), ...pid, episodeId: id, raw: text }),
  z.object({ type: z.literal('clipboard') }),
  z.object({
    type: z.literal('chatgpt'),
    ...pid,
    ownerId: id,
    kind: z.enum(['script', 'assets', 'storyboard', 'image']),
    prompt: text,
    slot: z.enum(['first', 'last', 'reference']).optional(),
  }),
  z.object({ type: z.literal('openChatGPT') }),
  z.object({ type: z.literal('clearChatGPT') }),
  z.object({ type: z.literal('importMedia'), ...pid, ownerId: id, slot: mediaSchema.shape.slot }),
  z.object({ type: z.literal('selectMedia'), ...pid, mediaId: id }),
  z.object({
    type: z.literal('config'),
    config: configSchema,
    key: z.string().max(1000).optional(),
    credentials: z.array(z.object({ channel: modelChannelSchema, selection: modelSelectionSchema,
      key: z.string().trim().min(1).max(4000), secret: z.string().trim().max(4000).optional() })).max(20).optional(),
  }),
  z.object({ type: z.literal('clearModelKey'), channel: modelChannelSchema, selection: modelSelectionSchema }),
  z.object({ type: z.literal('testModelConnection'), channel: modelChannelSchema }),
  z.object({ type: z.literal('modelStatus'), channel: modelChannelSchema }),
  z.object({ type: z.literal('clearKey') }),
  z.object({ type: z.literal('testConnection') }),
  z.object({ type: z.literal('workflow') }),
  z.object({
    type: z.literal('queue'),
    ...pid,
    shotIds: z.array(id).min(1).max(100),
    stopOnFailure: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('job'),
    jobId: id,
    action: z.enum(['retry', 'cancel', 'resume', 'attach']),
    taskId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).optional(),
  }),
  z.object({ type: z.literal('pause'), paused: z.boolean() }),
  z.object({ type: z.literal('terminateTasks') }),
  z.object({ type: z.literal('deleteTask'), taskId: id }),
  z.object({ type: z.literal('exportArchive'), ...pid }),
  z.object({ type: z.literal('importArchive') }),
  z.object({
    type: z.literal('exportEpisode'),
    ...pid,
    episodeId: id,
    format: z.enum(['mp4', 'srt', 'html']),
  }),
  z.object({ type: z.literal('previewEpisode'), ...pid, episodeId: id }),
  z.object({ type: z.literal('cancelExport') }),
  z.object({ type: z.literal('reveal'), ...pid, mediaId: id.optional() }),
  z.object({ type: z.literal('history'), ...pid }),
  z.object({ type: z.literal('restore'), ...pid, revision: z.number().int().min(0) }),
  z.object({ type: z.literal('renameProject'), ...pid, title: z.string().min(1).max(200) }),
  z.object({ type: z.literal('deleteProject'), ...pid }),
])
export type Command = z.infer<typeof commandSchema>
export interface Bridge {
  command(command: Command): Promise<Reply>
  previsFrame?(sessionId: string, index: number, data: ArrayBuffer): Promise<void>
  onChange(listener: () => void): () => void
  studio?: boolean
  mediaUrl?(url: string): string
}
declare global {
  interface Window {
    director: Bridge
  }
}

export function randomId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // MCP Apps may run in an opaque iframe where randomUUID requires a secure context.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function blankShot(episodeId: string, locale: Config['locale'] = 'zh'): Shot {
  return shotSchema.parse({
    id: randomId(),
    episodeId,
    title: locale === 'en' ? 'New shot' : '新镜头',
    action: '',
    dialogue: '',
    imagePrompt: '',
    videoPrompt: '',
    duration: 5,
  })
}
export function mediaUrl(projectId: string, mediaId: string) {
  const url = `media://asset/${projectId}/${mediaId}`
  return typeof window !== 'undefined' && window.director?.mediaUrl ? window.director.mediaUrl(url) : url
}
