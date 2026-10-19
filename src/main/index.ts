import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  shell,
} from 'electron'
import { join, extname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import mammoth from 'mammoth'
import { ZodError } from 'zod'
import {
  commandSchema,
  aiRequestSchema,
  configSchema,
  videoWorkflow,
  id,
  shotSchema,
  type Reply,
  type Snapshot,
  type ChatAttachment,
  type AiRequest,
  type AiTask,
} from '../shared/schema'
import {
  buildPrompt,
  buildScriptChatPrompt,
  getScriptPolishSource,
  parseDirector,
  parseScriptChatReply,
  storyboardResponseJsonSchema,
  storyboardImport,
} from '../shared/director'
import { Store, createProject, replaceEpisodeScript } from './store'
import { ChatGPT } from './chatgpt'
import { CodexText } from './codex'
import { ModelAPI, imageExtension, type ModelCredential } from './models'
import { credentialId, modelChannelSchema, modelProviders, validateModel, type ModelChannel, type ModelSelection } from '../shared/models'
import { prepareChatFile } from './chat-files'
import { Queue, RunningHub, assertCoinOnlyWorkflow, inputsChanged, relevantAssets } from './runninghub'
import { activate, importMedia, exportArchive, restoreArchive, Exporter, episodeRenderVersion } from './media'
import { startPluginServer, type CommandFiles } from './plugin'
import { applyShotBatch } from '../shared/shots'
import { validatePrevis } from '../shared/previs'
import { PrevisExporter } from './previs'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])
const here = fileURLToPath(new URL('.', import.meta.url))
let window: BrowserWindow | null = null,
  store: Store,
  queue: Queue,
  chatgpt: ChatGPT,
  codex: CodexText,
  models: ModelAPI
let previsExporter: PrevisExporter
const exporter = new Exporter(app.isPackaged ? process.resourcesPath : undefined)
const pendingChatFiles = new Map<
  string,
  { projectId: string; path: string; name: string; size: number }
>()
const commandFiles = new AsyncLocalStorage<CommandFiles>()
const pluginMode = process.argv.includes('--plugin-server')
let studioServer: Awaited<ReturnType<typeof startPluginServer>> | undefined
if (process.env.DIRECTOR_DATA_DIR) app.setPath('userData', process.env.DIRECTOR_DATA_DIR)
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()
app.on('second-instance', (_event, args) => {
  if (args.includes('--plugin-server')) return
  if (!window) createWindow()
  window?.show()
  window?.focus()
})
function changed() {
  window?.webContents.send('director:changed')
  studioServer?.changed()
}
function key() {
  const value = store.get<string>('runninghub-key', '')
  if (!value) return ''
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return ''
  }
}
function modelCredential(channel: ModelChannel, selection: ModelSelection): ModelCredential {
  if (selection.provider === 'runninghub') return { key: key() }
  const value = store.get<string>(`model-key:${credentialId(channel, selection)}`, '')
  if (!value) return { key: '' }
  try { return JSON.parse(safeStorage.decryptString(Buffer.from(value, 'base64'))) as ModelCredential }
  catch { return { key: '' } }
}
function credentialStatus() {
  const result: Record<string, boolean> = {}
  for (const channel of modelChannelSchema.options)
    for (const provider of modelProviders[channel])
      for (const region of ['cn', 'global'] as const) {
        const selection = { provider, model: '', region }
        result[credentialId(channel, selection)] = !!modelCredential(channel, selection).key
      }
  return result
}
function snapshot(): Snapshot {
  return {
    projects: store.projects(),
    jobs: store.jobs(),
    aiTasks: store.aiTasks(),
    config: store.config(),
    hasKey: !!key(),
    chatgptOpen: !!chatgpt.window,
    dataPath: store.root,
    exporting: exporter.busy,
    credentials: credentialStatus(),
    modelServicesReady: true,
    videoResolutionReady: true,
    dialogueRulesReady: true,
  }
}
async function chooseSave(defaultPath: string, extensions: string[]) {
  const context = commandFiles.getStore()
  if (context) {
    const directory = context.projectId ? store.file(context.projectId, 'exports') : join(store.root, 'studio-exports')
    await mkdir(directory, { recursive: true })
    context.output = join(directory, `${randomUUID()}-${basename(defaultPath).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`)
    return context.output
  }
  return (
    await dialog.showSaveDialog(window!, {
      defaultPath,
      filters: [{ name: extensions.join('/').toUpperCase(), extensions }],
    })
  ).filePath
}
async function chooseFile(extensions: string[]) {
  const context = commandFiles.getStore()
  if (context) return context.files[0]
  return (
    await dialog.showOpenDialog(window!, {
      properties: ['openFile'],
      filters: [
        { name: store.config().locale === 'en' ? 'Supported files' : '支持的文件', extensions },
      ],
    })
  ).filePaths[0]
}
function createWindow() {
  window = new BrowserWindow({
    width: 1540,
    height: 990,
    minWidth: 1120,
    minHeight: 730,
    backgroundColor: '#f9f9f7',
    title: 'Muweave 幕织',
    icon: app.isPackaged
      ? join(process.resourcesPath, 'muweave-mark.png')
      : join(app.getAppPath(), 'src/renderer/assets/muweave-mark.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(here, '../renderer/index.html'))
  window.on('closed', () => {
    window = null
  })
}
if (primary)
  void app.whenReady().then(async () => {
    store = new Store(join(app.getPath('userData'), 'library'))
    // The task center no longer supports a global pause. Clear the legacy saved flag.
    if (store.config().paused) store.set('config', { ...store.config(), paused: false })
    chatgpt = new ChatGPT(store, changed)
    codex = new CodexText(store)
    models = new ModelAPI(modelCredential)
    previsExporter = new PrevisExporter(store, app.isPackaged ? process.resourcesPath : undefined)
    const api = new RunningHub(key)
    queue = new Queue(store, api, changed, app.isPackaged ? process.resourcesPath : undefined, models)
    const mediaFile = (url: URL) => {
        const [pid, mid, revision] = url.pathname.split('/').filter(Boolean)
        id.parse(pid)
        id.parse(mid)
        const p = store.project(pid)
        if (url.hostname === 'preview') {
          if (!revision || !/^[a-f0-9]{16}$/.test(revision) ||
              !p.episodes.some((episode) => episode.id === mid)) throw new Error('invalid')
          return store.file(pid, `exports/preview-${mid}-${revision}.mp4`)
        }
        if (url.hostname !== 'asset' || revision) throw new Error('invalid')
        const m = p.media.find((m) => m.id === mid)
        if (!m) throw new Error('missing')
        return store.file(pid, m.file)
    }
    const media = async (request: Request) => {
      try {
        return net.fetch(pathToFileURL(mediaFile(new URL(request.url))).href, { headers: request.headers })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    }
    protocol.handle('media', media)
    const enqueueAI = async (request: AiRequest) => {
      const project = store.project(request.projectId)
      const episode = 'episodeId' in request ? project.episodes.find((episode) => episode.id === request.episodeId) : undefined
      if ('episodeId' in request && !episode) throw new Error('集不存在')
      const owner = request.type === 'generateImage'
        ? request.slot === 'reference' ? project.assets.find((asset) => asset.id === request.ownerId)
          : project.shots.find((shot) => shot.id === request.ownerId) : undefined
      if (request.type === 'generateImage' && !owner) throw new Error('图片所属镜头或资产已不存在')
      const attachments: ChatAttachment[] = []
      if (request.type === 'scriptChatGenerate') {
        if (!request.request.trim() && !request.attachmentIds.length) throw new Error('请输入创作要求或添加附件')
        for (const id of request.attachmentIds) {
          const file = pendingChatFiles.get(id)
          if (!file || file.projectId !== project.id) throw new Error('附件已失效，请重新选择文件')
          if ((await stat(file.path)).size > 50 * 1024 * 1024) throw new Error('附件已超过 50 MB，请重新选择')
          const saved = `chat/${id}`
          await mkdir(store.file(project.id, 'chat'), { recursive: true })
          await copyFile(file.path, store.file(project.id, saved))
          attachments.push({ id, name: file.name, size: file.size, file: saved })
        }
      }
      const label = request.type === 'generateImage' ? 'AI 生图' : request.type === 'generateStoryboard' ? 'AI 分镜' :
        request.type === 'scriptChatGenerate' ? request.polishTurnId ? 'AI 润色' : 'AI 编剧' : 'AI 文字'
      const target = owner ? 'name' in owner ? owner.name : owner.title : episode?.title
      return queue.enqueueAI(request, `${label} · ${target || project.title}`, attachments)
    }
    const command = async (raw: unknown, executing?: AiTask, signal?: AbortSignal): Promise<Reply> => {
      try {
        const c = commandSchema.parse(raw)
        if (!executing) {
          const request = aiRequestSchema.safeParse(c)
          if (request.success) {
            const task = await queue.waitAI(await enqueueAI(request.data))
            return task.status === 'succeeded' ? { ok: true, state: snapshot(), text: task.resultText, message: task.message }
              : { ok: false, error: task.error || 'AI 任务已取消' }
          }
        }
        let message: string | undefined, text: string | undefined
        const selection = (channel: ModelChannel) => executing?.model || store.config().models[channel]
        const generate = (prompt: string, schema?: Record<string, unknown>, options?: { workingDirectory?: string; images?: string[] }) =>
          selection('text').provider === 'chatgpt' ? codex.generate(prompt, schema, { ...options, signal }) :
            models.text(selection('text'), prompt, schema, options?.images, signal)
        switch (c.type) {
          case 'aiEnqueue':
            text = await enqueueAI(c.request)
            message = 'AI 任务已加入队列，可关闭窗口继续处理。'
            break
          case 'aiTask':
            await queue.aiAction(c.taskId, c.action)
            break
          case 'terminateTasks':
            message = `已停止 ${queue.terminateAll()} 个本地任务；新任务可正常提交，远端状态请查看各任务记录。`
            break
          case 'deleteTask':
            queue.deleteTask(c.taskId)
            message = '任务记录已删除，已生成素材仍保留'
            break
          case 'batchShots':
            store.update(c.projectId, (p) => applyShotBatch(p, c.episodeId, c.shotIds, c.patch, c.assetMode))
            message = `已批量更新 ${new Set(c.shotIds).size} 个镜头`
            break
          case 'snapshot':
            break
          case 'create':
            store.save(createProject(c.title, c.aspect, c.demo, store.config().locale))
            break
          case 'project':
            store.update(c.projectId, (p) => Object.assign(p, c.patch))
            break
          case 'renameProject':
            store.update(c.projectId, (p) => {
              p.title = c.title
            })
            break
          case 'episode':
            store.update(c.projectId, (p) => {
              const ep = c.episodeId ? p.episodes.find((e) => e.id === c.episodeId) : undefined
              if (c.episodeId && !ep) throw new Error('集不存在')
              if (ep) {
                const updated = replaceEpisodeScript(p, ep.id, c.script, store.jobs())
                ep.title = c.title
                if (updated) message = '旧剧本与镜头视频已存档；导演台已切换到新剧本，请生成新版分镜'
              }
              else
                p.episodes.push({
                  id: randomUUID(),
                  title: c.title,
                  script: c.script,
                  scriptChat: [],
                })
            })
            break
          case 'deleteEpisode': {
            const project = store.project(c.projectId)
            if (!project.episodes.some((ep) => ep.id === c.episodeId)) throw new Error('集不存在')
            if (project.episodes.length === 1) throw new Error('项目至少需要保留一集')
            const shotIds = new Set(
              project.shots.filter((shot) => shot.episodeId === c.episodeId).map((shot) => shot.id),
            )
            if (
              store
                .jobs()
                .some(
                  (job) =>
                    job.projectId === c.projectId &&
                    job.shotId &&
                    shotIds.has(job.shotId) &&
                    [
                      'queued',
                      'running',
                      'submitting',
                      'downloading',
                      'paused',
                      'uncertain',
                    ].includes(job.status),
                )
            )
              throw new Error('请先处理此集镜头的未完成任务')
            store.update(c.projectId, (p) => {
              p.episodes = p.episodes.filter((ep) => ep.id !== c.episodeId)
              p.shots = p.shots.filter((shot) => shot.episodeId !== c.episodeId)
              for (const group of p.groups)
                group.shotIds = group.shotIds.filter((id) => !shotIds.has(id))
              for (const id of shotIds) delete p.layout[id]
            })
            message = '已移除分集，素材文件和历史版本仍保留'
            break
          }
          case 'scriptChat':
            store.update(c.projectId, (p) => {
              const ep = p.episodes.find((e) => e.id === c.episodeId)
              if (!ep) throw new Error('集不存在')
              ep.scriptChat = [...ep.scriptChat, c.turn]
            })
            break
          case 'scriptChatPolishDecision':
            store.update(c.projectId, (p) => {
              getScriptPolishSource(p, c.episodeId, c.turnId)
              const turn = p.episodes.find((episode) => episode.id === c.episodeId)!
                .scriptChat.find((item) => item.id === c.turnId)!
              turn.polishSkipped = c.skipped
            })
            break
          case 'scriptChatPickFiles': {
            store.project(c.projectId)
            const context = commandFiles.getStore()
            const selection = context ? { canceled: false, filePaths: context.files } :
              await dialog.showOpenDialog(window!, { properties: ['openFile', 'multiSelections'] })
            if (selection.canceled) break
            if (selection.filePaths.length > c.max) throw new Error('每轮最多添加 10 个附件')
            const picked = []
            for (const [index, path] of selection.filePaths.entries()) {
              const file = await stat(path)
              if (!file.isFile()) throw new Error('只能上传文件')
              if (file.size > 50 * 1024 * 1024) throw new Error('单个附件不能超过 50 MB')
              const attachment = {
                id: randomUUID(),
                name: (context?.names?.[index] || basename(path)).slice(0, 255),
                size: file.size,
              }
              pendingChatFiles.set(attachment.id, { ...attachment, projectId: c.projectId, path })
              picked.push(attachment)
            }
            text = JSON.stringify(picked)
            break
          }
          case 'scriptChatGenerate': {
            if (!c.request.trim() && !c.attachmentIds.length)
              throw new Error('请输入创作要求或添加附件')
            const p = store.project(c.projectId)
            const ep = p.episodes.find((e) => e.id === c.episodeId)
            if (!ep) throw new Error('集不存在')
            const currentSource = c.polishTurnId ? getScriptPolishSource(p, c.episodeId, c.polishTurnId) : undefined
            const polishSource = currentSource ? executing?.polishSource || currentSource : undefined
            if (polishSource && polishSource.turnId !== c.polishTurnId) throw new Error('润色任务与候选剧本不匹配')
            const files = c.attachmentIds.map((attachmentId) => {
              const saved = executing?.attachments.find((file) => file.id === attachmentId)
              if (saved) return { ...saved, projectId: c.projectId, path: store.file(c.projectId, saved.file) }
              const file = pendingChatFiles.get(attachmentId)
              if (!file || file.projectId !== c.projectId)
                throw new Error('附件已失效，请重新选择文件')
              return { ...file, id: attachmentId }
            })
            const base = join(store.root, 'codex-text-workspace')
            let workdir: string | undefined
            try {
              if (files.length) {
                await mkdir(base, { recursive: true })
                workdir = await mkdtemp(join(base, 'chat-'))
              }
              const staged = []
              for (const file of files) {
                if ((await stat(file.path)).size > 50 * 1024 * 1024)
                  throw new Error('附件已超过 50 MB，请重新选择')
                const target = join(workdir!, `${file.id}-${file.name.slice(-150)}`)
                await copyFile(file.path, target)
                staged.push({ ...file, stagedPath: target })
              }
              const prompt = buildScriptChatPrompt(
                p,
                c.episodeId,
                c.request.trim(),
                ep.script,
                p.style,
                await Promise.all(
                  staged.map((file) => prepareChatFile(file.stagedPath, file.name, file.size)),
                ),
                polishSource,
              )
              const rawReply = await generate(
                prompt,
                {
                  type: 'object',
                  properties: {
                    reply: { type: 'string' },
                    analysis: { type: 'string' },
                    script: { type: 'string' },
                    polishDirections: { type: 'array', maxItems: 2, items: {
                      type: 'object', properties: {
                        title: { type: 'string', minLength: 1, maxLength: 40 },
                        instruction: { type: 'string', minLength: 1, maxLength: 300 },
                      }, required: ['title', 'instruction'], additionalProperties: false,
                    } },
                  },
                  required: ['reply', 'analysis', 'script', 'polishDirections'],
                  additionalProperties: false,
                },
                {
                  workingDirectory: workdir,
                  images: staged
                    .filter((file) => /\.(png|jpe?g|webp)$/i.test(file.name))
                    .map((file) => file.stagedPath),
                },
              )
              const reply = parseScriptChatReply(rawReply)
              if (polishSource && !reply.script?.trim()) throw new Error('AI 未返回润色后的剧本，请手动重试')
              const attachments: ChatAttachment[] = []
              if (staged.length) await mkdir(store.file(c.projectId, 'chat'), { recursive: true })
              for (const file of staged) {
                const saved = `chat/${file.id}`
                await copyFile(file.stagedPath, store.file(c.projectId, saved))
                attachments.push({ id: file.id, name: file.name, size: file.size, file: saved })
              }
              const now = new Date().toISOString()
              signal?.throwIfAborted()
              store.update(c.projectId, (current) => {
                const target = current.episodes.find((e) => e.id === c.episodeId)
                if (!target) throw new Error('集不存在')
                target.scriptChat = [
                  ...target.scriptChat,
                  {
                    id: randomUUID(),
                    role: 'user' as const,
                    text: polishSource ? `润色方向：${c.request.trim()}` : c.request.trim() || '请分析附件',
                    attachments,
                    createdAt: now,
                  },
                  {
                    id: randomUUID(),
                    role: 'assistant' as const,
                    text: reply.reply.trim() || '已生成剧本草稿',
                    analysis: reply.analysis?.trim() || undefined,
                    script: reply.script?.trim() ? reply.script : undefined,
                    ...(reply.script?.trim() && reply.polishDirections?.length === 2
                      ? { polishDirections: reply.polishDirections } : {}),
                    ...(polishSource ? { polishSourceTurnId: polishSource.turnId } : {}),
                    createdAt: now,
                  },
                ]
              })
              for (const file of files) pendingChatFiles.delete(file.id)
            } finally {
              if (workdir) await rm(workdir, { recursive: true, force: true })
            }
            break
          }
          case 'codexStatus':
            text = (await codex.connected()) ? 'connected' : 'disconnected'
            break
          case 'modelStatus': {
            const selected = store.config().models[c.channel]
            text = (selected.provider === 'chatgpt' ? await codex.connected() :
              !!modelCredential(c.channel, selected).key) ? 'connected' : 'disconnected'
            break
          }
          case 'codexLogin':
            await codex.login()
            message = 'ChatGPT 账号已连接，可在软件中生成文字和图片。'
            break
          case 'generateText': {
            const p = store.project(c.projectId)
            if (!p.episodes.some((e) => e.id === c.episodeId)) throw new Error('集不存在')
            text = await generate(
              c.prompt || buildPrompt(p, c.episodeId, c.kind),
              c.kind === 'storyboard' ? storyboardResponseJsonSchema : undefined,
            )
            break
          }
          case 'generateStoryboard': {
            const project = store.project(c.projectId)
            const episode = project.episodes.find((episode) => episode.id === c.episodeId)
            if (!episode) throw new Error('集不存在')
            const source = episode.script
            const prompt = buildPrompt(project, c.episodeId, 'storyboard')
            const result = await generate(c.request.trim() ? `${prompt}\n\n用户补充要求：${c.request.trim()}` : prompt,
              storyboardResponseJsonSchema)
            signal?.throwIfAborted()
            if (result.length > 200000) throw new Error('AI 结果超过保存上限，请拆分任务后重试')
            if (executing) {
              executing.resultText = result
              store.saveJob(executing)
            }
            if (store.project(c.projectId).episodes.find((episode) => episode.id === c.episodeId)?.script !== source)
              throw new Error('生成期间剧本已变更，分镜结果已保留在任务中心，请核对后导入。')
            const imported = await command({ type: 'parse', projectId: c.projectId, episodeId: c.episodeId,
              raw: storyboardImport(result) }, executing)
            if (!imported.ok) throw new Error(imported.error)
            text = result
            message = '分镜已追加到当前集'
            break
          }
          case 'generateImage': {
            const p = store.project(c.projectId)
            const asset = c.slot === 'reference' ? p.assets.find((a) => a.id === c.ownerId) : undefined
            const shot = c.slot !== 'reference' ? p.shots.find((s) => s.id === c.ownerId) : undefined
            if (!asset && !shot)
              throw new Error('图片所属镜头或资产已不存在')
            const prompt = c.prompt || buildPrompt(p, shot?.episodeId || p.episodes[0]?.id, 'image', shot, asset?.id)
            const existing = executing && p.media.find((media) => media.taskId === `ai:${executing.id}`)
            if (existing) { text = `media://asset/${p.id}/${existing.id}`; break }
            const selected = selection('image')
            const bytes = selected.provider === 'chatgpt' ? await codex.image(prompt, p.aspect, signal) :
              await models.image(selected, prompt, p.aspect, executing?.remoteTaskId, (taskId, queryUrl) => {
                if (executing) { executing.remoteTaskId = taskId; executing.remoteQueryUrl = queryUrl; store.saveJob(executing); changed() }
              }, executing?.remoteQueryUrl, signal)
            signal?.throwIfAborted()
            const file = store.file(p.id, `downloads/ai-${randomUUID()}.${imageExtension(bytes)}`)
            await mkdir(store.file(p.id, 'downloads'), { recursive: true })
            await writeFile(file, bytes)
            try {
              const media = await importMedia(store, p.id, c.ownerId, c.slot, file, prompt,
                executing ? `ai:${executing.id}` : undefined, undefined, signal)
              text = `media://asset/${p.id}/${media.id}`
            } finally {
              await rm(file, { force: true })
            }
            message = '图片已生成并保存到当前项目素材。'
            break
          }
          case 'shot':
            store.update(c.projectId, (p) => {
              if (!p.episodes.some((e) => e.id === c.shot.episodeId)) throw new Error('集不存在')
              const index = p.shots.findIndex((s) => s.id === c.shot.id)
              if (index < 0) p.shots.push(c.shot)
              else {
                const old = p.shots[index]
                const next = {
                  ...c.shot,
                  firstMediaId: old.firstMediaId,
                  lastMediaId: old.lastMediaId,
                  videoMediaId: old.videoMediaId,
                  audioMediaId: old.audioMediaId,
                  previs: old.previs,
                  previsMediaId: old.previsMediaId,
                }
                next.stale = old.stale || (!!old.videoMediaId && inputsChanged(next, old))
                p.shots[index] = next
              }
            })
            break
          case 'savePrevis':
            store.update(c.projectId, (p) => {
              const shot = p.shots.find((shot) => shot.id === c.shotId)
              if (!shot) throw new Error('镜头不存在')
              validatePrevis(p, c.scene, c.plan)
              p.previsScenes ||= []
              const previous = p.previsScenes.find((scene) => scene.id === c.scene.id)
              if (previous && previous.revision !== c.scene.revision) throw new Error('片场已在其他窗口修改，请重新打开预演')
              if (shot.previs && shot.previs.revision !== c.plan.revision) throw new Error('镜头预演已在其他窗口修改，请重新打开预演')
              const sceneChanged = !previous || JSON.stringify(previous) !== JSON.stringify(c.scene)
              const sourceVersions = p.media.flatMap((media) => media.previsSource?.sceneId === c.scene.id ? [media.previsSource.sceneRevision] : [])
              const scene = { ...c.scene, revision: sceneChanged ? Math.max(previous?.revision || 0, ...sourceVersions) + 1 : previous!.revision }
              if (previous) p.previsScenes[p.previsScenes.indexOf(previous)] = scene
              else p.previsScenes.push(scene)
              const planChanged = !shot.previs || JSON.stringify(shot.previs) !== JSON.stringify(c.plan)
              const planVersions = p.media.flatMap((media) => media.ownerId === shot.id && media.previsSource ? [media.previsSource.planRevision] : [])
              shot.previs = { ...c.plan, revision: planChanged || sceneChanged ? Math.max(shot.previs?.revision || 0, ...planVersions) + 1 : shot.previs!.revision }
              for (const linked of p.shots) {
                if (linked.usePrevis && linked.previs?.sceneId === scene.id && (sceneChanged || (linked.id === shot.id && planChanged))) linked.stale ||= !!linked.videoMediaId
              }
            })
            message = '预演已保存到本机'
            break
          case 'previsOutput':
            if (c.action === 'start') text = await previsExporter.start(c.projectId, c.shotId, c.format || 'video')
            else if (c.action === 'cancel') {
              if (!c.sessionId) throw new Error('缺少导出会话')
              await previsExporter.cancel(c.sessionId)
            } else {
              const media = await previsExporter.finish(c.projectId, c.shotId, c.sessionId)
              text = media.id
              message = c.format === 'image' ? '构图图已保存到镜头素材' : '白模预演视频已保存到镜头素材'
            }
            break
          case 'deleteShot':
            if (
              store
                .jobs()
                .some(
                  (j) =>
                    j.projectId === c.projectId &&
                    j.shotId === c.shotId &&
                    [
                      'queued',
                      'running',
                      'submitting',
                      'downloading',
                      'paused',
                      'uncertain',
                    ].includes(j.status),
                )
            )
              throw new Error('请先处理镜头的未完成任务')
            store.update(c.projectId, (p) => {
              p.shots = p.shots.filter((s) => s.id !== c.shotId)
              for (const g of p.groups) g.shotIds = g.shotIds.filter((id) => id !== c.shotId)
            })
            break
          case 'reorder':
            store.update(c.projectId, (p) => {
              const s = p.shots.find((s) => s.id === c.shotId)
              if (!s) throw new Error('镜头不存在')
              const list = p.shots.filter((a) => a.episodeId === s.episodeId),
                n = list.indexOf(s),
                other = list[n + (c.delta === 'up' ? -1 : 1)]
              if (other) {
                const a = p.shots.indexOf(s),
                  b = p.shots.indexOf(other)
                ;[p.shots[a], p.shots[b]] = [p.shots[b], p.shots[a]]
              }
            })
            break
          case 'asset':
            store.update(c.projectId, (p) => {
              const index = p.assets.findIndex((a) => a.id === c.asset.id)
              if (index < 0) p.assets.push(c.asset)
              else {
                const previous = p.assets[index]
                p.assets[index] = { ...c.asset, selectedMediaId: p.assets[index].selectedMediaId }
                if (previous.name !== c.asset.name || previous.description !== c.asset.description ||
                    previous.prompt !== c.asset.prompt || previous.kind !== c.asset.kind)
                  for (const shot of p.shots)
                    if (relevantAssets(p, shot).some((asset) => asset.id === c.asset.id) ||
                        shot.assetIds.includes(c.asset.id))
                      shot.stale = !!shot.videoMediaId
              }
            })
            break
          case 'uploadAssetImage': {
            store.project(c.projectId)
            const file = await chooseFile(['png', 'jpg', 'jpeg', 'webp'])
            if (!file) break
            const asset = {
              id: randomUUID(),
              kind: c.kind,
              name: basename(file, extname(file)).slice(0, 200).trim() || '未命名资产',
              description: '',
              prompt: '',
            }
            await importMedia(store, c.projectId, asset.id, 'reference', file, '', undefined, asset)
            text = asset.id
            message = '资产图片已上传'
            break
          }
          case 'deleteAsset':
            store.update(c.projectId, (p) => {
              p.assets = p.assets.filter((a) => a.id !== c.assetId)
              for (const s of p.shots) s.assetIds = s.assetIds.filter((id) => id !== c.assetId)
            })
            break
          case 'layout':
            store.update(
              c.projectId,
              (p) => {
                p.layout = { ...p.layout, ...c.layout }
                if (c.viewport) p.viewport = c.viewport
              },
              false,
            )
            break
          case 'group':
            store.update(c.projectId, (p) => {
              if (!c.shotIds.every((id) => p.shots.some((s) => s.id === id)))
                throw new Error('分组包含未知镜头')
              p.groups.push({
                id: randomUUID(),
                title: c.title,
                shotIds: c.shotIds,
                stopOnFailure: c.stopOnFailure,
              })
            })
            break
          case 'deleteGroup':
            store.update(c.projectId, (p) => {
              p.groups = p.groups.filter((g) => g.id !== c.groupId)
            })
            break
          case 'importSource': {
            const file = await chooseFile(['txt', 'md', 'docx'])
            if (!file) break
            const raw =
              extname(file).toLowerCase() === '.docx'
                ? (await mammoth.extractRawText({ path: file })).value
                : await readFile(file, 'utf8')
            if (raw.length > 200000) throw new Error('请将文本拆分至 20 万字以内')
            let scriptUpdated = false
            store.update(c.projectId, (p) => {
              p.source = raw
              const e = p.episodes.find((e) => e.id === c.episodeId)
              if (!e) throw new Error('集不存在')
              scriptUpdated = replaceEpisodeScript(p, e.id, raw, store.jobs())
            })
            message = scriptUpdated ? '已导入新剧本；旧剧本与镜头视频已存档' : '已导入文本'
            break
          }
          case 'parse': {
            const result = parseDirector(c.raw)
            let scriptUpdated = false
            store.update(c.projectId, (p) => {
              const ep = p.episodes.find((e) => e.id === c.episodeId)
              if (!ep) throw new Error('集不存在')
              if (result.script !== undefined)
                scriptUpdated = replaceEpisodeScript(p, ep.id, result.script, store.jobs())
              if (result.episodeTitle) ep.title = result.episodeTitle
              for (const a of result.assets || []) {
                const existing = p.assets.find((o) => o.name === a.name && o.kind === a.kind)
                if (existing) Object.assign(existing, a)
                else p.assets.push({ id: randomUUID(), ...a })
              }
              for (const s of result.shots || [])
                p.shots.push(
                  shotSchema.parse({
                    ...s,
                    id: randomUUID(),
                    episodeId: ep.id,
                    assetIds: p.assets
                      .filter((a) => s.characters.includes(a.name) || a.name === s.scene)
                      .map((a) => a.id),
                  }),
                )
            })
            message =
              scriptUpdated
                ? `旧剧本与镜头视频已存档，已为新剧本添加 ${result.shots?.length || 0} 个镜头`
                : result.script === undefined && !result.assets?.length
                ? `已追加 ${result.shots?.length || 0} 个分镜到当前集`
                : `已更新剧本/资产，追加 ${result.shots?.length || 0} 个镜头；旧镜头未覆盖`
            break
          }
          case 'clipboard':
            text = clipboard.readText().slice(0, 200000)
            break
          case 'chatgpt':
            chatgpt.prepare(c.projectId, c.ownerId, c.kind, c.prompt, c.slot)
            message =
              '提示词已复制。在 ChatGPT 中粘贴并发送；文本结果复制回来导入，图片下载时可直接归档。'
            break
          case 'openChatGPT':
            chatgpt.open()
            break
          case 'clearChatGPT':
            await chatgpt.clear()
            message = '已清除本应用内的 ChatGPT 登录记录'
            break
          case 'importMedia': {
            const file = await chooseFile(
              c.slot === 'model' ? ['glb'] : ['video', 'previs'].includes(c.slot)
                ? ['mp4', 'webm', 'mov']
                : c.slot === 'audio'
                  ? ['mp3', 'wav', 'm4a', 'aac', 'ogg']
                  : ['png', 'jpg', 'jpeg', 'webp'],
            )
            if (file) await importMedia(store, c.projectId, c.ownerId, c.slot, file)
            break
          }
          case 'selectMedia':
            store.update(c.projectId, (p) => {
              const m = p.media.find((m) => m.id === c.mediaId)
              if (!m) throw new Error('素材不存在')
              activate(p, m)
            })
            break
          case 'config': {
            const config = configSchema.parse({
              ...c.config,
              site: videoWorkflow.site,
              workflowId: videoWorkflow.id,
              mappings: [],
              concurrency: 1,
            })
            if (c.key?.trim()) {
              if (!safeStorage.isEncryptionAvailable())
                throw new Error('操作系统凭据加密不可用，未保存 API Key')
              store.set(
                'runninghub-key',
                safeStorage.encryptString(c.key.trim()).toString('base64'),
              )
            }
            const encrypted = (c.credentials || []).map((item) => {
              validateModel(item.channel, item.selection)
              if (['chatgpt', 'runninghub'].includes(item.selection.provider)) throw new Error('请使用此服务的专用授权入口')
              if (!safeStorage.isEncryptionAvailable()) throw new Error('操作系统凭据加密不可用，未保存 API Key')
              return { id: credentialId(item.channel, item.selection), value: safeStorage.encryptString(
                JSON.stringify({ key: item.key, ...(item.secret ? { secret: item.secret } : {}) }),
              ).toString('base64') }
            })
            for (const credential of encrypted) store.set(`model-key:${credential.id}`, credential.value)
            store.set('config', config)
            message = '设置已保存，Key 不会进入项目存档'
            break
          }
          case 'clearKey':
            store.set('runninghub-key', '')
            break
          case 'clearModelKey':
            validateModel(c.channel, c.selection)
            store.set(`model-key:${credentialId(c.channel, c.selection)}`, '')
            break
          case 'testModelConnection': {
            const selected = store.config().models[c.channel]
            text = selected.provider === 'chatgpt' ? (await codex.connected() ? 'ChatGPT 账号已连接' : '需要连接 ChatGPT 账号') :
              await models.test(c.channel, selected)
            break
          }
          case 'testConnection':
            {
              const account = await api.coinAccount(videoWorkflow.site)
              assertCoinOnlyWorkflow(await api.workflow({ site: videoWorkflow.site, workflowId: videoWorkflow.id }))
              text = `RH币计费已确认；当前余额 ${account.remainCoins} RH币。导演台工作流未使用钱包计费节点。`
              message = 'RunningHub RH币连接成功'
            }
            break
          case 'workflow':
            text = JSON.stringify(await api.workflow({ site: videoWorkflow.site, workflowId: videoWorkflow.id }), null, 2)
            break
          case 'queue':
            {
              const selected = store.config().models.video
              if (!modelCredential('video', selected).key) throw new Error('请先保存视频服务的 Key')
              if (selected.provider === 'runninghub') {
                await api.coinAccount(videoWorkflow.site)
                assertCoinOnlyWorkflow(await api.workflow({ site: videoWorkflow.site, workflowId: videoWorkflow.id }))
              }
              const adjusted = queue.enqueue(c.projectId, c.shotIds, c.stopOnFailure)
              message = adjusted
                ? `已加入视频任务队列；${adjusted} 个镜头已自动延长到模型或对白所需时长`
                : '已加入视频任务队列'
            }
            break
          case 'job':
            await queue.action(c.jobId, c.action, c.taskId)
            break
          case 'pause':
            store.set('config', { ...store.config(), paused: c.paused })
            message = c.paused ? '已暂停新的提交；远端已开始的任务继续运行' : '已恢复本地队列'
            break
          case 'exportArchive': {
            const file = await chooseSave(`${store.project(c.projectId).title}.director.zip`, [
              'zip',
            ])
            if (file) {
              await exportArchive(store, c.projectId, file)
              message = '项目和素材已存档（不含账号/Key）'
            }
            break
          }
          case 'importArchive': {
            const file = await chooseFile(['zip'])
            if (file) {
              await restoreArchive(store, file)
              message = '已恢复为新项目；不会自动执行旧任务'
            }
            break
          }
          case 'exportEpisode': {
            const p = store.project(c.projectId),
              file = await chooseSave(`${p.title}.${c.format}`, [c.format])
            if (file) {
              const work = exporter.episode(store, c.projectId, c.episodeId, c.format, file)
              changed()
              try {
                await work
                message = '导出完成'
              } finally {
                changed()
              }
            }
            break
          }
          case 'previewEpisode': {
            const p = store.project(c.projectId)
            if (!p.episodes.some((episode) => episode.id === c.episodeId)) throw new Error('集不存在')
            const shots = p.shots.filter((shot) => shot.episodeId === c.episodeId)
            if (!shots.length || shots.some((shot) => !shot.videoMediaId))
              throw new Error('请先为当前集每个镜头准备视频')
            const revision = createHash('sha256').update(JSON.stringify({
              renderer: episodeRenderVersion,
              aspect: p.aspect,
              shots: shots.map((shot) => [shot.id, shot.videoMediaId, shot.audioMediaId, shot.duration]),
            })).digest('hex').slice(0, 16)
            const directory = store.file(p.id, 'exports')
            const name = `preview-${c.episodeId}-${revision}.mp4`
            const file = store.file(p.id, `exports/${name}`)
            if (!existsSync(file)) {
              await mkdir(directory, { recursive: true })
              const partial = store.file(p.id, `exports/${name}.partial.mp4`)
              const work = exporter.episode(store, p.id, c.episodeId, 'mp4', partial)
              changed()
              try {
                await work
                await rename(partial, file)
                await rm(partial.replace(/\.mp4$/i, '') + '.srt', { force: true })
                for (const old of await readdir(directory))
                  if (old.startsWith(`preview-${c.episodeId}-`) && old !== name &&
                      /^preview-[a-zA-Z0-9_-]+-[a-f0-9]{16}\.(mp4|srt)$/.test(old))
                    await rm(store.file(p.id, `exports/${old}`), { force: true }).catch(() => undefined)
              } finally {
                await rm(partial, { force: true })
                changed()
              }
            }
            text = `media://preview/${p.id}/${c.episodeId}/${revision}`
            break
          }
          case 'cancelExport':
            exporter.cancel()
            break
          case 'reveal': {
            const p = store.project(c.projectId)
            if (c.mediaId) {
              const m = p.media.find((m) => m.id === c.mediaId)
              if (!m) throw new Error('素材不存在')
              shell.showItemInFolder(store.file(p.id, m.file))
            } else await shell.openPath(store.dir(p.id))
            break
          }
          case 'history':
            text = JSON.stringify(store.history(c.projectId))
            break
          case 'restore':
            store.restore(c.projectId, c.revision)
            message = '已恢复历史版本，素材版本仍保留'
            break
          case 'deleteProject': {
            if (
              store
                .jobs()
                .some(
                  (j) =>
                    j.projectId === c.projectId &&
                    [
                      'queued',
                      'running',
                      'submitting',
                      'downloading',
                      'paused',
                      'uncertain',
                    ].includes(j.status),
                )
            )
              throw new Error('此项目还有未完成任务')
            store.project(c.projectId)
            store.db.prepare('DELETE FROM projects WHERE id=?').run(c.projectId)
            message = '项目已从列表移除，原素材目录仍保留'
            break
          }
        }
        if (c.type !== 'snapshot') changed()
        return { ok: true, state: snapshot(), message, text }
      } catch (e) {
        const message =
          e instanceof ZodError &&
          e.issues.some((issue) => issue.code === 'invalid_union' && issue.path.length === 0)
            ? '开发版界面与主进程版本不一致，请重启应用后重试。'
            : e instanceof Error
              ? e.message
              : '操作失败'
        return {
          ok: false,
          error: message.replaceAll(key() || '__no_secret__', '[已隐藏]').slice(0, 2500),
        }
      }
    }
    queue.setAIProcessor(async (task, signal) => {
      const reply = await command(task.request, task, signal)
      if (!reply.ok) throw new Error(reply.error)
      return { text: reply.text, message: reply.message }
    })
    ipcMain.handle('director:command', async (event, raw): Promise<Reply> => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame)
        return { ok: false, error: '不允许的调用来源' }
      return command(raw)
    })
    ipcMain.handle('director:previs-frame', async (event, sessionId: string, index: number, data: ArrayBuffer) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不允许的调用来源')
      await previsExporter.frame(sessionId, index, data)
    })
    studioServer = await startPluginServer({
      userData: app.getPath('userData'), renderer: join(here, '../renderer'), store, snapshot, mediaFile,
      command: (raw, context) => commandFiles.run(context, () => command(raw)),
      previsFrame: (sessionId, index, bytes) => previsExporter.frame(sessionId, index, bytes),
    })
    if (!pluginMode) createWindow()
    queue.start()
    app.on('activate', () => {
      if (!window) createWindow()
    })
  })
app.on('window-all-closed', () => {
  if (!pluginMode && process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => {
  queue?.stop()
  exporter.cancel()
  void previsExporter?.cancel()
  void studioServer?.close()
})
app.on('will-quit', () => store?.close())
