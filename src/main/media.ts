import { mkdir, readFile, writeFile, copyFile, rename, stat, rm, mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { zip, unzip, strToU8, strFromU8 } from 'fflate'
import { Store, inside } from './store'
import { projectSchema, type Asset, type Media, type Project } from '../shared/schema'
import { escapeHtml, toSrt } from '../shared/director'

const extensions = {
  image: ['.png', '.jpg', '.jpeg', '.webp'],
  video: ['.mp4', '.webm', '.mov'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg'],
}
export function mediaKind(file: string): 'image' | 'video' | 'audio' {
  const ext = extname(file).toLowerCase()
  for (const [kind, list] of Object.entries(extensions))
    if (list.includes(ext)) return kind as 'image' | 'video' | 'audio'
  throw new Error(
    '不支持此素材格式。图片支持 PNG/JPG/WebP，视频支持 MP4/WebM/MOV，音频支持 MP3/WAV/M4A。',
  )
}
export function activate(p: Project, m: Media) {
  const shot = p.shots.find((s) => s.id === m.ownerId),
    asset = p.assets.find((a) => a.id === m.ownerId)
  if (asset && m.slot === 'reference') {
    asset.selectedMediaId = m.id
    for (const linked of p.shots.filter((shot) => shot.assetIds.includes(asset.id)))
      linked.stale = !!linked.videoMediaId
    return
  }
  if (!shot) return
  if (m.slot === 'first') {
    shot.firstMediaId = m.id
    shot.stale = !!shot.videoMediaId
  }
  if (m.slot === 'last') {
    shot.lastMediaId = m.id
    shot.stale = !!shot.videoMediaId
  }
  if (m.slot === 'video') {
    shot.videoMediaId = m.id
    shot.stale = false
    const episodeShots = p.shots.filter((item) => item.episodeId === shot.episodeId)
    for (const next of episodeShots.slice(episodeShots.findIndex((item) => item.id === shot.id) + 1))
      if (next.videoMediaId) next.stale = true
  }
  if (m.slot === 'audio') shot.audioMediaId = m.id
}
export async function importMedia(
  store: Store,
  projectId: string,
  ownerId: string,
  slot: Media['slot'],
  file: string,
  prompt = '',
  taskId?: string,
  newAsset?: Asset,
) {
  const p = store.project(projectId)
  if (newAsset && (newAsset.id !== ownerId || slot !== 'reference'))
    throw new Error('素材类型与当前插槽不匹配')
  if (
    !p.shots.some((s) => s.id === ownerId) &&
    !p.assets.some((a) => a.id === ownerId) &&
    newAsset?.id !== ownerId
  )
    throw new Error('素材所属镜头或资产已不存在')
  const kind = mediaKind(file)
  if (
    (['first', 'last', 'reference'].includes(slot) && kind !== 'image') ||
    (slot === 'video' && kind !== 'video') ||
    (slot === 'audio' && kind !== 'audio')
  )
    throw new Error('素材类型与当前插槽不匹配')
  if ((await stat(file)).size > 1024 * 1024 * 1024) throw new Error('单个素材不能超过 1 GB')
  const id = randomUUID(),
    relative = `media/${id}${extname(file).toLowerCase()}`
  await mkdir(store.file(projectId, 'media'), { recursive: true })
  const destination = store.file(projectId, relative)
  await copyFile(file, destination)
  const m: Media = {
    id,
    kind,
    slot,
    ownerId,
    name: basename(file).slice(0, 200),
    file: relative,
    prompt,
    taskId,
    createdAt: new Date().toISOString(),
  }
  try {
    store.update(projectId, (p) => {
      if (newAsset) {
        if (p.assets.some((asset) => asset.id === newAsset.id)) throw new Error('资产已存在')
        p.assets.push(newAsset)
      }
      p.media.push(m)
      activate(p, m)
    })
  } catch (error) {
    await rm(destination, { force: true })
    throw error
  }
  return m
}
export async function downloadVideo(
  store: Store,
  projectId: string,
  url: string,
  signal?: AbortSignal,
) {
  let current = new URL(url)
  for (let redirects = 0; redirects < 4; redirects++) {
    if (
      current.protocol !== 'https:' ||
      current.username ||
      current.password ||
      !(
        current.hostname.endsWith('.runninghub.ai') ||
        current.hostname.endsWith('.runninghub.cn') ||
        current.hostname.endsWith('.xiaoyaoyou.com')
      )
    )
      throw new Error('视频下载域名未经批准，请从 RunningHub 下载结果后手动导入。')
    const res = await fetch(current, {
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(300000)])
        : AbortSignal.timeout(300000),
    })
    if (res.status >= 300 && res.status < 400) {
      current = new URL(res.headers.get('location') || '', current)
      continue
    }
    if (!res.ok || !res.body) throw new Error(`视频下载失败 HTTP ${res.status}`)
    const length = Number(res.headers.get('content-length') || 0)
    if (length > 1024 * 1024 * 1024) throw new Error('结果超过 1 GB，请手动下载')
    const ext = extname(current.pathname).toLowerCase()
    if (!extensions.video.includes(ext)) throw new Error('此工作流未返回 MP4/WebM/MOV 视频')
    const file = store.file(projectId, `downloads/${randomUUID()}${ext}`)
    await mkdir(store.file(projectId, 'downloads'), { recursive: true })
    const { open } = await import('node:fs/promises'),
      handle = await open(file + '.part', 'w')
    const reader = res.body.getReader()
    try {
      let total = 0
      while (true) {
        const { value: chunk, done } = await reader.read()
        if (done) break
        total += chunk.byteLength
        if (total > 1024 * 1024 * 1024) throw new Error('下载超过 1 GB 限制')
        await handle.write(chunk)
      }
    } catch (e) {
      await reader.cancel().catch(() => {})
      await handle.close()
      await rm(file + '.part', { force: true })
      throw e
    } finally {
      reader.releaseLock()
    }
    await handle.close()
    await rename(file + '.part', file)
    return file
  }
  throw new Error('下载重定向次数过多')
}
export async function exportArchive(store: Store, id: string, target: string) {
  const p = store.project(id),
    entries: Record<string, Uint8Array> = {
      'project.json': strToU8(JSON.stringify(p, null, 2)),
      'manifest.json': strToU8(
        JSON.stringify({
          format: 'director-desk',
          version: 1,
          createdAt: new Date().toISOString(),
          note: '不包含账号、Key 或浏览器登录数据。任务仅供溯源，不会在导入时自动运行。',
        }),
      ),
      'tasks.json': strToU8(JSON.stringify(store.jobs().filter((j) => j.projectId === id))),
    }
  let size = 0
  for (const m of p.media) {
    const f = store.file(id, m.file)
    size += (await stat(f)).size
    if (size > 512 * 1024 * 1024)
      throw new Error('当前 ZIP 存档上限 512 MB；请使用“打开项目目录”备份大型项目。')
    entries[m.file] = new Uint8Array(await readFile(f))
  }
  for (const episode of p.episodes)
    for (const turn of episode.scriptChat)
      for (const attachment of turn.attachments || []) {
        if (entries[attachment.file]) continue
        const file = store.file(id, attachment.file)
        size += (await stat(file)).size
        if (size > 512 * 1024 * 1024)
          throw new Error('当前 ZIP 存档上限 512 MB；请使用“打开项目目录”备份大型项目。')
        entries[attachment.file] = new Uint8Array(await readFile(file))
      }
  const data = await new Promise<Uint8Array>((yes, no) =>
    zip(entries, { level: 0 }, (err, data) => (err ? no(err) : yes(data))),
  )
  await writeFile(target + '.partial', data)
  await rename(target + '.partial', target)
}
export async function restoreArchive(store: Store, file: string) {
  if ((await stat(file)).size > 600 * 1024 * 1024) throw new Error('存档太大，上限 600 MB')
  let total = 0,
    invalid = false
  const buffer = new Uint8Array(await readFile(file))
  const data = await new Promise<Record<string, Uint8Array>>((yes, no) =>
    unzip(
      buffer,
      {
        filter: (entry) => {
          total += entry.originalSize
          const safe =
            /^(project\.json|manifest\.json|tasks\.json|media\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|mp4|mov|webm|wav|mp3|m4a|aac|ogg)|chat\/[a-zA-Z0-9_-]{1,100})$/.test(
              entry.name,
            )
          if (!safe || total > 512 * 1024 * 1024) invalid = true
          return safe && !invalid
        },
      },
      (err, result) => (err ? no(err) : yes(result)),
    ),
  )
  if (invalid) throw new Error('存档包含不安全路径、未知文件或解压后超过 512 MB')
  if (!data['project.json'] || !data['manifest.json'])
    throw new Error('不是 Muweave / Director Desk 存档')
  const manifest = JSON.parse(strFromU8(data['manifest.json']))
  if (manifest.format !== 'director-desk' || manifest.version !== 1)
    throw new Error('不支持此存档版本')
  const p = projectSchema.parse(JSON.parse(strFromU8(data['project.json'])))
  p.id = randomUUID()
  p.title = `${p.title.slice(0, 190)} · 导入`
  p.revision = 0
  p.createdAt = new Date().toISOString()
  for (const m of p.media) {
    if (!/^media\/[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(m.file) || !data[m.file])
      throw new Error('存档素材缺失或路径不安全')
  }
  for (const episode of p.episodes)
    for (const turn of episode.scriptChat)
      for (const attachment of turn.attachments || [])
        if (!data[attachment.file]) throw new Error('存档附件缺失')
  const dir = store.dir(p.id)
  try {
    await mkdir(join(dir, 'media'), { recursive: true })
    for (const m of p.media) await writeFile(inside(dir, m.file), data[m.file])
    await mkdir(join(dir, 'chat'), { recursive: true })
    for (const episode of p.episodes)
      for (const turn of episode.scriptChat)
        for (const attachment of turn.attachments || [])
          await writeFile(inside(dir, attachment.file), data[attachment.file])
    store.save(p)
  } catch (e) {
    await rm(dir, { recursive: true, force: true })
    throw e
  }
  return p
}

export function ffmpegBinaries(resourcesPath?: string) {
  const directory = resourcesPath
    ? join(resourcesPath, 'ffmpeg')
    : resolve(dirname(fileURLToPath(import.meta.url)), '../..', 'vendor/ffmpeg')
  const ffmpeg = join(directory, 'ffmpeg.exe'),
    ffprobe = join(directory, 'ffprobe.exe')
  if (existsSync(ffmpeg) && existsSync(ffprobe)) return { ffmpeg, ffprobe }
  if (resourcesPath) throw new Error('应用内 FFmpeg 文件缺失，请重新安装软件。')
  return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }
}
export async function extractLastFrame(input: string, output: string, resourcesPath?: string) {
  const { ffmpeg } = ffmpegBinaries(resourcesPath)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-sseof', '-0.5', '-i', input,
      '-vf', 'reverse', '-frames:v', '1', '-update', '1', output,
    ], { windowsHide: true, shell: false })
    let error = ''
    const timer = setTimeout(() => child.kill(), 60000)
    child.stderr.on('data', (part) => { error = (error + part).slice(-1000) })
    child.once('error', (cause) => { clearTimeout(timer); reject(cause) })
    child.once('close', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error(`无法提取上一镜头末帧：${error || `FFmpeg ${code}`}`))
    })
  })
}
export class Exporter {
  child: ChildProcess | null = null
  busy = false
  cancelled = false
  constructor(private resourcesPath?: string) {}
  cancel() {
    this.cancelled = true
    this.child?.kill()
  }
  private run(binary: string, args: string[], capture = false): Promise<string> {
    if (this.cancelled) return Promise.reject(new Error('已取消导出'))
    return new Promise((yes, no) => {
      const proc = spawn(binary, args, { windowsHide: true, shell: false })
      this.child = proc
      let output = '',
        errors = ''
      const timer = setTimeout(() => proc.kill(), 20 * 60 * 1000)
      proc.stdout.on('data', (b) => {
        if (capture) output = (output + b).slice(-200000)
      })
      proc.stderr.on('data', (b) => {
        errors = (errors + b).slice(-6000)
      })
      proc.once('error', (e) => {
        clearTimeout(timer)
        this.child = null
        no(new Error(`无法启动 ${basename(binary)}：${e.message}。`))
      })
      proc.once('close', (code) => {
        clearTimeout(timer)
        this.child = null
        code === 0
          ? yes(output)
          : no(new Error(this.cancelled ? '已取消导出' : `视频处理失败：${errors.slice(-2000)}`))
      })
    })
  }
  async episode(
    store: Store,
    projectId: string,
    episodeId: string,
    format: 'mp4' | 'srt' | 'html',
    target: string,
  ) {
    if (this.busy) throw new Error('已有导出任务，请稍候')
    this.busy = true
    this.cancelled = false
    let temp = ''
    try {
      const p = store.project(projectId),
        shots = p.shots.filter((s) => s.episodeId === episodeId)
      if (!shots.length) throw new Error('当前集没有镜头')
      if (format === 'srt') {
        await writeFile(target, '\uFEFF' + toSrt(shots), 'utf8')
        return
      }
      if (format === 'html') {
        const rows = await Promise.all(
          shots.map(async (s, i) => {
            const m = p.media.find((m) => m.id === s.firstMediaId)
            const img = m
              ? `<img src="data:image/${extname(m.file).slice(1)};base64,${(await readFile(store.file(p.id, m.file))).toString('base64')}">`
              : ''
            return `<article><span>${String(i + 1).padStart(2, '0')} / ${s.duration}s · ${escapeHtml(s.size)} · ${escapeHtml(s.camera)}</span><h2>${escapeHtml(s.title)}</h2>${img}<p>${escapeHtml(s.action)}</p><blockquote>${escapeHtml(s.dialogue)}</blockquote></article>`
          }),
        )
        await writeFile(
          target,
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(p.title)}</title><style>body{max-width:1100px;margin:60px auto;padding:0 24px;font:16px/1.7 system-ui;color:#292927;background:#faf9f6}main{display:grid;grid-template-columns:1fr 1fr;gap:24px}article{background:white;border:1px solid #ddd;border-radius:14px;padding:24px;break-inside:avoid}img{width:100%;aspect-ratio:16/9;object-fit:contain}span{color:#777;font-size:13px}blockquote{margin:16px 0;border-left:2px solid #aaa;padding-left:16px}@media print{body{margin:0}article{page-break-inside:avoid}}</style><h1>${escapeHtml(p.title)}</h1><p>${escapeHtml(p.episodes.find((e) => e.id === episodeId)?.title || '')} · 导演分镜表 · ${p.aspect}</p><main>${rows.join('')}</main></html>`,
        )
        return
      }
      if (shots.some((s) => !s.videoMediaId)) throw new Error('请为每个镜头选择视频后再导出 MP4')
      const { ffmpeg, ffprobe } = ffmpegBinaries(this.resourcesPath)
      await mkdir(store.file(p.id, 'exports'), { recursive: true })
      temp = await mkdtemp(store.file(p.id, 'exports/render-'))
      const [w, h] =
        p.aspect === '9:16' ? [1080, 1920] : p.aspect === '1:1' ? [1080, 1080] : [1920, 1080]
      for (let i = 0; i < shots.length; i++) {
        if (this.cancelled) throw new Error('已取消导出')
        const s = shots[i],
          video = p.media.find((m) => m.id === s.videoMediaId),
          audio = p.media.find((m) => m.id === s.audioMediaId)
        if (!video) throw new Error(`${s.title} 视频素材缺失`)
        const input = store.file(p.id, video.file)
        const info = JSON.parse(
          await this.run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', input], true),
        ) as { streams: { codec_type: string }[] }
        const args = ['-hide_banner', '-y', '-i', input]
        if (audio) args.push('-i', store.file(p.id, audio.file))
        else if (!info.streams.some((s) => s.codec_type === 'audio'))
          args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')
        args.push(
          '-map',
          '0:v:0',
          '-map',
          audio || !info.streams.some((s) => s.codec_type === 'audio') ? '1:a:0' : '0:a:0',
          '-vf',
          `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=${s.duration}`,
          '-af',
          'apad',
          '-t',
          String(s.duration),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-ar',
          '48000',
          '-ac',
          '2',
          join(temp, `${i}.mp4`),
        )
        await this.run(ffmpeg, args)
      }
      await writeFile(join(temp, 'list.txt'), shots.map((_, i) => `file '${i}.mp4'`).join('\n'))
      await this.run(ffmpeg, [
        '-hide_banner',
        '-y',
        '-f',
        'concat',
        '-safe',
        '1',
        '-i',
        join(temp, 'list.txt'),
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        join(temp, 'episode.mp4'),
      ])
      await copyFile(join(temp, 'episode.mp4'), target)
      await writeFile(target.replace(/\.mp4$/i, '') + '.srt', '\uFEFF' + toSrt(shots), 'utf8')
    } finally {
      this.busy = false
      this.child = null
      if (temp) await rm(temp, { recursive: true, force: true })
    }
  }
}
