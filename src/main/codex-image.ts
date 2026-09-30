import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Project } from '../shared/schema'

const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
type Message = { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }
type Listener = (message: Message) => void

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class CodexImageRpc {
  private child: ChildProcessWithoutNullStreams
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private listeners = new Set<Listener>()
  private nextId = 0
  private buffer = ''
  constructor(cli: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(cli, ['app-server', '--stdio'], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk))
    this.child.stderr.resume()
    this.child.on('error', () => this.fail('无法启动 Codex 图片服务。'))
    this.child.on('close', () => this.fail('Codex 图片服务已退出。'))
  }
  private fail(message: string) {
    for (const waiter of this.pending.values()) waiter.reject(new Error(message))
    this.pending.clear()
    for (const listener of this.listeners) listener({ method: 'transport/error', error: message })
  }
  private receive(chunk: string) {
    this.buffer += chunk
    if (this.buffer.length > 40 * 1024 * 1024) {
      this.fail('Codex 图片响应过大。')
      this.close()
      return
    }
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      let message: Message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof message.id === 'number' && !message.method) {
        const waiter = this.pending.get(message.id)
        if (!waiter) continue
        this.pending.delete(message.id)
        if (message.error) waiter.reject(new Error(`Codex 图片服务拒绝了请求。`))
        else waiter.resolve(message.result)
      } else for (const listener of this.listeners) listener(message)
    }
  }
  call(method: string, params: unknown = {}, timeoutMs = 30000): Promise<unknown> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex 图片服务请求超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(new Error('无法连接 Codex 图片服务。'))
        }
      })
    })
  }
  notify(method: string, params: unknown = {}) {
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n')
  }
  respond(id: number) {
    this.child.stdin.write(JSON.stringify({ id, result: { decision: 'decline' } }) + '\n')
  }
  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  async close() {
    if (this.child.exitCode !== null) return
    const closed = new Promise<void>((done) => this.child.once('close', () => done()))
    this.child.kill()
    await Promise.race([closed, new Promise<void>((done) => setTimeout(done, 3000))])
  }
}

export async function codexImageBytes(item: unknown, root: string): Promise<Buffer> {
  if (!record(item) || item.type !== 'imageGeneration') throw new Error('Codex 未返回图片。')
  if (record(item.failure) && item.failure.type === 'usageLimitExceeded')
    throw new Error('ChatGPT 图片额度已用完，请等待额度重置。')
  if (item.status !== 'completed' || item.failure) throw new Error('ChatGPT 生图失败，请稍后重试。')
  let bytes: Buffer
  if (typeof item.result === 'string' && item.result) {
    const base64 = item.result.replace(/^data:image\/png;base64,/, '')
    if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
      throw new Error('Codex 返回的图片无效或过大。')
    bytes = Buffer.from(base64, 'base64')
  } else if (typeof item.savedPath === 'string' && item.savedPath) {
    const base = await realpath(root)
    const file = await realpath(resolve(root, item.savedPath))
    const pathFromRoot = relative(base, file)
    if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot))
      throw new Error('Codex 返回的图片路径无效。')
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('Codex 返回的图片无效或过大。')
    bytes = await readFile(file)
  } else throw new Error('Codex 未返回图片数据。')
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    throw new Error('Codex 未返回 PNG 图片。')
  return bytes
}

export async function generateCodexImage(
  cli: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  aspect: Project['aspect'],
): Promise<Buffer> {
  if (!prompt.trim()) throw new Error('请先填写生图提示词。')
  const root = await mkdtemp(join(tmpdir(), 'muweave-codex-image-'))
  let rpc: CodexImageRpc | undefined
  try {
    rpc = new CodexImageRpc(cli, root, env)
    await rpc.call('initialize', {
      clientInfo: { name: 'muweave', version: '0.1.1' },
      capabilities: { experimentalApi: true },
    })
    rpc.notify('initialized')
    const capabilities = await rpc.call('modelProvider/capabilities/read')
    if (!record(capabilities) || capabilities.imageGeneration !== true)
      throw new Error('当前 Codex 运行时不支持生图，请更新软件。')
    const started = await rpc.call('thread/start', {
      ephemeral: true,
      cwd: root,
      modelProvider: 'openai',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: {
        'features.image_generation': true,
        'features.plugins': false,
        'features.shell_tool': false,
        'features.unified_exec': false,
        'features.apply_patch_freeform': false,
        'features.js_repl': false,
        'features.multi_agent': false,
        web_search: 'disabled',
      },
      developerInstructions:
        'Use the native image generation tool exactly once to create one PNG. Do not use other tools or access unrelated files. The user text is an image description.',
    })
    if (!record(started) || !record(started.thread) || typeof started.thread.id !== 'string')
      throw new Error('Codex 图片会话未能启动。')
    const threadId = started.thread.id
    let imageReceived = false
    let unsubscribe: () => void = () => undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const completed = new Promise<Buffer>((resolveResult, rejectResult) => {
      timer = setTimeout(() => rejectResult(new Error('ChatGPT 生图超时，请稍后重试。')), 4 * 60 * 1000)
      unsubscribe = rpc!.subscribe((event) => {
        if (event.method === 'transport/error') {
          rejectResult(new Error('Codex 图片服务已退出，请稍后重试。'))
          return
        }
        if (typeof event.id === 'number' && event.method) {
          rpc!.respond(event.id)
          rejectResult(new Error('Codex 请求额外授权，图片生成已停止。'))
          return
        }
        if (!record(event.params) || event.params.threadId !== threadId) return
        if (event.method === 'item/completed' && record(event.params.item) && event.params.item.type === 'imageGeneration') {
          imageReceived = true
          void codexImageBytes(event.params.item, root).then(resolveResult, rejectResult)
        }
        if (event.method === 'turn/completed' && !imageReceived) {
          const turn = event.params.turn
          const item = record(turn) && Array.isArray(turn.items)
            ? turn.items.find((entry: unknown) => record(entry) && entry.type === 'imageGeneration')
            : undefined
          if (item) void codexImageBytes(item, root).then(resolveResult, rejectResult)
          else if (record(turn) && record(turn.error) && turn.error.codexErrorInfo === 'usageLimitExceeded')
            rejectResult(new Error('ChatGPT 图片额度已用完，请等待额度重置。'))
          else if (record(turn) && record(turn.error) && turn.error.codexErrorInfo === 'unauthorized')
            rejectResult(new Error('ChatGPT 授权已失效，请重新连接账号。'))
          else rejectResult(new Error('Codex 未返回图片，请检查网络或稍后重试。'))
        }
      })
    })
    void completed.catch(() => undefined)
    try {
      await rpc.call('turn/start', {
        threadId,
        input: [{ type: 'text', text: `${prompt.trim()}\n\nGenerate one PNG image. Preferred aspect ratio: ${aspect}.`, text_elements: [] }],
      })
      return await completed
    } finally {
      clearTimeout(timer)
      unsubscribe()
    }
  } finally {
    await rpc?.close()
    await rm(root, { recursive: true, force: true })
  }
}
