import { z } from 'zod'
import { type Project, type ScriptChatTurn, type Shot } from './schema'

function jsonObject(raw: string) {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const start = trimmed.indexOf('{'),
    end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('未找到 JSON 对象，请复制完整的 ChatGPT 结果。')
  return JSON.parse(trimmed.slice(start, end + 1))
}

const shotInput = z.object({
  title: z.string().max(200),
  action: z.string().default(''),
  dialogue: z.string().default(''),
  scene: z.string().default(''),
  duration: z.number().min(1).max(120).default(5),
  size: z.string().default('中景'),
  camera: z.string().default('固定'),
  lighting: z.string().default('自然光'),
  imagePrompt: z.string().default(''),
  videoPrompt: z.string().default(''),
  characters: z.array(z.string()).default([]),
})
export const importSchema = z
  .object({
    script: z.string().optional(),
    episodeTitle: z.string().max(200).optional(),
    shots: z.array(shotInput).max(200).optional(),
    assets: z
      .array(
        z.object({
          kind: z.enum(['character', 'location', 'prop']),
          name: z.string().min(1).max(200),
          description: z.string().default(''),
          prompt: z.string().default(''),
        }),
      )
      .max(200)
      .optional(),
  })
  .refine(
    (v) => v.script !== undefined || !!v.shots?.length || !!v.assets?.length,
    '请提供 script、shots 或 assets',
  )
export function parseDirector(raw: string) {
  return importSchema.parse(jsonObject(raw))
}
const scriptChatReplySchema = z
  .object({
    reply: z.string().max(10000).default(''),
    script: z.string().max(200000).optional(),
  })
  .refine((v) => !!v.reply.trim() || !!v.script?.trim(), '请提供回复或剧本')

export function parseScriptChatReply(raw: string) {
  return scriptChatReplySchema.parse(jsonObject(raw))
}

export function buildScriptChatPrompt(
  p: Project,
  episodeId: string,
  request: string,
  script: string,
  style: string,
) {
  const ep = p.episodes.find((e) => e.id === episodeId)
  if (!ep) throw new Error('集不存在')
  const source = (script || p.source).slice(0, 30000)
  const history = ep.scriptChat
    .slice(-6)
    .map(
      (turn: ScriptChatTurn) =>
        `${turn.role === 'user' ? '用户' : '编剧助手'}：${turn.text.slice(0, 2500)}`,
    )
    .join('\n')
  return `你是影视编剧，与我逐轮讨论并打磨当前集剧本。回答本轮问题；需要创作或修改时，在 script 字段给出可直接使用的完整当前集剧本，不要只给局部片段。未要求修改剧本时将 script 设为空字符串。保留已确认的人物和情节，不要声称已经调用外部生成工具。回复语言跟随用户要求，除非用户另有指定。\n\n项目：${p.title}\n当前集：${ep.title}\n画幅：${p.aspect}\n视觉风格：${style}\n当前剧本/原始故事：\n${source}${(script || p.source).length > 30000 ? '\n（内容较长，以上仅包含前 30000 字。）' : ''}\n\n最近对话：\n${history || '（暂无）'}\n\n本轮用户要求：${request}\n\n仅返回有效 JSON，不要使用 Markdown 代码块：{"reply":"给用户的简洁回复","script":"若创作或修改了剧本，填写完整当前集剧本；否则填写空字符串"}`
}
export function buildPrompt(
  p: Project,
  episodeId: string,
  kind: 'script' | 'assets' | 'storyboard' | 'image',
  shot?: Shot,
  assetId?: string,
) {
  const ep = p.episodes.find((e) => e.id === episodeId)
  const context = `项目：${p.title}\n画幅：${p.aspect}\n视觉风格：${p.style}\n故事：${ep?.script || p.source}\n已确认资产：${p.assets.map((a) => `${a.kind} ${a.name}: ${a.description}`).join('\n')}`
  if (kind === 'image') {
    const a = p.assets.find((a) => a.id === assetId)
    return `${context}\n\n请直接生成一张${a ? '资产参考图' : '电影分镜图'}，无水印、无文字，保留角色和场景连续性。${a ? `${a.name}：${a.prompt || a.description}` : `${shot?.title}\n${shot?.imagePrompt || shot?.action}\n${shot?.size}；${shot?.camera}；${shot?.lighting}`}。参考图由我在本对话中附加。`
  }
  const task = {
    script: '改编为可拍摄的短剧剧本，明确冲突、动作、对白和分集。',
    assets:
      '提取并去重角色(character)、场景(location)、道具(prop)，给出可复用视觉描述及英文图片提示词。',
    storyboard:
      '把当前集拆成可编辑分镜，每镜 3–10 秒；保持角色、场景和动作连续性，生成英文生图与视频提示词。',
  }[kind]
  return `${context}\n\n你是影视导演。${task}\n仅输出有效 JSON（不要解释）：\n{"episodeTitle":"集标题","script":"完整剧本","assets":[{"kind":"character","name":"角色名","description":"外观与服装","prompt":"英文参考图提示词"}],"shots":[{"title":"镜头标题","scene":"场景","action":"画面动作","dialogue":"对白/旁白","duration":5,"size":"中景","camera":"缓慢推近","lighting":"柔和侧光","imagePrompt":"英文提示词","videoPrompt":"英文视频提示词","characters":["角色名"]}]}\n只返回本任务相关字段；不要捏造已有素材和生成结果。`
}
export function subtitleTime(seconds: number) {
  const ms = Math.round(seconds * 1000)
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}
export function toSrt(shots: Shot[]) {
  let time = 0,
    index = 0
  return shots
    .map((s) => {
      const start = time
      time += s.duration
      if (!s.dialogue.trim()) return ''
      return `${++index}\n${subtitleTime(start)} --> ${subtitleTime(time)}\n${s.dialogue.replace(/\r/g, '')}\n`
    })
    .filter(Boolean)
    .join('\n')
}
export function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}
