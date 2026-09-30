import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { zipSync, strToU8 } from 'fflate'
import { Store, createProject, inside } from '../src/main/store'
import { codexFinalMessage } from '../src/main/codex'
import { prepareChatFile } from '../src/main/chat-files'
import { exportArchive, restoreArchive, importMedia, Exporter } from '../src/main/media'
import {
  buildScriptChatPrompt,
  buildPrompt,
  parseDirector,
  storyboardImport,
  parseScriptChatReply,
  toSrt,
  escapeHtml,
} from '../src/shared/director'
import { Queue, RunningHub, RejectedRequest, inputsChanged, prepareVideoWorkflow } from '../src/main/runninghub'
import {
  blankShot,
  commandSchema,
  defaultConfig,
  videoWorkflow,
  projectSchema,
  type Job,
} from '../src/shared/schema'

let root: string, store: Store
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'director-unit-'))
  store = new Store(root)
})
afterEach(async () => {
  vi.useRealTimers()
  store.close()
  await rm(root, { recursive: true, force: true })
})
describe('local project state', () => {
  it('keeps existing settings when adding the language preference', () => {
    const { locale: _locale, ...legacy } = defaultConfig
    store.set('config', { ...legacy, theme: 'dark' })
    expect(store.config()).toMatchObject({ theme: 'dark', locale: 'zh' })
    store.set('config', { ...store.config(), locale: 'en' })
    expect(store.config().locale).toBe('en')
  })
  it('uses the selected language for new project and shot defaults', () => {
    const project = createProject('My film', '16:9', false, 'en')
    expect(project.episodes[0].title).toBe('Episode 1')
    expect(blankShot(project.episodes[0].id, 'en').title).toBe('New shot')
  })
  it('creates a real editable demo without fabricated generation results', () => {
    const p = store.save(createProject('雨夜来信', '16:9', true))
    expect(p.shots).toHaveLength(6)
    expect(p.assets).toHaveLength(4)
    expect(p.media).toHaveLength(0)
    expect(store.project(p.id).title).toBe('雨夜来信')
  })
  it('persists edits and restores history while retaining newer media', () => {
    const p = store.save(createProject('A', '16:9'))
    const revision = p.revision
    store.update(p.id, (p) => {
      p.title = 'B'
    })
    expect(store.history(p.id)).toHaveLength(1)
    store.restore(p.id, revision)
    expect(store.project(p.id).title).toBe('A')
  })
  it('rejects traversal and invalid IPC arguments', () => {
    expect(() => inside(root, '../../outside')).toThrow()
    expect(() =>
      commandSchema.parse({ type: 'config', config: { ...defaultConfig, concurrency: 10 } }),
    ).toThrow()
    expect(() => commandSchema.parse({ type: 'reveal', projectId: '../../x' })).toThrow()
  })
  it('validates model JSON and calculates exact subtitle timing', () => {
    const p = createProject('A', '16:9', true)
    const data = parseDirector('```json\n{"shots":[{"title":"镜头一","duration":6}]}\n```')
    expect(data.shots?.[0].duration).toBe(6)
    expect(() => parseDirector('{"shots":[{"title":"x","duration":999}]}')).toThrow()
    const storyboard = JSON.parse(
      storyboardImport(
        '{"script":"should not replace","assets":[{"kind":"prop","name":"new"}],"shots":[{"title":"镜头一","duration":6}]}',
      ),
    )
    expect(Object.keys(storyboard)).toEqual(['shots'])
    expect(storyboard.shots).toMatchObject([{ title: '镜头一', duration: 6 }])
    expect(() => storyboardImport('{"script":"only a script"}')).toThrow('AI 未返回分镜镜头')
    expect(toSrt(p.shots)).toContain('00:00:06,000 --> 00:00:11,000')
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
  })
  it('keeps storyboard requests bounded for longer episodes', () => {
    const p = createProject('A', '16:9', false)
    p.episodes[0].script = 'A'.repeat(30000) + 'TAIL_MARKER'
    const prompt = buildPrompt(p, p.episodes[0].id, 'storyboard')
    expect(prompt).toContain('A'.repeat(30000))
    expect(prompt).not.toContain('TAIL_MARKER')
    expect(prompt).toContain('单次不超过 24 个')
  })
  it('keeps legacy episodes compatible and validates multi-turn script replies', () => {
    const p = createProject('A', '16:9')
    const legacy = { ...p, episodes: [{ id: p.episodes[0].id, title: '第一集', script: '旧剧本' }] }
    const loaded = projectSchema.parse(legacy)
    expect(loaded.episodes[0].scriptChat).toEqual([])
    loaded.episodes[0].scriptChat.push({
      id: 'turn_1',
      role: 'user',
      text: '增强冲突',
      createdAt: '2026-01-01',
    })
    const prompt = buildScriptChatPrompt(
      loaded,
      loaded.episodes[0].id,
      '修改结尾',
      '当前剧本',
      '写实',
    )
    expect(prompt).toContain('用户：增强冲突')
    expect(prompt).toContain('本轮用户要求：修改结尾')
    expect(prompt).toContain('当前剧本')
    expect(
      buildScriptChatPrompt(loaded, loaded.episodes[0].id, '', '', '写实', [
        { name: 'reference.unknown', content: '测试代号：7319', size: 12 },
      ]),
    ).toContain('测试代号：7319')
    expect(parseScriptChatReply('```json\n{"reply":"已调整","script":"新版剧本"}\n```')).toEqual({
      reply: '已调整',
      script: '新版剧本',
    })
    expect(() => parseScriptChatReply('{"reply":""}')).toThrow()
    expect(
      codexFinalMessage(
        [
          '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"reply\\":\\"初稿\\"}"}}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"reply\\":\\"最终版\\"}"}}',
        ].join('\n'),
      ),
    ).toBe('{"reply":"最终版"}')
    expect(
      commandSchema.parse({
        type: 'scriptChatGenerate',
        projectId: p.id,
        episodeId: p.episodes[0].id,
        request: '',
      }),
    ).toMatchObject({ attachmentIds: [] })
    expect(() =>
      commandSchema.parse({
        type: 'scriptChatGenerate',
        projectId: p.id,
        episodeId: p.episodes[0].id,
        request: '',
        attachmentIds: Array.from({ length: 11 }, (_, index) => `file_${index}`),
      }),
    ).toThrow()
  })
  it('extracts text from arbitrary file extensions before AI analysis', async () => {
    const file = join(root, 'reference.unknown')
    await writeFile(file, '测试代号：蓝鲸-7319。')
    const prepared = await prepareChatFile(file, 'reference.unknown', (await readFile(file)).length)
    expect(prepared.content).toContain('蓝鲸-7319')
  })
  it('extracts text from a PDF attachment', async () => {
    const parts = ['%PDF-1.4\n']
    const offsets: number[] = []
    const object = (body: string) => {
      offsets.push(Buffer.byteLength(parts.join('')))
      parts.push(`${offsets.length} 0 obj\n${body}\nendobj\n`)
    }
    const stream = 'BT /F1 12 Tf 72 720 Td (PDF_CODE_7319) Tj ET'
    object('<< /Type /Catalog /Pages 2 0 R >>')
    object('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
    object(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    )
    object(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
    object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    const xref = Buffer.byteLength(parts.join(''))
    parts.push('xref\n0 6\n0000000000 65535 f \n')
    for (const offset of offsets) parts.push(`${String(offset).padStart(10, '0')} 00000 n \n`)
    parts.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)
    const file = join(root, 'reference.pdf')
    await writeFile(file, parts.join(''))
    const prepared = await prepareChatFile(file, 'reference.pdf', (await readFile(file)).length)
    expect(prepared.content).toContain('PDF_CODE_7319')
  })
  it('archives current state and every media version without credentials', async () => {
    const p = store.save(createProject('archive', '16:9', true)),
      file = join(root, 'fixture.png')
    await writeFile(
      file,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    )
    await importMedia(store, p.id, p.shots[0].id, 'first', file)
    await importMedia(store, p.id, p.shots[0].id, 'first', file)
    await mkdir(store.file(p.id, 'chat'), { recursive: true })
    await writeFile(store.file(p.id, 'chat/reference_1'), 'file content')
    store.update(p.id, (project) => {
      project.episodes[0].scriptChat.push({
        id: 'turn_with_file',
        role: 'user',
        text: '分析附件',
        attachments: [
          { id: 'reference_1', name: 'reference.xyz', size: 12, file: 'chat/reference_1' },
        ],
        createdAt: '2026-01-01',
      })
    })
    store.set('runninghub-key', 'secret-not-for-archive')
    const target = join(root, 'project.zip')
    await exportArchive(store, p.id, target)
    expect((await readFile(target)).includes(Buffer.from('secret-not-for-archive'))).toBe(false)
    const copy = await restoreArchive(store, target)
    expect(copy.id).not.toBe(p.id)
    expect(copy.media).toHaveLength(2)
    expect(copy.episodes[0].scriptChat[0].attachments?.[0].name).toBe('reference.xyz')
    expect(await readFile(store.file(copy.id, 'chat/reference_1'), 'utf8')).toBe('file content')
    expect(copy.shots[0].firstMediaId).toBe(copy.media[1].id)
    expect(store.jobs()).toHaveLength(0)
  })
  it('rejects malicious ZIP paths without writing outside project root', async () => {
    const file = join(root, 'bad.zip')
    await writeFile(file, zipSync({ '../escape.txt': strToU8('bad') }))
    await expect(restoreArchive(store, file)).rejects.toThrow('不安全')
  })
  it('exports real MP4, audio and subtitles with FFmpeg', async () => {
    const p = createProject('export test', '16:9', true)
    p.shots = p.shots.slice(0, 3).map((s) => ({ ...s, duration: 1 }))
    store.save(p)
    const video = join(root, 'silent.mp4'),
      audio = join(root, 'voice.wav'),
      withAudio = join(root, 'with-audio.mp4')
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x596551:s=320x180:r=30',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        video,
      ],
      { windowsHide: true },
    )
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-c:a',
        'pcm_s16le',
        audio,
      ],
      { windowsHide: true },
    )
    execFileSync(
      'ffmpeg',
      ['-v', 'error', '-y', '-i', video, '-i', audio, '-c:v', 'copy', '-c:a', 'aac', withAudio],
      { windowsHide: true },
    )
    await importMedia(store, p.id, p.shots[0].id, 'video', video)
    await importMedia(store, p.id, p.shots[0].id, 'audio', audio)
    await importMedia(store, p.id, p.shots[1].id, 'video', withAudio)
    await importMedia(store, p.id, p.shots[2].id, 'video', video)
    const target = join(root, 'episode.mp4'),
      exporter = new Exporter()
    await exporter.episode(store, p.id, p.episodes[0].id, 'mp4', target)
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', target],
        { encoding: 'utf8', windowsHide: true },
      ),
    )
    expect(probe.streams.some((s: { codec_type: string }) => s.codec_type === 'audio')).toBe(true)
    expect(probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video').width).toBe(
      1920,
    )
    expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(3)
    expect(Number(probe.format.duration)).toBeLessThan(3.2)
    expect(await readFile(join(root, 'episode.srt'), 'utf8')).toContain(
      '00:00:01,000 --> 00:00:02,000',
    )
    await exporter.episode(store, p.id, p.episodes[0].id, 'html', join(root, 'board.html'))
    expect(await readFile(join(root, 'board.html'), 'utf8')).toContain('导演分镜表')
  }, 60000)
})
function makeJob(status: Job['status'] = 'queued'): Job {
  const p = store.save(createProject('queue', '16:9', true)),
    now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    projectId: p.id,
    shotId: p.shots[0].id,
    status,
    site: defaultConfig.site,
    workflowId: '123',
    mappings: [{ nodeId: '6', fieldName: 'text', source: 'prompt', value: '' }],
    snapshot: p.shots[0],
    createdAt: now,
    updatedAt: now,
    pollErrors: 0,
    outputs: [],
    stopOnFailure: false,
  }
}
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
describe('safe paid-job lifecycle', () => {
  it('uses the built-in China workflow and Plus for new jobs even with old settings', () => {
    const p = store.save(createProject('fixed workflow', '16:9', true))
    store.set('config', { ...defaultConfig, site: 'https://www.runninghub.ai', workflowId: '123', paused: true })
    const q = new Queue(store, {} as RunningHub, () => {})
    q.enqueue(p.id, [p.shots[0].id], false)
    expect(store.jobs()[0]).toMatchObject({
      site: videoWorkflow.site,
      workflowId: videoWorkflow.id,
      instanceType: 'plus',
      aspect: '16:9',
      mappings: [],
    })
  })
  it('prepares prompt, frame count, aspect, seed, and optional image inputs', () => {
    const shot = { ...blankShot('episode'), videoPrompt: 'Rain over a city', duration: 5, seed: 77 }
    const source = {
      '15': { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '9:16 (Portrait Widescreen)' } },
      '16': { class_type: 'RandomNoise', inputs: { noise_seed: 1 } },
      '17': { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: 'old', length: ['14', 0], width: ['15', 0], height: ['15', 1] } },
    }
    const result = prepareVideoWorkflow(source, shot, '16:9', { first: 'first.png', last: 'last.png' })
    expect(result['17'].inputs).toMatchObject({ prompt: 'Rain over a city', length: 124, first_frame: ['18', 0], last_frame: ['19', 0] })
    expect(result['15'].inputs.aspect_ratio).toBe('16:9 (Widescreen)')
    expect(result['16'].inputs.noise_seed).toBe(77)
    expect(result['18']).toMatchObject({ class_type: 'LoadImage', inputs: { image: 'first.png' } })
    expect(source['17'].inputs.prompt).toBe('old')
    expect(() => prepareVideoWorkflow({}, shot, '16:9')).toThrow('视频节点已变化')
  })
  it('sends the complete workflow as JSON and selects Plus', async () => {
    const j = makeJob()
    j.instanceType = 'plus'
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { taskId: '987' } }), { status: 200 }))
    const api = new RunningHub(() => 'local-test-key', transport)
    expect(await api.start(j, [], { '17': { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: 'test' } } })).toBe('987')
    const [url, options] = transport.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(url).toBe(`${j.site}/task/openapi/create`)
    expect(body).toMatchObject({ instanceType: 'plus', workflowId: j.workflowId, apiKey: 'local-test-key' })
    expect(JSON.parse(body.workflow)['17'].inputs.prompt).toBe('test')
  })
  it('never resubmits an interrupted submission when restarting', async () => {
    const j = makeJob('submitting')
    store.saveJob(j)
    const api = { start: vi.fn(), status: vi.fn() } as unknown as RunningHub,
      q = new Queue(store, api, () => {})
    q.start()
    await settle()
    expect(store.job(j.id).status).toBe('uncertain')
    expect(api.start).not.toHaveBeenCalled()
    q.stop()
  })
  it('resumes polling using the saved task ID', async () => {
    const j = makeJob('running')
    j.taskId = '987'
    store.saveJob(j)
    const api = {
        start: vi.fn(),
        status: vi.fn().mockResolvedValue('RUNNING'),
      } as unknown as RunningHub,
      q = new Queue(store, api, () => {})
    q.start()
    await settle()
    expect(api.status).toHaveBeenCalledWith(expect.objectContaining({ taskId: '987' }))
    expect(api.start).not.toHaveBeenCalled()
    q.stop()
  })
  it('marks an ambiguous create timeout uncertain, not retryable', async () => {
    const j = makeJob()
    store.saveJob(j)
    const api = {
        start: vi.fn().mockRejectedValue(new Error('timeout')),
        status: vi.fn(),
      } as unknown as RunningHub,
      q = new Queue(store, api, () => {})
    q.start()
    await settle()
    expect(store.job(j.id).status).toBe('uncertain')
    await expect(q.action(j.id, 'retry')).rejects.toThrow('待确认')
    expect(api.start).toHaveBeenCalledTimes(1)
    q.stop()
  })
  it('treats explicit API rejection as failed, rather than unknown', async () => {
    const j = makeJob()
    store.saveJob(j)
    const api = {
        start: vi.fn().mockRejectedValue(new RejectedRequest('余额不足')),
        status: vi.fn(),
      } as unknown as RunningHub,
      q = new Queue(store, api, () => {})
    q.start()
    await settle()
    expect(store.job(j.id).status).toBe('failed')
    q.stop()
  })
  it('rejects duplicate active shot submissions', () => {
    const j = makeJob()
    store.saveJob(j)
    store.set('config', { ...defaultConfig, workflowId: '123', mappings: j.mappings })
    const q = new Queue(store, {} as RunningHub, () => {})
    expect(() => q.enqueue(j.projectId, [j.shotId], false)).toThrow('未完成任务')
  })
  it('stops polling after five failures while preserving the task ID', async () => {
    vi.useFakeTimers()
    const j = makeJob('running')
    j.taskId = '987'
    store.saveJob(j)
    const api = {
        status: vi.fn().mockRejectedValue(new Error('offline')),
      } as unknown as RunningHub,
      q = new Queue(store, api, () => {})
    q.start()
    await settle()
    await vi.advanceTimersByTimeAsync(25000)
    expect(store.job(j.id).status).toBe('paused')
    expect(store.job(j.id).taskId).toBe('987')
    q.stop()
  })
  it('detects stale generated output after input changes', () => {
    const j = makeJob()
    expect(inputsChanged({ ...j.snapshot, videoPrompt: 'new' }, j.snapshot)).toBe(true)
    expect(inputsChanged({ ...j.snapshot, title: 'rename' }, j.snapshot)).toBe(false)
  })
})
