import { z } from 'zod'
import { commandSchema, id } from './schema'

export const pluginVersion = '0.2.2'
export const studioUri = 'ui://muweave/studio'
const editTypes = new Set(['create', 'project', 'episode', 'deleteEpisode', 'scriptChat', 'shot',
  'deleteShot', 'reorder', 'asset', 'deleteAsset', 'group', 'deleteGroup', 'parse', 'restore',
  'renameProject', 'deleteProject', 'selectMedia', 'layout'])
const generationTypes = new Set(['generateText', 'generateImage', 'scriptChatGenerate', 'queue', 'job', 'pause', 'cancelExport'])
const importTypes = new Set(['importMedia', 'uploadAssetImage', 'importArchive', 'importSource', 'scriptChatPickFiles'])
const exportTypes = new Set(['exportEpisode', 'exportArchive', 'previewEpisode'])
const commands = (types: Set<string>) => z.union(commandSchema.options.filter((schema) => types.has(schema.shape.type.value)))

export const pluginInputs = {
  'studio-info': z.object({}).strict(),
  read: z.object({ projectId: id.optional(), history: z.boolean().optional() }).strict(),
  edit: z.object({ command: commands(editTypes) }).strict(),
  generate: z.object({ command: commands(generationTypes), confirmed: z.literal(true).optional() }).strict(),
  import: z.object({ command: commands(importTypes), paths: z.array(z.string().min(1).max(1000)).min(1).max(10) }).strict(),
  export: z.object({ command: commands(exportTypes) }).strict(),
}
export type PluginAction = keyof typeof pluginInputs
const descriptions: Record<PluginAction, string> = {
  'studio-info': '打开幕织 Studio：剧本、人物与场景资产、分镜、连续视频和成片预览。返回本机页面地址；不提交生成任务。',
  read: '读取幕织项目与任务。省略 projectId 时返回项目摘要；指定后返回该项目的完整剧本、资产与分镜。history 查询历史版本。',
  edit: '保存幕织项目、分集剧本、资产和分镜。更新剧本会归档旧剧本与镜头。删除和恢复必须符合用户明确要求。',
  generate: '运行用户要求的文字、图片或 RunningHub 视频生成，或者管理队列。generateImage 在软件内生成图片并自动入库、选中为资产参考图或镜头首尾帧；prompt 可省略以使用已有资产设定，无需用户复制或导入。提交视频及重试必须 confirmed:true，代表用户已明确授权付费生成。未知提交结果不能自动重试。',
  import: '把当前宿主工作区内用户选择的文件导入幕织。paths 必须是工作区相对路径，不能越界。',
  export: '导出项目 ZIP、分镜 HTML、SRT 或整集 MP4，或生成整集连续预览。文件保存在项目 exports 目录。',
}
export const pluginTools = Object.entries(pluginInputs).map(([action, schema]) => ({
  name: `muweave_${action.replaceAll('-', '_')}`,
  title: action === 'studio-info' ? 'Muweave Studio' : `幕织 · ${action}`,
  description: descriptions[action as PluginAction],
  inputSchema: z.toJSONSchema(schema, { io: 'input' }),
  annotations: {
    readOnlyHint: action === 'read' || action === 'studio-info',
    destructiveHint: action === 'edit',
    openWorldHint: action === 'generate',
    idempotentHint: action === 'read' || action === 'studio-info',
  },
  ...(action === 'studio-info' ? { _meta: { ui: { resourceUri: studioUri } } } : {}),
}))

export const pluginCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
})
