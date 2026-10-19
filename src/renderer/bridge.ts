import { z } from 'zod'
import { replySchema, type Bridge, type Command } from '../shared/schema'
import { pluginTools, pluginVersion } from '../shared/plugin'

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
const pending = new Map<number, Pending>()
let nextId = 0
function hostRequest(method: string, params: unknown): Promise<unknown> {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Studio 与宿主连接超时，请重新打开工作台')) }, 60000)
    pending.set(id, { resolve, reject, timer })
    parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*')
  })
}
const resultSchema = z.object({ structuredContent: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(), isError: z.boolean().optional() }).passthrough()
const baseSchema = z.string().url().refine((value) => {
  const url = new URL(value)
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^\/s\/[a-f0-9]{64}\/$/.test(url.pathname)
}, 'Studio 地址无效')

if (!window.director) {
  document.documentElement.dataset.studio = 'true'
  let base = ''
  const listeners = new Set<() => void>()
  let events: EventSource | undefined
  const connect = async () => {
    if (/^\/s\/[a-f0-9]{64}\/$/.test(location.pathname)) {
      base = baseSchema.parse(location.href.split(/[?#]/)[0])
    } else {
      if (parent === window) throw new Error('请通过幕织插件打开 Studio')
      const initialized = z.object({ hostContext: z.record(z.string(), z.unknown()).optional() }).passthrough()
        .parse(await hostRequest('ui/initialize', {
          protocolVersion: '2025-11-21', appInfo: { name: 'Muweave Studio', version: pluginVersion },
          appCapabilities: { tools: {}, availableDisplayModes: ['inline', 'fullscreen'] },
        }))
      parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*')
      const nativeActions = Boolean(initialized.hostContext?.['ai.ipollo/workspace'])
      const result = resultSchema.parse(await hostRequest('tools/call', {
        name: nativeActions ? 'studio-info' : 'muweave_studio_info', arguments: {},
      }))
      if (result.isError) throw new Error('幕织本地服务未启动，请检查插件运行环境')
      const nested = resultSchema.safeParse(result.structuredContent)
      base = baseSchema.parse(result._meta?.studioBase || result.structuredContent?.url ||
        (nested.success ? nested.data.structuredContent?.url : undefined))
    }
    events = new EventSource(base + 'events')
    events.onmessage = () => listeners.forEach((listener) => listener())
    return base
  }
  const ready = connect()
  const request = async (path: string, body: unknown) => {
    await ready
    const response = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Muweave-Client': 'studio' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(600000),
    })
    const result: unknown = await response.json()
    if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(result).error)
    return result
  }
  const pickFiles = (multiple: boolean, accept: string) => new Promise<File[]>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = multiple
    input.accept = accept
    input.hidden = true
    const done = () => { const files = [...(input.files || [])]; input.remove(); resolve(files) }
    input.addEventListener('change', done, { once: true })
    input.addEventListener('cancel', done, { once: true })
    document.body.append(input)
    input.click()
  })
  const mediaUrl = (url: string) => base + 'media/' + url.replace(/^media:\/\//, '')
  const api: Bridge = {
    studio: true, mediaUrl,
    async previsFrame(sessionId, index, data) {
      await ready
      const response = await fetch(`${base}previs-frame/${encodeURIComponent(sessionId)}/${index}`, {
        method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Muweave-Client': 'studio' }, body: data,
        signal: AbortSignal.timeout(60000),
      })
      if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(await response.json()).error)
    },
    async command(command: Command) {
      await ready
      if (command.type === 'clipboard') {
        const reply = replySchema.parse(await request('command', { command: { type: 'snapshot' } }))
        if (reply.ok) reply.text = await navigator.clipboard.readText()
        return reply
      }
      const uploadIds: string[] = []
      if (['importMedia', 'uploadAssetImage', 'importSource', 'importArchive', 'scriptChatPickFiles'].includes(command.type)) {
        const accept = command.type === 'uploadAssetImage' ? '.png,.jpg,.jpeg,.webp' :
          command.type === 'importArchive' ? '.zip' :
          command.type === 'importMedia' ? command.slot === 'model' ? '.glb' : ['video', 'previs'].includes(command.slot) ? '.mp4,.webm,.mov' :
            command.slot === 'audio' ? '.mp3,.wav,.m4a,.aac,.ogg' : '.png,.jpg,.jpeg,.webp' : ''
        const files = await pickFiles(command.type === 'scriptChatPickFiles', accept)
        if (!files.length) return replySchema.parse(await request('command', { command: { type: 'snapshot' } }))
        if (files.length > 10) throw new Error('每轮最多添加 10 个文件')
        for (const file of files) {
          const limit = command.type === 'scriptChatPickFiles' ? 50 : 200
          if (file.size > limit * 1024 * 1024) throw new Error(`文件不能超过 ${limit} MB`)
          const response = await fetch(`${base}upload?name=${encodeURIComponent(file.name)}`, {
            method: 'POST', body: file, signal: AbortSignal.timeout(120000),
          })
          if (!response.ok) throw new Error('文件上传失败，请重新选择')
          uploadIds.push(z.object({ uploadId: z.string().uuid() }).parse(await response.json()).uploadId)
        }
      }
      const reply = replySchema.parse(await request('command', { command, uploadIds }))
      if (reply.ok) {
        if (reply.text?.startsWith('media://')) reply.text = mediaUrl(reply.text)
        if (reply.download) {
          const link = document.createElement('a')
          link.href = reply.download
          link.download = ''
          link.click()
        }
      }
      return reply
    },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  window.director = api
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== parent) return
    const parsed = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.number(), z.string()]).optional(),
      method: z.string().optional(), result: z.unknown().optional(), params: z.unknown().optional(),
      error: z.object({ message: z.string() }).optional() }).safeParse(event.data)
    if (!parsed.success) return
    const message = parsed.data
    if (typeof message.id === 'number' && !message.method) {
      const handler = pending.get(message.id)
      if (!handler) return
      pending.delete(message.id)
      clearTimeout(handler.timer)
      if (message.error) handler.reject(new Error(message.error.message))
      else handler.resolve(message.result)
      return
    }
    const respond = (result: unknown) => parent.postMessage({ jsonrpc: '2.0', id: message.id, result }, '*')
    if (message.method === 'tools/list') respond({ tools: pluginTools })
    if (message.method === 'tools/call')
      void request('tool', { call: message.params }).then(respond).catch((error: unknown) => respond({
        isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Studio 操作失败' }],
      }))
    if (message.method === 'ui/resource-teardown') { events?.close(); respond({}) }
  })
  window.addEventListener('pagehide', () => events?.close(), { once: true })
}
