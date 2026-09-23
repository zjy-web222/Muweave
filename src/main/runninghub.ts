import { readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import { type Job, type Config, type Shot } from '../shared/schema'
import { Store } from './store'
import { downloadVideo, importMedia } from './media'

const envelope = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
})
export class RejectedRequest extends Error {}
export class RunningHub {
  constructor(
    private key: () => string,
    private transport: typeof fetch = fetch,
  ) {}
  async request(site: string, path: string, body: Record<string, unknown> | FormData) {
    if (!['https://www.runninghub.ai', 'https://www.runninghub.cn'].includes(site))
      throw new Error('RunningHub 站点无效')
    const key = this.key()
    if (!key) throw new Error('请先绑定 RunningHub API Key')
    const form = body instanceof FormData
    const response = await this.transport(site + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        ...(!form ? { 'Content-Type': 'application/json' } : {}),
      },
      body: form ? body : JSON.stringify({ ...body, apiKey: key }),
      signal: AbortSignal.timeout(form ? 120000 : 45000),
      redirect: 'error',
    })
    if (!response.ok) throw new Error(`RunningHub HTTP ${response.status}`)
    const result = envelope.parse(await response.json())
    if (result.code !== 0)
      throw new RejectedRequest(
        `RunningHub ${result.code}：${(result.msg || '请求未完成').replaceAll(key, '[已隐藏]')}`,
      )
    return result.data
  }
  async workflow(c: Config) {
    if (!c.workflowId) throw new Error('请填写 workflowId')
    const result = await this.request(c.site, '/api/openapi/getJsonApiFormat', {
      workflowId: c.workflowId,
    })
    const data = z.object({ prompt: z.string() }).parse(result)
    return JSON.parse(data.prompt)
  }
  async account(c: Config) {
    return this.request(c.site, '/uc/openapi/accountStatus', { apikey: this.key() })
  }
  async upload(site: string, file: string) {
    const form = new FormData()
    form.set('apiKey', this.key())
    form.set('fileType', 'input')
    form.set('file', new Blob([await readFile(file)]), basename(file))
    return z
      .object({ fileName: z.string().min(1) })
      .parse(await this.request(site, '/task/openapi/upload', form)).fileName
  }
  async start(j: Job, nodeInfoList: { nodeId: string; fieldName: string; fieldValue: string }[]) {
    return z
      .object({
        taskId: z.union([z.string().regex(/^\d+$/), z.number().int().safe()]).transform(String),
      })
      .parse(
        await this.request(j.site, '/task/openapi/create', {
          workflowId: j.workflowId,
          nodeInfoList,
        }),
      ).taskId
  }
  async status(j: Job) {
    return z
      .string()
      .parse(await this.request(j.site, '/task/openapi/status', { taskId: j.taskId }))
      .toUpperCase()
  }
  async outputs(j: Job) {
    return z
      .array(z.object({ fileUrl: z.string().url(), fileType: z.string().optional() }))
      .parse(await this.request(j.site, '/task/openapi/outputs', { taskId: j.taskId }))
  }
  async cancel(j: Job) {
    await this.request(j.site, '/task/openapi/cancel', { taskId: j.taskId })
  }
}
export function inputsChanged(current: Shot, snapshot: Shot) {
  return ['imagePrompt', 'videoPrompt', 'firstMediaId', 'lastMediaId', 'duration', 'seed'].some(
    (k) => current[k as keyof Shot] !== snapshot[k as keyof Shot],
  )
}
export class Queue {
  private busy = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  constructor(
    private store: Store,
    private api: RunningHub,
    private changed: () => void,
  ) {}
  start() {
    for (const j of this.store.jobs()) {
      if (j.status === 'submitting') {
        j.status = j.taskId ? 'running' : 'uncertain'
        j.error = j.taskId
          ? undefined
          : '上次关闭发生在提交期间。请在 RunningHub 核实是否已产生任务，再绑定任务 ID。'
        this.store.saveJob(j)
      }
      if (j.status === 'downloading') {
        j.status = 'running'
        this.store.saveJob(j)
      }
    }
    this.timer = setInterval(() => void this.tick(), 5000)
    void this.tick()
  }
  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
  }
  enqueue(projectId: string, shotIds: string[], stopOnFailure: boolean) {
    const c = this.store.config(),
      p = this.store.project(projectId)
    if (!c.workflowId || !c.mappings.length) throw new Error('请先配置工作流 ID 与参数映射')
    const selected = [...new Set(shotIds)].map((id) => {
      const s = p.shots.find((s) => s.id === id)
      if (!s) throw new Error('镜头不存在')
      return s
    })
    for (const s of selected) {
      if (
        this.store
          .jobs()
          .some(
            (j) =>
              j.projectId === projectId &&
              j.shotId === s.id &&
              ['queued', 'submitting', 'running', 'downloading', 'uncertain', 'paused'].includes(
                j.status,
              ),
          )
      )
        throw new Error(`${s.title} 已有未完成任务，请先处理原任务`)
      for (const map of c.mappings) {
        if (map.source === 'first' && !s.firstMediaId) throw new Error(`${s.title} 缺少首帧`)
        if (map.source === 'last' && !s.lastMediaId) throw new Error(`${s.title} 缺少尾帧`)
      }
    }
    const batchId = randomUUID(),
      now = new Date().toISOString()
    for (const s of selected)
      this.store.saveJob({
        id: randomUUID(),
        projectId,
        shotId: s.id,
        batchId,
        stopOnFailure,
        status: 'queued',
        site: c.site,
        workflowId: c.workflowId,
        mappings: c.mappings,
        snapshot: structuredClone(s),
        createdAt: now,
        updatedAt: now,
        pollErrors: 0,
        outputs: [],
      })
    this.changed()
    void this.tick()
  }
  private async tick() {
    if (this.stopped) return
    const jobs = this.store.jobs(),
      c = this.store.config()
    for (const j of jobs.filter((j) => j.status === 'running' && !this.busy.has(j.id)))
      void this.poll(j)
    if (c.paused) return
    let slots =
      c.concurrency -
      jobs.filter((j) => ['submitting', 'running', 'downloading', 'uncertain'].includes(j.status))
        .length
    for (const j of jobs.filter((j) => j.status === 'queued').reverse()) {
      if (slots <= 0) break
      if (
        j.stopOnFailure &&
        jobs.some((o) => o.batchId === j.batchId && ['failed', 'uncertain'].includes(o.status))
      ) {
        j.status = 'paused'
        j.error = '同组任务失败，已暂停后续镜头'
        this.store.saveJob(j)
        this.changed()
        continue
      }
      slots--
      void this.submit(j)
    }
  }
  private save(j: Job) {
    this.store.saveJob(j)
    this.changed()
  }
  private async submit(j: Job) {
    if (this.busy.has(j.id)) return
    this.busy.add(j.id)
    let sent = false
    try {
      j.status = 'submitting'
      j.error = undefined
      this.save(j)
      const p = this.store.project(j.projectId),
        uploads: Record<string, string> = {}
      const nodeInfoList = []
      for (const m of j.mappings) {
        let value = m.value
        if (m.source === 'prompt') value = j.snapshot.videoPrompt || j.snapshot.action
        if (m.source === 'duration') value = String(j.snapshot.duration)
        if (m.source === 'seed') value = String(j.snapshot.seed)
        if (m.source === 'first' || m.source === 'last') {
          const mediaId = m.source === 'first' ? j.snapshot.firstMediaId : j.snapshot.lastMediaId,
            media = p.media.find((m) => m.id === mediaId)
          if (!media) throw new Error(`缺少${m.source === 'first' ? '首' : '尾'}帧素材`)
          value =
            uploads[media.id] ||
            (uploads[media.id] = await this.api.upload(j.site, this.store.file(p.id, media.file)))
        }
        nodeInfoList.push({ nodeId: m.nodeId, fieldName: m.fieldName, fieldValue: value })
      }
      if (this.store.job(j.id).status === 'cancelled') return
      sent = true
      j.taskId = await this.api.start(j, nodeInfoList)
      j.status = 'running'
      this.save(j)
    } catch (e) {
      j.status = sent && !(e instanceof RejectedRequest) ? 'uncertain' : 'failed'
      j.error = e instanceof Error ? e.message : '提交失败'
      this.save(j)
    } finally {
      this.busy.delete(j.id)
    }
  }
  private async poll(j: Job) {
    this.busy.add(j.id)
    try {
      const status = await this.api.status(j)
      if (this.store.job(j.id).status === 'cancelled') return
      if (['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status)) {
        j.status = status.startsWith('CANCEL') ? 'cancelled' : 'failed'
        j.error = `远端任务状态：${status}`
        this.save(j)
        return
      }
      if (status !== 'SUCCESS') {
        if (!['RUNNING', 'QUEUED', 'PENDING'].includes(status))
          throw new Error(`未知远端状态：${status}`)
        j.pollErrors = 0
        if (j.error) {
          j.error = undefined
          this.save(j)
        }
        return
      }
      j.status = 'downloading'
      this.save(j)
      const outputs = await this.api.outputs(j)
      const videos = outputs.filter(
        (o) =>
          /\.(mp4|webm|mov)(\?|$)/i.test(o.fileUrl) ||
          ['mp4', 'webm', 'mov', 'video'].includes(o.fileType || ''),
      )
      if (!videos.length) throw new Error('工作流没有返回视频，请检查视频输出节点')
      for (const output of videos) {
        if (j.outputs.includes(output.fileUrl)) continue
        const existing = this.store
          .project(j.projectId)
          .media.find((m) => m.taskId === `${j.taskId}:${output.fileUrl}`)
        if (!existing) {
          const file = await downloadVideo(this.store, j.projectId, output.fileUrl)
          try {
            await importMedia(
              this.store,
              j.projectId,
              j.shotId,
              'video',
              file,
              j.snapshot.videoPrompt,
              `${j.taskId}:${output.fileUrl}`,
            )
          } finally {
            await rm(file, { force: true })
          }
        }
        j.outputs.push(output.fileUrl)
        this.save(j)
      }
      this.store.update(j.projectId, (p) => {
        const s = p.shots.find((s) => s.id === j.shotId)
        if (s) s.stale = inputsChanged(s, j.snapshot)
      })
      j.status = 'succeeded'
      j.error = undefined
      j.pollErrors = 0
      this.save(j)
    } catch (e) {
      if (this.store.job(j.id).status === 'cancelled') return
      j.pollErrors++
      j.error =
        (e instanceof Error ? e.message : '查询失败') + '；保留任务 ID，可继续查询，不会重新计费。'
      j.status = j.pollErrors >= 5 ? 'paused' : 'running'
      this.save(j)
    } finally {
      this.busy.delete(j.id)
    }
  }
  async action(id: string, action: 'cancel' | 'retry' | 'resume' | 'attach', taskId?: string) {
    const j = this.store.job(id)
    if (this.busy.has(id)) throw new Error('任务正在同步或下载，请稍后重试')
    this.busy.add(id)
    try {
      if (action === 'cancel') {
        if (j.status === 'submitting')
          throw new Error('正在提交；请等返回任务 ID 后再取消，避免任务状态不确定')
        if (j.taskId && ['running', 'paused', 'downloading'].includes(j.status))
          await this.api.cancel(j)
        j.status = 'cancelled'
        j.error = '已取消；已发生的远端费用以 RunningHub 为准'
      }
      if (action === 'attach') {
        if (!taskId) throw new Error('请输入 RunningHub 任务 ID')
        j.taskId = taskId
        j.status = 'running'
        j.pollErrors = 0
        j.error = undefined
      }
      if (action === 'resume') {
        if (j.status !== 'paused') throw new Error('只有暂停任务可以继续')
        j.status = j.taskId ? 'running' : 'queued'
        j.pollErrors = 0
        j.error = undefined
      }
      if (action === 'retry') {
        if (j.status !== 'failed' && j.status !== 'cancelled')
          throw new Error('仅失败或已取消任务可以重新提交；待确认任务请先核实远端状态')
        if (
          this.store
            .jobs()
            .some(
              (o) =>
                o.id !== j.id &&
                o.shotId === j.shotId &&
                ['queued', 'running', 'submitting', 'downloading', 'uncertain', 'paused'].includes(
                  o.status,
                ),
            )
        )
          throw new Error('该镜头已有未完成任务')
        j.taskId = undefined
        j.status = 'queued'
        j.outputs = []
        j.error = undefined
        j.pollErrors = 0
      }
      this.save(j)
    } finally {
      this.busy.delete(id)
    }
    void this.tick()
  }
}
