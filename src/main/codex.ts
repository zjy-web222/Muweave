import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Store } from './store'

const require = createRequire(import.meta.url)
const cli = join(
  dirname(require.resolve('@openai/codex-win32-x64/package.json')),
  'vendor/x86_64-pc-windows-msvc/bin/codex.exe',
).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')

function accountEnvironment() {
  const env = { ...process.env }
  // The text assistant uses the user's Codex ChatGPT login, never an inherited API key.
  for (const key of [
    'CODEX_API_KEY',
    'OPENAI_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'OPENAI_FEDERATION_RULE_ID',
    'OPENAI_IDENTITY_TOKEN_FILE',
    'OPENAI_BASE_URL',
  ])
    delete env[key]
  return env
}

async function command(args: string[], input?: string, timeoutMs = 300000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cli, args, {
      windowsHide: true,
      env: accountEnvironment(),
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = '',
      timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (part: string) => {
      stdout += part
      if (stdout.length > 2000000) child.kill()
    })
    child.stderr?.on('data', (part: string) => {
      stderr = (stderr + part).slice(-4000)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error('ChatGPT 回复超时，请稍后手动重试。'))
      else resolve({ code, stdout, stderr })
    })
    if (input !== undefined) {
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(input)
    }
  })
}

export function codexFinalMessage(jsonl: string) {
  let final = ''
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'item.completed' && event.item?.type === 'agent_message')
        final = event.item.text
    } catch {
      /* Ignore non-event CLI output. */
    }
  }
  return final
}

function codexFailure(jsonl: string) {
  let failure = ''
  for (const line of jsonl.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line)
      if (event.type === 'turn.failed') failure = String(event.error?.message || '')
      else if (event.type === 'error') failure = String(event.message || '')
    } catch {
      /* Ignore non-event CLI output. */
    }
  }
  return failure.slice(0, 400)
}

export class CodexText {
  private busy = false
  constructor(private store: Store) {}

  async connected() {
    const result = await command(['login', 'status'], undefined, 10000)
    return result.code === 0 && /Logged in using ChatGPT/i.test(result.stdout + result.stderr)
  }

  async login() {
    const result = await command(['login'], undefined, 300000)
    if (result.code !== 0 || !(await this.connected()))
      throw new Error('ChatGPT 账号授权未完成，请重试。')
  }

  async generate(
    prompt: string,
    schema?: Record<string, unknown>,
    options?: { workingDirectory?: string; images?: string[] },
  ) {
    if (this.busy) throw new Error('已有一轮 AI 对话正在生成，请等待完成。')
    this.busy = true
    const workspace = options?.workingDirectory || join(this.store.root, 'codex-text-workspace')
    const schemaPath = schema ? join(workspace, `response-${randomUUID()}.json`) : undefined
    try {
      if (!(await this.connected())) throw new Error('请先在连接与设置中授权 ChatGPT 账号。')
      await mkdir(workspace, { recursive: true })
      if (schemaPath) await writeFile(schemaPath, JSON.stringify(schema), 'utf8')
      const args = [
        'exec',
        '--json',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--cd',
        workspace,
        ...(options?.images || []).flatMap((file) => ['--image', file]),
        '--config',
        'approval_policy="never"',
        '--config',
        'web_search="disabled"',
        ...(schemaPath ? ['--output-schema', schemaPath] : []),
        '-',
      ]
      const result = await command(args, prompt)
      const final = codexFinalMessage(result.stdout)
      if (result.code !== 0 || !final)
        throw new Error(
          `ChatGPT 生成失败${result.code === null ? '' : `（${result.code}）`}${codexFailure(result.stdout) ? `：${codexFailure(result.stdout)}` : '。请检查登录和网络后手动重试。'}`,
        )
      return final
    } finally {
      if (schemaPath) await unlink(schemaPath).catch(() => undefined)
      this.busy = false
    }
  }
}
