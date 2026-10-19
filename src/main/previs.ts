import { mkdtemp, writeFile, rm, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { Store, inside } from './store'
import { ffmpegBinaries, importMedia } from './media'
import { previsFrameSchema, previsSource, type PrevisSource } from '../shared/previs'

type Session = {
  id: string
  projectId: string
  shotId: string
  dir: string
  source: PrevisSource
  format: 'image' | 'video'
  width: number
  height: number
  count: number
  next: number
  bytes: number
  busy: boolean
  child?: ChildProcess
  timer: ReturnType<typeof setTimeout>
}
export class PrevisExporter {
  private session?: Session
  private starting = false
  constructor(
    private store: Store,
    private resourcesPath?: string,
  ) {}
  async start(projectId: string, shotId: string, format: 'image' | 'video') {
    if (this.session || this.starting) throw new Error('已有预演正在导出，请完成或取消后继续')
    this.starting = true
    try {
      const p = this.store.project(projectId),
        shot = p.shots.find((shot) => shot.id === shotId)
      const scene = p.previsScenes?.find((scene) => scene.id === shot?.previs?.sceneId)
      if (!shot?.previs || !scene) throw new Error('请先保存预演')
      const [width, height] =
        p.aspect === '9:16' ? [480, 854] : p.aspect === '1:1' ? [640, 640] : [854, 480]
      const dir = await mkdtemp(join(this.store.dir(projectId), 'previs-render-'))
      const id = randomUUID()
      const timer = setTimeout(() => {
        void this.cancel(id)
      }, 300000)
      timer.unref()
      this.session = {
        id,
        projectId,
        shotId,
        dir,
        format,
        source: previsSource(scene, shot.previs, shot.duration, p.aspect),
        width,
        height,
        count: format === 'image' ? 1 : Math.ceil(shot.duration * 24),
        next: 0,
        bytes: 0,
        busy: false,
        timer,
      }
      return JSON.stringify({ sessionId: id, width, height, count: this.session.count, fps: 24 })
    } finally {
      this.starting = false
    }
  }
  private get(sessionId?: string) {
    if (!sessionId || this.session?.id !== sessionId) throw new Error('预演导出会话已失效')
    return this.session
  }
  async frame(sessionId: string, index: number, input: ArrayBuffer | Uint8Array) {
    previsFrameSchema.parse({ sessionId, index })
    const s = this.get(sessionId),
      bytes = Buffer.from(input instanceof Uint8Array ? input : new Uint8Array(input))
    if (s.busy || index !== s.next || index >= s.count) throw new Error('预演帧顺序不正确')
    if (
      bytes.length < 33 ||
      bytes.length > 8 * 1024 * 1024 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) !== s.width ||
      bytes.readUInt32BE(20) !== s.height
    )
      throw new Error('预演 PNG 尺寸或格式不正确')
    if (s.bytes + bytes.length > 512 * 1024 * 1024)
      throw new Error('预演渲染超过 512 MB，请缩短镜头')
    s.busy = true
    try {
      await writeFile(join(s.dir, `${String(index).padStart(5, '0')}.png`), bytes)
      s.bytes += bytes.length
      s.next++
    } finally {
      s.busy = false
    }
    s.timer.refresh()
  }
  async finish(projectId: string, shotId: string, sessionId?: string) {
    const s = this.get(sessionId)
    if (s.projectId !== projectId || s.shotId !== shotId) throw new Error('预演导出所属镜头不匹配')
    if (s.busy || s.next !== s.count) throw new Error('预演尚未渲染完整')
    s.busy = true
    const output = join(s.dir, s.format === 'image' ? 'composition.png' : 'previs.mp4')
    try {
      if (s.format === 'image') await copyFile(join(s.dir, '00000.png'), output)
      else
        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            ffmpegBinaries(this.resourcesPath).ffmpeg,
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-y',
              '-framerate',
              '24',
              '-i',
              join(s.dir, '%05d.png'),
              '-frames:v',
              String(s.count),
              '-an',
              '-c:v',
              'libx264',
              '-preset',
              'fast',
              '-crf',
              '20',
              '-pix_fmt',
              'yuv420p',
              '-movflags',
              '+faststart',
              output,
            ],
            { windowsHide: true, shell: false },
          )
          s.child = child
          let error = ''
          child.stderr.on('data', (data: Buffer) => {
            error = (error + data.toString()).slice(-2000)
          })
          child.once('error', reject)
          child.once('close', (code) =>
            code === 0 ? resolve() : reject(new Error(error || '预演编码已终止；请检查 FFmpeg')),
          )
        })
      this.get(sessionId)
      return await importMedia(
        this.store,
        projectId,
        shotId,
        s.format === 'image' ? 'composition' : 'previs',
        output,
        '3D 预演：仅参考构图、人物走位、动作和运镜；人物外观使用正式资产。',
        undefined,
        undefined,
        undefined,
        s.source,
      )
    } finally {
      await this.cancel(s.id)
    }
  }
  async cancel(sessionId?: string) {
    const s = this.session
    if (!s || (sessionId && sessionId !== s.id)) return
    this.session = undefined
    clearTimeout(s.timer)
    if (s.child && s.child.exitCode === null) {
      const closed = new Promise<void>((resolve) => s.child!.once('close', () => resolve()))
      s.child.kill()
      await closed
    }
    // Only remove the generated directory resolved below this project's root.
    const dir = inside(this.store.dir(s.projectId), s.dir)
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}
