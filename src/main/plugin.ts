import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { commandSchema, type Reply, type Snapshot } from '../shared/schema'
import { pluginCallSchema, pluginInputs, pluginTools, pluginVersion, studioUri, type PluginAction } from '../shared/plugin'
import { inside, type Store } from './store'

export interface CommandFiles { files: string[]; names?: string[]; output?: string; projectId?: string }
type Options = {
  userData: string
  renderer: string
  store: Store
  snapshot(): Snapshot
  command(raw: unknown, files: CommandFiles): Promise<Reply>
  mediaFile(url: URL): string
  previsFrame?(sessionId: string, index: number, bytes: Uint8Array): Promise<void>
}
const maxJson = 4 * 1024 * 1024
const maxUpload = 200 * 1024 * 1024
const jsonBody = async (request: IncomingMessage) => {
  const parts: Buffer[] = []
  let size = 0
  for await (const part of request) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part)
    size += bytes.length
    if (size > maxJson) throw new Error('请求超过 4 MB')
    parts.push(bytes)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}
const mime = (file: string) => ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.srt': 'text/plain; charset=utf-8', '.zip': 'application/zip' }[extname(file)] || 'application/octet-stream')

export async function studioHtml(root: string, base?: string) {
  let html = await readFile(join(root, 'index.html'), 'utf8')
  html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>/i, '')
  for (const match of [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g)]) {
    if (base) {
      html = html.replace(match[0], () => `<script type="module" src="${new URL(match[1], base).href}"></script>`)
      continue
    }
    const script = await readFile(inside(root, match[1].replace(/^\.\//, '')), 'utf8')
    html = html.replace(match[0], () => `<script type="module">${script.replace(/<\/script/gi, '<\\/script')}</script>`)
  }
  for (const match of [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)]) {
    const css = await readFile(inside(root, match[1].replace(/^\.\//, '')), 'utf8')
    html = html.replace(match[0], () => `<style>${css}</style>`)
  }
  return html.replace(/<link\b[^>]*rel="(?:modulepreload|icon)"[^>]*>/g, '')
}

export async function startPluginServer(options: Options) {
  const token = randomBytes(32).toString('hex')
  const events = new Set<ServerResponse>()
  const uploads = new Map<string, { file: string; name: string; created: number }>()
  const downloads = new Map<string, string>()
  const uploadRoot = join(options.userData, 'studio-uploads')
  const descriptorPath = join(options.userData, 'studio-connection.json')
  await mkdir(uploadRoot, { recursive: true })
  let origin = '', base = ''
  const sendJson = (response: ServerResponse, status: number, data: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(data))
  }
  const runCommand = async (raw: unknown, files: string[] = [], names?: string[]) => {
    const command = commandSchema.parse(raw)
    const context: CommandFiles = { files, names, ...('projectId' in command ? { projectId: command.projectId } : {}) }
    const reply = await options.command(command, context)
    if (!reply.ok) return reply
    if (context.output && (await stat(context.output)).isFile()) {
      if (downloads.size >= 100) downloads.delete(downloads.keys().next().value || '')
      const downloadId = randomUUID()
      downloads.set(downloadId, context.output)
      reply.download = `${base}download/${downloadId}`
    }
    return reply
  }
  const toolResult = (structuredContent: Record<string, unknown>) => ({
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent,
  })
  const callTool = async (raw: unknown, workspaceRoot?: string) => {
    const call = pluginCallSchema.parse(raw)
    const tool = pluginTools.find((entry) => entry.name === call.name)
    if (!tool) throw new Error('未知的幕织工具')
    const action = call.name.replace(/^muweave_/, '').replaceAll('_', '-') as PluginAction
    if (action === 'studio-info') {
      pluginInputs['studio-info'].parse(call.arguments)
      return { ...toolResult({ url: base, version: pluginVersion }),
        _meta: { ui: { resourceUri: studioUri }, studioBase: base } }
    }
    if (action === 'read') {
      const input = pluginInputs.read.parse(call.arguments)
      const state = options.snapshot()
      if (input.projectId) {
        const project = options.store.project(input.projectId)
        return toolResult({ project, jobs: state.jobs.filter((job) => job.projectId === project.id).slice(0, 50),
          aiTasks: state.aiTasks.filter((task) => task.projectId === project.id)
            .filter((task, index) => index < 50 || ['queued', 'running'].includes(task.status)),
          ...(input.history ? { history: options.store.history(project.id) } : {}) })
      }
      return toolResult({ projects: state.projects.map((p) => ({ id: p.id, title: p.title,
        aspect: p.aspect, episodes: p.episodes.map((ep) => ({ id: ep.id, title: ep.title })),
        shotCount: p.shots.length, assetCount: p.assets.length })),
        aiTasks: state.aiTasks.filter((task, index) => index < 50 || ['queued', 'running'].includes(task.status))
          .map(({ id, projectId, title, status, error, model, remoteTaskId }) => ({ id, projectId, title, status, error, model, remoteTaskId })),
        jobs: state.jobs.slice(0, 50).map((j) => ({ id: j.id, projectId: j.projectId, shotId: j.shotId,
          status: j.status, taskId: j.taskId, error: j.error, model: j.model })), hasKey: state.hasKey,
        models: state.config.models, instanceType: state.config.instanceType, paused: state.config.paused })
    }
    const input = pluginInputs[action].parse(call.arguments)
    if (!('command' in input)) throw new Error('缺少命令')
    if (action === 'generate' && (input.command.type === 'queue' || input.command.type === 'terminateTasks' ||
        (input.command.type === 'job' && input.command.action === 'retry')) &&
        (!('confirmed' in input) || input.confirmed !== true))
      throw new Error('付费生成或全部终止任务需先获得用户明确授权，再传入 confirmed:true')
    const files: string[] = []
    if (action === 'import') {
      const { paths } = pluginInputs.import.parse(call.arguments)
      if (!workspaceRoot) throw new Error('导入需要当前宿主工作区')
      const root = await realpath(workspaceRoot)
      for (const path of paths) {
        if (/^[A-Za-z]:|^[\\/]/.test(path)) throw new Error('文件必须是工作区相对路径')
        const file = await realpath(inside(root, path))
        inside(root, file)
        files.push(file)
      }
    }
    const reply = await runCommand(input.command, files)
    if (!reply.ok) return { isError: true, content: [{ type: 'text', text: reply.error }] }
    return toolResult({ message: reply.message, text: reply.text, download: reply.download,
      projects: reply.state.projects.map((p) => ({ id: p.id, title: p.title,
        episodeIds: p.episodes.map((ep) => ep.id), shotIds: p.shots.map((s) => s.id), assetIds: p.assets.map((a) => a.id) })),
      aiTasks: reply.state.aiTasks.slice(0, 20).map(({ id, status, title }) => ({ id, status, title })),
      jobs: reply.state.jobs.slice(0, 20).map((j) => ({ id: j.id, status: j.status, taskId: j.taskId })) })
  }
  const rpc = async (raw: unknown, workspaceRoot?: string) => {
    const message = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(),
      method: z.string(), params: z.unknown().optional() }).parse(raw)
    if (message.id === undefined) return undefined
    try {
      let result: unknown
      switch (message.method) {
        case 'initialize':
          const initialization = z.object({ protocolVersion: z.string() }).parse(message.params)
          result = { protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(initialization.protocolVersion)
              ? initialization.protocolVersion : '2025-11-25', capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'muweave', version: pluginVersion },
            instructions: '幕织本地导演台。先读取项目再编辑。只有用户授权后才生成视频；未知提交不能自动重试。API Key 仅在 Studio 设置中填写，不收集到聊天。' }
          break
        case 'ping': result = {}; break
        case 'tools/list': result = { tools: pluginTools }; break
        case 'tools/call': result = await callTool(message.params, workspaceRoot); break
        case 'resources/list': result = { resources: [{ uri: studioUri, name: 'Muweave Studio', mimeType: 'text/html;profile=mcp-app' }] }; break
        case 'resources/templates/list': result = { resourceTemplates: [] }; break
        case 'resources/read': {
          z.object({ uri: z.literal(studioUri) }).parse(message.params)
          result = { contents: [{ uri: studioUri, mimeType: 'text/html;profile=mcp-app',
            text: await studioHtml(options.renderer, base), _meta: { ui: { csp: {
              connectDomains: [origin], resourceDomains: [origin] }, prefersBorder: false } } }] }
          break
        }
        default: return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
      }
      return { jsonrpc: '2.0', id: message.id, result }
    } catch (error) {
      return { jsonrpc: '2.0', id: message.id, error: { code: -32602,
        message: error instanceof Error ? error.message.slice(0, 1000) : 'Invalid request' } }
    }
  }
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.host !== new URL(origin).host) return sendJson(response, 403, { error: 'Invalid host' })
      const url = new URL(request.url || '/', origin)
      const parts = url.pathname.split('/').filter(Boolean)
      const provided = Buffer.from(parts[1] || '')
      if (parts[0] !== 's' || provided.length !== token.length ||
          !timingSafeEqual(provided, Buffer.from(token))) return sendJson(response, 401, { error: 'Studio session required' })
      response.setHeader('Access-Control-Allow-Origin', '*')
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Muweave-Client')
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Referrer-Policy', 'no-referrer')
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
      const path = parts.slice(2).join('/')
      if (request.method === 'POST') {
        if (path.startsWith('previs-frame/')) {
          const [, sessionId, index] = path.split('/')
          if (!options.previsFrame) throw new Error('预演渲染不可用')
          const chunks: Buffer[] = []
          let size = 0
          for await (const bytes of request) {
            size += bytes.length
            if (size > 8 * 1024 * 1024) throw new Error('预演帧过大')
            chunks.push(Buffer.from(bytes))
          }
          await options.previsFrame(sessionId, Number(index), Buffer.concat(chunks))
          return sendJson(response, 200, { ok: true })
        }
        if (path === 'upload') {
          if (uploads.size >= 100) throw new Error('待处理文件过多，请先完成当前导入')
          const name = basename(url.searchParams.get('name') || 'upload').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-180)
          const uploadId = randomUUID(), file = inside(uploadRoot, `${uploadId}-${name}`)
          let size = 0
          const writer = (await import('node:fs')).createWriteStream(file)
          try {
            await pipeline(request, async function* (source) {
              for await (const bytes of source) {
                size += bytes.length
                if (size > maxUpload) throw new Error('文件不能超过 200 MB')
                yield bytes
              }
            }, writer)
            uploads.set(uploadId, { file, name, created: Date.now() })
            sendJson(response, 200, { uploadId })
          } catch (error) { await rm(file, { force: true }); throw error }
          return
        }
        const body = await jsonBody(request)
        if (path === 'rpc') {
          const input = z.object({ message: z.unknown(), workspaceRoot: z.string().optional() }).parse(body)
          const reply = await rpc(input.message, input.workspaceRoot)
          if (reply) sendJson(response, 200, reply)
          else { response.writeHead(204); response.end() }
          return
        }
        if (path === 'tool') {
          const input = z.object({ call: z.unknown(), workspaceRoot: z.string().optional() }).parse(body)
          return sendJson(response, 200, await callTool(input.call, input.workspaceRoot))
        }
        if (path === 'command') {
          const input = z.object({ command: commandSchema, uploadIds: z.array(z.string().uuid()).max(10).default([]) }).parse(body)
          const files = input.uploadIds.map((uploadId) => {
            const upload = uploads.get(uploadId)
            if (!upload) throw new Error('上传文件已失效')
            return upload.file
          })
          const reply = await runCommand(input.command, files, input.uploadIds.map((id) => uploads.get(id)!.name))
          if (input.command.type !== 'scriptChatPickFiles')
            for (const uploadId of input.uploadIds) {
              const upload = uploads.get(uploadId)
              if (upload) await rm(upload.file, { force: true })
              uploads.delete(uploadId)
            }
          return sendJson(response, 200, reply)
        }
      }
      if (request.method === 'GET') {
        if (path === 'health') return sendJson(response, 200, { name: 'muweave', version: pluginVersion })
        if (path === 'events') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
          response.write(': connected\n\n')
          events.add(response)
          request.on('close', () => events.delete(response))
          return
        }
        if (path.startsWith('media/')) {
          let file: string
          try { file = options.mediaFile(new URL(`media://${path.slice(6)}`)) }
          catch { return sendJson(response, 404, { error: 'Media not found' }) }
          const { size } = await stat(file)
          const range = request.headers.range
          let start = 0, end = size - 1
          if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range)
            if (!match || (!match[1] && !match[2])) {
              response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return
            }
            start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
            end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
              response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return
            }
          }
          response.writeHead(range ? 206 : 200, { 'Content-Type': mime(file), 'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) })
          await pipeline(createReadStream(file, { start, end }), response)
          return
        }
        const download = path.startsWith('download/') ? downloads.get(path.slice(9)) : undefined
        const file = download || inside(options.renderer, path || 'index.html')
        const info = await stat(file)
        if (!info.isFile()) throw new Error('文件不存在')
        response.setHeader('Content-Type', mime(file))
        if (download) response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(basename(file))}`)
        await pipeline(createReadStream(file), response)
        return
      }
      sendJson(response, 404, { error: 'Not found' })
    })().catch((error) => {
      if (!response.headersSent) sendJson(response, 400, { error: error instanceof Error ? error.message.slice(0, 1000) : 'Studio request failed' })
      else response.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法启动 Studio')
  origin = `http://127.0.0.1:${address.port}`
  base = `${origin}/s/${token}/`
  const temporary = `${descriptorPath}.${process.pid}.partial`
  await writeFile(temporary, JSON.stringify({ base, pid: process.pid, version: pluginVersion }), { mode: 0o600 })
  await rename(temporary, descriptorPath)
  const cleanup = setInterval(() => {
    for (const [uploadId, upload] of uploads)
      if (Date.now() - upload.created > 24 * 60 * 60_000) {
        uploads.delete(uploadId)
        void rm(upload.file, { force: true }).catch(() => undefined)
      }
    for (const response of events) response.write(': keepalive\n\n')
  }, 30_000)
  cleanup.unref()
  return {
    base,
    changed() { for (const response of events) response.write('data: changed\n\n') },
    async close() {
      clearInterval(cleanup)
      for (const response of events) response.end()
      server.close()
      try {
        const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'))
        if (descriptor.pid === process.pid) await rm(descriptorPath, { force: true })
      } catch { /* A newer runtime may own the descriptor. */ }
      for (const upload of uploads.values()) await rm(upload.file, { force: true }).catch(() => undefined)
    },
  }
}
