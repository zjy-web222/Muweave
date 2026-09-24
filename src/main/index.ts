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
import { join, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import mammoth from 'mammoth'
import {
  commandSchema,
  configSchema,
  id,
  shotSchema,
  type Reply,
  type Snapshot,
} from '../shared/schema'
import {
  buildPrompt,
  buildScriptChatPrompt,
  parseDirector,
  parseScriptChatReply,
} from '../shared/director'
import { Store, createProject } from './store'
import { ChatGPT } from './chatgpt'
import { CodexText } from './codex'
import { Queue, RunningHub, inputsChanged } from './runninghub'
import { activate, importMedia, exportArchive, restoreArchive, Exporter } from './media'

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
  codex: CodexText
const exporter = new Exporter()
if (process.env.DIRECTOR_DATA_DIR) app.setPath('userData', process.env.DIRECTOR_DATA_DIR)
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()
app.on('second-instance', () => {
  window?.show()
  window?.focus()
})
function changed() {
  window?.webContents.send('director:changed')
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
function snapshot(): Snapshot {
  return {
    projects: store.projects(),
    jobs: store.jobs(),
    config: store.config(),
    hasKey: !!key(),
    chatgptOpen: !!chatgpt.window,
    dataPath: store.root,
    exporting: exporter.busy,
  }
}
async function chooseSave(defaultPath: string, extensions: string[]) {
  return (
    await dialog.showSaveDialog(window!, {
      defaultPath,
      filters: [{ name: extensions.join('/').toUpperCase(), extensions }],
    })
  ).filePath
}
async function chooseFile(extensions: string[]) {
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
  void app.whenReady().then(() => {
    store = new Store(join(app.getPath('userData'), 'library'))
    chatgpt = new ChatGPT(store, changed)
    codex = new CodexText(store)
    const api = new RunningHub(key)
    queue = new Queue(store, api, changed)
    protocol.handle('media', async (request) => {
      try {
        const url = new URL(request.url),
          [pid, mid] = url.pathname.split('/').filter(Boolean)
        id.parse(pid)
        id.parse(mid)
        if (url.hostname !== 'asset') throw new Error('invalid')
        const p = store.project(pid),
          m = p.media.find((m) => m.id === mid)
        if (!m) throw new Error('missing')
        return net.fetch(pathToFileURL(store.file(pid, m.file)).href, { headers: request.headers })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })
    ipcMain.handle('director:command', async (event, raw): Promise<Reply> => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        return { ok: false, error: '不允许的调用来源' }
      try {
        const c = commandSchema.parse(raw)
        let message: string | undefined, text: string | undefined
        switch (c.type) {
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
              if (ep) Object.assign(ep, { title: c.title, script: c.script })
              else
                p.episodes.push({
                  id: randomUUID(),
                  title: c.title,
                  script: c.script,
                  scriptChat: [],
                })
            })
            break
          case 'scriptChat':
            store.update(c.projectId, (p) => {
              const ep = p.episodes.find((e) => e.id === c.episodeId)
              if (!ep) throw new Error('集不存在')
              ep.scriptChat = [...ep.scriptChat, c.turn].slice(-40)
            })
            break
          case 'scriptChatGenerate': {
            const p = store.project(c.projectId)
            const ep = p.episodes.find((e) => e.id === c.episodeId)
            if (!ep) throw new Error('集不存在')
            const prompt = buildScriptChatPrompt(p, c.episodeId, c.request, ep.script, p.style)
            const rawReply = await codex.generate(prompt, {
              type: 'object',
              properties: { reply: { type: 'string' }, script: { type: 'string' } },
              required: ['reply', 'script'],
              additionalProperties: false,
            })
            const reply = parseScriptChatReply(rawReply)
            const now = new Date().toISOString()
            store.update(c.projectId, (current) => {
              const target = current.episodes.find((e) => e.id === c.episodeId)
              if (!target) throw new Error('集不存在')
              target.scriptChat = [
                ...target.scriptChat,
                { id: randomUUID(), role: 'user' as const, text: c.request, createdAt: now },
                {
                  id: randomUUID(),
                  role: 'assistant' as const,
                  text: reply.reply.trim() || '已生成剧本草稿',
                  script: reply.script?.trim() ? reply.script : undefined,
                  createdAt: now,
                },
              ].slice(-40)
            })
            break
          }
          case 'codexStatus':
            text = (await codex.connected()) ? 'connected' : 'disconnected'
            break
          case 'codexLogin':
            await codex.login()
            message = 'ChatGPT 账号已连接，可在软件中直接生成文本。'
            break
          case 'generateText': {
            const p = store.project(c.projectId)
            if (!p.episodes.some((e) => e.id === c.episodeId)) throw new Error('集不存在')
            text = await codex.generate(c.prompt || buildPrompt(p, c.episodeId, c.kind))
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
                }
                next.stale = old.stale || (!!old.videoMediaId && inputsChanged(next, old))
                p.shots[index] = next
              }
            })
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
              else
                p.assets[index] = { ...c.asset, selectedMediaId: p.assets[index].selectedMediaId }
            })
            break
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
            store.update(c.projectId, (p) => {
              p.source = raw
              const e = p.episodes.find((e) => e.id === c.episodeId)
              if (e) e.script = raw
            })
            message = '已导入文本'
            break
          }
          case 'parse': {
            const result = parseDirector(c.raw)
            store.update(c.projectId, (p) => {
              const ep = p.episodes.find((e) => e.id === c.episodeId)
              if (!ep) throw new Error('集不存在')
              if (result.script !== undefined) ep.script = result.script
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
            message = `已更新剧本/资产，追加 ${result.shots?.length || 0} 个镜头；旧镜头未覆盖`
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
              c.slot === 'video'
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
            if (c.key?.trim()) {
              if (!safeStorage.isEncryptionAvailable())
                throw new Error('操作系统凭据加密不可用，未保存 API Key')
              store.set(
                'runninghub-key',
                safeStorage.encryptString(c.key.trim()).toString('base64'),
              )
            }
            const unique = new Set(c.config.mappings.map((m) => `${m.nodeId}:${m.fieldName}`))
            if (unique.size !== c.config.mappings.length)
              throw new Error('一个节点字段只能映射一次')
            store.set('config', configSchema.parse(c.config))
            message = '设置已保存，Key 不会进入项目存档'
            break
          }
          case 'clearKey':
            store.set('runninghub-key', '')
            break
          case 'testConnection':
            text = JSON.stringify(await api.account(store.config()), null, 2)
            message = 'RunningHub 连接成功'
            break
          case 'workflow':
            text = JSON.stringify(await api.workflow(store.config()), null, 2)
            break
          case 'queue':
            if (!key()) throw new Error('请先绑定 RunningHub Key')
            queue.enqueue(c.projectId, c.shotIds, c.stopOnFailure)
            message = '已加入视频任务队列'
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
            const file = await chooseSave(
              `${store.project(c.projectId).title}-backup.director.zip`,
              ['zip'],
            )
            if (!file) break
            await exportArchive(store, c.projectId, file)
            store.db.prepare('DELETE FROM projects WHERE id=?').run(c.projectId)
            message = '已备份并从项目列表移除，原素材目录仍保留'
            break
          }
        }
        if (c.type !== 'snapshot') changed()
        return { ok: true, state: snapshot(), message, text }
      } catch (e) {
        const message = e instanceof Error ? e.message : '操作失败'
        return {
          ok: false,
          error: message.replaceAll(key() || '__no_secret__', '[已隐藏]').slice(0, 2500),
        }
      }
    })
    createWindow()
    queue.start()
    app.on('activate', () => {
      if (!window) createWindow()
    })
  })
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => {
  queue?.stop()
  exporter.cancel()
})
app.on('will-quit', () => store?.close())
