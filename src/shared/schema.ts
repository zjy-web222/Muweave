import { z } from 'zod'

export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const text = z.string().max(200000)
export const mediaSchema = z.object({
  id,
  kind: z.enum(['image', 'video', 'audio', 'export']),
  name: z.string().max(200),
  file: z.string().max(500),
  slot: z.enum(['first', 'last', 'video', 'audio', 'reference', 'export']),
  ownerId: id,
  prompt: text.default(''),
  createdAt: z.string(),
  taskId: z.string().optional(),
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
  approved: z.boolean().default(false),
  stale: z.boolean().default(false),
})
export type Shot = z.infer<typeof shotSchema>
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
export const scriptChatTurnSchema = z.object({
  id,
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(10000),
  script: text.optional(),
  analysis: z.string().max(5000).optional(),
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
  assets: z.array(assetSchema).max(1000),
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
export const configSchema = z.object({
  site: z.enum(['https://www.runninghub.ai', 'https://www.runninghub.cn']),
  workflowId: z.string().regex(/^\d*$/).max(100),
  mappings: z.array(mappingSchema).max(100),
  concurrency: z.number().int().min(1).max(4),
  ffmpeg: z.string().max(1000),
  theme: z.enum(['light', 'dark']),
  locale: z.enum(['zh', 'en']).default('zh'),
  paused: z.boolean(),
})
export type Config = z.infer<typeof configSchema>
export const defaultConfig: Config = {
  site: videoWorkflow.site,
  workflowId: videoWorkflow.id,
  mappings: [],
  concurrency: 1,
  ffmpeg: 'ffmpeg',
  theme: 'light',
  locale: 'zh',
  paused: false,
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
  instanceType: z.literal('plus').optional(),
  aspect: projectSchema.shape.aspect.optional(),
  mappings: z.array(mappingSchema),
  snapshot: shotSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().optional(),
  pollErrors: z.number().default(0),
  outputs: z.array(z.string()).default([]),
})
export type Job = z.infer<typeof jobSchema>
export type Snapshot = {
  projects: Project[]
  jobs: Job[]
  config: Config
  hasKey: boolean
  chatgptOpen: boolean
  dataPath: string
  exporting: boolean
}
export type Reply =
  { ok: true; state: Snapshot; message?: string; text?: string } | { ok: false; error: string }
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
  z.object({
    type: z.literal('scriptChatPickFiles'),
    ...pid,
    max: z.number().int().min(1).max(10),
  }),
  z.object({
    type: z.literal('scriptChatGenerate'),
    ...pid,
    episodeId: id,
    request: z.string().max(2000),
    attachmentIds: z.array(id).max(10).default([]),
  }),
  z.object({ type: z.literal('codexStatus') }),
  z.object({ type: z.literal('codexLogin') }),
  z.object({
    type: z.literal('generateText'),
    ...pid,
    episodeId: id,
    kind: z.enum(['script', 'assets', 'storyboard']),
    prompt: text,
  }),
  z.object({ type: z.literal('shot'), ...pid, shot: shotSchema }),
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
  }),
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
    taskId: z.string().regex(/^\d+$/).optional(),
  }),
  z.object({ type: z.literal('pause'), paused: z.boolean() }),
  z.object({ type: z.literal('exportArchive'), ...pid }),
  z.object({ type: z.literal('importArchive') }),
  z.object({
    type: z.literal('exportEpisode'),
    ...pid,
    episodeId: id,
    format: z.enum(['mp4', 'srt', 'html']),
  }),
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
  onChange(listener: () => void): () => void
}
declare global {
  interface Window {
    director: Bridge
  }
}

export function blankShot(episodeId: string, locale: Config['locale'] = 'zh'): Shot {
  return shotSchema.parse({
    id: crypto.randomUUID(),
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
  return `media://asset/${projectId}/${mediaId}`
}
