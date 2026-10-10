import { z } from 'zod'

export const modelChannelSchema = z.enum(['text', 'image', 'video'])
export type ModelChannel = z.infer<typeof modelChannelSchema>
export const modelSelectionSchema = z.object({
  provider: z.enum([
    'chatgpt',
    'openai',
    'deepseek',
    'qwen',
    'claude',
    'gemini',
    'runninghub',
    'kling',
    'minimax',
    'kimi',
    'glm',
    'doubao',
    'xai',
    'mistral',
    'bfl',
    'hunyuan',
    'ernie',
    'stepfun',
  ]),
  model: z
    .string()
    .trim()
    .max(150)
    .regex(/^[a-zA-Z0-9._:/-]*$/),
  region: z.enum(['cn', 'global']).default('cn'),
})
export type ModelSelection = z.infer<typeof modelSelectionSchema>
export const modelProviders = {
  text: ['chatgpt', 'openai', 'deepseek', 'qwen', 'claude', 'gemini', 'kimi', 'glm', 'doubao', 'minimax', 'xai', 'mistral', 'hunyuan', 'ernie', 'stepfun'],
  image: ['chatgpt', 'openai', 'qwen', 'gemini', 'doubao', 'minimax', 'xai', 'bfl', 'glm'],
  video: ['runninghub', 'kling', 'minimax', 'doubao', 'xai'],
} as const
export const providerNames: Record<ModelSelection['provider'], string> = {
  chatgpt: 'ChatGPT',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  qwen: '通义 / 万相',
  claude: 'Claude',
  gemini: 'Gemini',
  runninghub: 'RunningHub',
  kling: '可灵 Kling',
  minimax: 'MiniMax 海螺',
  kimi: 'Kimi / 月之暗面',
  glm: '智谱 GLM / Z.AI',
  doubao: '豆包 / Seedream / Seedance',
  xai: 'xAI / Grok',
  mistral: 'Mistral',
  bfl: 'Black Forest Labs / FLUX',
  hunyuan: '腾讯混元',
  ernie: '百度文心 / ERNIE',
  stepfun: '阶跃星辰 / StepFun',
}
export const modelPresets: Record<
  ModelChannel,
  Partial<Record<ModelSelection['provider'], string[]>>
> = {
  text: {
    chatgpt: [''],
    openai: ['gpt-5-mini', 'gpt-5.4'],
    deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
    qwen: ['qwen-plus', 'qwen-max', 'qwen3.5-plus', 'qwen3.5-flash', 'qwen-vl-plus'],
    claude: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
    gemini: ['gemini-3.8-flash', 'gemini-3.1-pro-preview'],
    kimi: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code'],
    glm: ['glm-5.3', 'glm-5.2', 'glm-5', 'glm-4.7', 'glm-4.6v'],
    doubao: ['doubao-seed-2-1-pro-260628', 'doubao-seed-2-0-pro-260215', 'doubao-seed-2-0-lite-260428', 'doubao-seed-2-0-mini-260428'],
    minimax: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed'],
    xai: ['grok-4.7'],
    mistral: ['mistral-small-latest', 'mistral-large-latest'],
    hunyuan: ['hunyuan-turbos-latest', 'hunyuan-t1-latest'],
    ernie: ['ernie-4.5-turbo-128k', 'ernie-4.5-turbo-vl'],
    stepfun: ['step-3.7-flash', 'step-3.5-flash'],
  },
  image: {
    chatgpt: [''],
    openai: ['gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1.5'],
    qwen: ['wan2.5-t2i-preview', 'wan2.2-t2i-flash', 'wanx2.1-t2i-plus'],
    gemini: ['gemini-nano-banana-2.1', 'gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image'],
    doubao: ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915', 'doubao-seedream-5-0-lite-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'],
    minimax: ['image-01'],
    xai: ['grok-imagine-image-2.0'],
    bfl: ['flux-2-pro', 'flux-2-max', 'flux-2-flex', 'flux-2-klein-4b', 'flux-2-klein-9b'],
    glm: ['glm-image', 'cogview-4-250304'],
  },
  video: {
    runninghub: [''],
    kling: ['kling-v2-6', 'kling-v2-5-turbo'],
    minimax: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02'],
    doubao: ['doubao-seedance-2-5-260628', 'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128'],
    xai: ['grok-imagine-video-1.5'],
  },
}
export function defaultModel(
  channel: ModelChannel,
  provider: ModelSelection['provider'],
): ModelSelection {
  return { provider, model: modelPresets[channel][provider]?.[0] || '',
    region: ['xai', 'mistral', 'bfl'].includes(provider) ? 'global' : 'cn' }
}
export function credentialId(channel: ModelChannel, selection: ModelSelection) {
  return `${channel}:${selection.provider}:${selection.region}`
}
export function validateModel(channel: ModelChannel, selection: ModelSelection) {
  if (!(modelProviders[channel] as readonly string[]).includes(selection.provider))
    throw new Error('此服务不支持所选生成类型')
  if (!['chatgpt', 'runninghub'].includes(selection.provider) && !selection.model)
    throw new Error('请填写模型 ID')
  // Video/image protocols differ by model family; custom IDs must use the implemented protocol.
  if (channel === 'video' && !modelPresets.video[selection.provider]?.includes(selection.model))
    throw new Error('请从支持的视频模型中选择')
  if (
    channel === 'image' &&
    ['qwen', 'bfl', 'glm'].includes(selection.provider) &&
    !modelPresets.image[selection.provider]?.includes(selection.model)
  )
    throw new Error('请从已适配的图片模型中选择')
}
export const defaultModels = {
  text: defaultModel('text', 'chatgpt'),
  image: defaultModel('image', 'chatgpt'),
  video: defaultModel('video', 'runninghub'),
}
export const modelsSchema = z
  .object({ text: modelSelectionSchema, image: modelSelectionSchema, video: modelSelectionSchema })
  .superRefine((models, ctx) => {
    for (const channel of modelChannelSchema.options) {
      try {
        validateModel(channel, models[channel])
      } catch (e) {
        ctx.addIssue({ code: 'custom', path: [channel], message: (e as Error).message })
      }
    }
  })
