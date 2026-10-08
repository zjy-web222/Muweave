import { access, mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const userData = process.env.DIRECTOR_DATA_DIR || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'muweave')
let connecting
async function connection() {
  try {
    const record = JSON.parse(await readFile(join(userData, 'studio-connection.json'), 'utf8'))
    const url = new URL(record.base)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\/s\/[a-f0-9]{64}\/$/.test(url.pathname)) return
    const response = await fetch(record.base + 'health', { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return
    const health = await response.json()
    if (health.name === 'muweave' && /^0\.2\.\d+$/.test(health.version)) return record.base
  } catch { /* A closed or not-yet-started runtime has no live connection. */ }
}
async function startRuntime() {
  const live = await connection()
  if (live) return live
  let location = {}
  try { location = JSON.parse(await readFile(join(here, 'runtime.json'), 'utf8')) } catch { /* Installed runtime discovery follows. */ }
  const home = process.env.MUWEAVE_HOME || location.sourceRoot
  const executable = process.env.MUWEAVE_EXECUTABLE || location.executable ||
    join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'Muweave', 'Muweave.exe')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  let command = executable, args = ['--plugin-server'], cwd = here
  if (home) {
    cwd = resolve(home)
    await access(join(cwd, 'dist', 'main', 'index.js'))
    command = join(cwd, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
    args = [cwd, '--plugin-server']
  }
  await access(command).catch(() => { throw new Error('请安装幕织 0.2.0 运行环境，或设置 MUWEAVE_HOME 为已构建的幕织源码目录。') })
  await mkdir(userData, { recursive: true })
  const logPath = join(userData, 'studio-runtime.log')
  const logSize = await stat(logPath).then(file => file.size).catch(() => 0)
  const log = await open(logPath, logSize > 1024 * 1024 ? 'w' : 'a', 0o600)
  const child = spawn(command, args, { cwd, env, detached: true, windowsHide: true,
    stdio: ['ignore', log.fd, log.fd] })
  let failure
  child.on('error', (error) => { failure = error })
  child.on('exit', (code) => { if (code) failure = new Error(`幕织服务启动失败（${code}），请查看 ${logPath}`) })
  child.unref()
  await log.close()
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (failure) throw failure
    const base = await connection()
    if (base) return base
    await new Promise((done) => setTimeout(done, 300))
  }
  throw new Error('幕织本地服务启动超时；请打开幕织检查运行环境。未提交任何生成任务。')
}
export async function runtimeBase() {
  const live = await connection()
  if (live) return live
  connecting ||= startRuntime().finally(() => { connecting = undefined })
  return connecting
}
async function post(path, body) {
  const base = await runtimeBase()
  const response = await fetch(base + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(600000) })
  if (response.status === 204) return
  const result = await response.json()
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '幕织服务请求失败')
  return result
}
export default async function createMuweaveService(runtime) {
  return {
    actions: Object.fromEntries(['studio-info', 'read', 'edit', 'generate', 'import', 'export'].map((action) => [action,
      async (args) => {
        const result = await post('tool', { call: { name: `muweave_${action.replaceAll('-', '_')}`, arguments: args },
          workspaceRoot: runtime.workspace.root })
        if (result.isError) throw new Error(result.content?.[0]?.text || '幕织操作失败')
        return result.structuredContent
      },
    ])),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lines = createInterface({ input: process.stdin, terminal: false })
  lines.on('line', (line) => {
    if (line.length > 4 * 1024 * 1024) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } }) + '\n')
      return
    }
    let message
    try { message = JSON.parse(line) } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n')
      return
    }
    void post('rpc', { message, workspaceRoot: process.cwd() }).then((result) => {
      if (result) process.stdout.write(JSON.stringify(result) + '\n')
    }).catch((error) => {
      if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        error: { code: -32603, message: error.message } }) + '\n')
    })
  })
}
