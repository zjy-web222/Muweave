import { BrowserWindow, clipboard, dialog, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { Store } from './store'
import { importMedia } from './media'

export class ChatGPT {
  window: BrowserWindow | null = null
  private target: {
    projectId: string
    ownerId: string
    slot: 'first' | 'last' | 'reference'
    prompt: string
  } | null = null
  private configured = false
  constructor(
    private store: Store,
    private changed: () => void,
  ) {}
  open() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show()
      this.window.focus()
      return
    }
    const isolated = session.fromPartition('persist:chatgpt-director')
    isolated.setPermissionRequestHandler((_wc, _p, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    if (!this.configured) {
      this.configured = true
      isolated.on('will-download', (_event, item) => {
        const target = this.target ? { ...this.target } : null
        if (
          !target ||
          !['.png', '.jpg', '.jpeg', '.webp'].includes(extname(item.getFilename()).toLowerCase())
        )
          return
        const file = this.store.file(
          target.projectId,
          `downloads/chatgpt-${randomUUID()}${extname(item.getFilename())}`,
        )
        // The pending download is bound to the shot selected when the download started.
        void mkdir(this.store.file(target.projectId, 'downloads'), { recursive: true })
        item.setSavePath(file)
        item.once('done', async (_e, state) => {
          if (state !== 'completed') return
          try {
            const p = this.store.project(target.projectId),
              english = this.store.config().locale === 'en',
              owner =
                p.shots.find((s) => s.id === target.ownerId)?.title ||
                p.assets.find((a) => a.id === target.ownerId)?.name ||
                (english ? 'Original media' : '原素材')
            const choice = await dialog.showMessageBox({
              type: 'question',
              title: english ? 'Import ChatGPT image' : '导入 ChatGPT 图片',
              message: english
                ? `Add the downloaded image to “${owner}”?`
                : `将下载图片归入「${owner}」？`,
              detail: english
                ? 'Confirm this image belongs to the current generation task. You can also keep the file and import it later.'
                : '确认该图片属于当前生成任务。你也可以保留下载文件，稍后手动导入。',
              buttons: english
                ? ['Import to current media', 'Keep file only']
                : ['导入当前素材', '仅保留文件'],
              defaultId: 0,
              cancelId: 1,
            })
            if (choice.response === 0) {
              await importMedia(
                this.store,
                target.projectId,
                target.ownerId,
                target.slot,
                file,
                target.prompt,
              )
              await rm(file, { force: true })
              this.changed()
            }
          } catch (e) {
            await dialog.showMessageBox({
              type: 'error',
              message:
                e instanceof Error
                  ? e.message
                  : this.store.config().locale === 'en'
                    ? 'Image import failed'
                    : '图片导入失败',
            })
          }
        })
      })
    }
    this.window = new BrowserWindow({
      width: 1120,
      height: 850,
      minWidth: 700,
      minHeight: 600,
      title:
        this.store.config().locale === 'en'
          ? 'ChatGPT · Sign in yourself'
          : 'ChatGPT · 由你本人登录',
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:chatgpt-director',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    })
    const allow = (url: string) => {
      try {
        const u = new URL(url)
        return (
          u.protocol === 'https:' &&
          ([
            'chatgpt.com',
            'openai.com',
            'accounts.google.com',
            'login.live.com',
            'appleid.apple.com',
            'auth0.openai.com',
          ].includes(u.hostname) ||
            u.hostname.endsWith('.chatgpt.com') ||
            u.hostname.endsWith('.openai.com'))
        )
      } catch {
        return false
      }
    }
    this.window.webContents.on('will-navigate', (event, url) => {
      if (!allow(url)) event.preventDefault()
    })
    this.window.webContents.setWindowOpenHandler(({ url }) =>
      allow(url)
        ? {
            action: 'allow',
            overrideBrowserWindowOptions: {
              autoHideMenuBar: true,
              webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
            },
          }
        : { action: 'deny' },
    )
    this.window.on('closed', () => {
      this.window = null
      this.changed()
    })
    void this.window.loadURL('https://chatgpt.com/').catch(async () => {
      if (!this.window || this.window.isDestroyed()) return
      const result = await dialog.showMessageBox(this.window, {
        type: 'warning',
        title:
          this.store.config().locale === 'en'
            ? 'ChatGPT page could not open'
            : 'ChatGPT 页面暂时无法打开',
        message:
          this.store.config().locale === 'en'
            ? 'Check your network connection. You can also generate in your usual browser and import the result.'
            : '请检查网络连接；也可以在常用浏览器生成后导入结果。',
        detail:
          this.store.config().locale === 'en'
            ? 'The prompt is still on your clipboard. This app does not bypass network restrictions or sign-in checks.'
            : '提示词仍在剪贴板中。本应用不会绕过网络限制或登录验证。',
        buttons:
          this.store.config().locale === 'en'
            ? ['Open in default browser', 'Close notice']
            : ['在默认浏览器打开', '关闭提示'],
        defaultId: 0,
        cancelId: 1,
      })
      if (result.response === 0) await shell.openExternal('https://chatgpt.com/')
    })
    this.changed()
  }
  prepare(
    projectId: string,
    ownerId: string,
    kind: string,
    prompt: string,
    slot?: 'first' | 'last' | 'reference',
  ) {
    this.store.project(projectId)
    if (kind === 'image') {
      this.target = { projectId, ownerId, slot: slot || 'first', prompt }
      void mkdir(this.store.file(projectId, 'downloads'), { recursive: true })
    } else this.target = null
    clipboard.writeText(prompt)
    this.open()
  }
  async clear() {
    this.window?.close()
    this.target = null
    await session.fromPartition('persist:chatgpt-director').clearStorageData()
    await session.fromPartition('persist:chatgpt-director').clearCache()
    this.changed()
  }
}
