import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { zipSync, strToU8 } from 'fflate'
import { Store, createProject, inside, replaceEpisodeScript } from '../src/main/store'
import { codexFinalMessage } from '../src/main/codex'
import { codexImageBytes } from '../src/main/codex-image'
import { prepareChatFile } from '../src/main/chat-files'
import { exportArchive, restoreArchive, importMedia, Exporter } from '../src/main/media'
import {
  buildScriptChatPrompt,
  buildPrompt,
  parseDirector,
  minimumDialogueDuration,
  storyboardImport,
  parseScriptChatReply,
  toSrt,
  escapeHtml,
} from '../src/shared/director'
import { Queue, RunningHub, RejectedRequest, assertCoinOnlyWorkflow, inputsChanged, prepareVideoWorkflow, sameScene, videoPromptWithAssets } from '../src/main/runninghub'
import {
  blankShot,
  commandSchema,
  defaultConfig,
  videoWorkflow,
  projectSchema,
  type Job,
} from '../src/shared/schema'
import directorRef2vaGraph from './fixtures/director-ref2va-api.json'

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
  it('accepts a completed Codex PNG and rejects an unrelated saved path', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    await expect(codexImageBytes({ type: 'imageGeneration', status: 'completed', result: png.toString('base64') }, root)).resolves.toEqual(png)
    const outside = join(tmpdir(), `codex-image-outside-${Date.now()}.png`)
    await writeFile(outside, png)
    try {
      await expect(codexImageBytes({ type: 'imageGeneration', status: 'completed', savedPath: outside }, root)).rejects.toThrow('图片路径无效')
    } finally {
      await rm(outside, { force: true })
    }
  })
  it('keeps existing settings when adding the language preference', () => {
    const { locale: _locale, ...legacy } = defaultConfig
    store.set('config', { ...legacy, theme: 'dark' })
    expect(store.config()).toMatchObject({ theme: 'dark', locale: 'zh' })
    store.set('config', { ...store.config(), locale: 'en' })
    expect(store.config().locale).toBe('en')
  })
  it('defaults existing RunningHub settings to Plus', () => {
    const { instanceType: _instanceType, ...legacy } = defaultConfig
    store.set('config', legacy)
    expect(store.config().instanceType).toBe('plus')
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
  it('archives the old script and video before replacing the active director shots', async () => {
    const p = store.save(createProject('revised film', '16:9', true))
    const oldScript = p.episodes[0].script
    const file = join(root, 'previous.mp4')
    await writeFile(file, 'archived video bytes')
    const media = await importMedia(store, p.id, p.shots[0].id, 'video', file)
    const media2 = await importMedia(store, p.id, p.shots[0].id, 'video', file)
    store.update(p.id, (project) => {
      expect(replaceEpisodeScript(project, p.episodes[0].id, '全新的剧本与对白', [])).toBe(true)
      expect(replaceEpisodeScript(project, p.episodes[0].id, '全新的剧本与对白', [])).toBe(false)
    })
    const current = store.project(p.id)
    expect(current.episodes[0].script).toBe('全新的剧本与对白')
    expect(current.shots).toHaveLength(0)
    expect(current.scriptArchives).toHaveLength(1)
    expect(current.scriptArchives[0].script).toBe(oldScript)
    expect(current.scriptArchives[0].shots[0].videoMediaId).toBe(media2.id)
    expect(current.media.find((item) => item.id === media.id)).toBeDefined()
    expect(current.media.find((item) => item.id === media2.id)).toBeDefined()
    const oldJob: Job = {
      id: crypto.randomUUID(), projectId: p.id, shotId: p.shots[0].id,
      status: 'failed', site: defaultConfig.site, workflowId: videoWorkflow.id,
      mappings: [], snapshot: p.shots[0], createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), pollErrors: 0, outputs: [], stopOnFailure: false,
    }
    store.saveJob(oldJob)
    await expect(new Queue(store, {} as RunningHub, () => {}).action(oldJob.id, 'retry'))
      .rejects.toThrow('旧剧本镜头已存档')
    const target = join(root, 'revised.director.zip')
    await exportArchive(store, p.id, target)
    const restored = await restoreArchive(store, target)
    expect(restored.scriptArchives[0].shots[0].videoMediaId).toBe(media2.id)
    expect(await readFile(store.file(restored.id, restored.media.find((item) => item.id === media.id)!.file), 'utf8'))
      .toBe('archived video bytes')
    const oldRevision = store.history(p.id).at(-1)!.revision as number
    store.restore(p.id, oldRevision)
    expect(store.project(p.id).scriptArchives).toHaveLength(1)
    const restoredProject = store.project(p.id)
    expect(replaceEpisodeScript(restoredProject, restoredProject.episodes[0].id,
      restoredProject.episodes[0].script, store.jobs())).toBe(false)
  })
  it('keeps other episodes and blocks archiving while a paid video job is unfinished', () => {
    const p = store.save(createProject('episodes', '16:9', true))
    const second = crypto.randomUUID()
    store.update(p.id, (project) => {
      project.episodes.push({ id: second, title: '第二集', script: '第二集剧本', scriptChat: [] })
      project.shots.push({ ...structuredClone(project.shots[0]), id: crypto.randomUUID(), episodeId: second })
    })
    store.set('config', { ...defaultConfig, paused: true })
    new Queue(store, {} as RunningHub, () => {}).enqueue(p.id, [p.shots[0].id], false)
    expect(() => store.update(p.id, (project) =>
      replaceEpisodeScript(project, p.episodes[0].id, '不能现在更新', store.jobs()),
    )).toThrow('未完成的视频任务')
    expect(store.project(p.id).scriptArchives).toHaveLength(0)
    const job = store.jobs()[0]
    job.status = 'cancelled'
    store.saveJob(job)
    store.update(p.id, (project) => replaceEpisodeScript(project, p.episodes[0].id, '第一集新版', store.jobs()))
    expect(store.project(p.id).shots.map((shot) => shot.episodeId)).toEqual([second])
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
    const shortSpeech = '今天我们一起去看看那封信吧'
    const fitted = parseDirector(JSON.stringify({ shots: [{ title: '短对白', duration: 3, dialogue: shortSpeech }] }))
    expect(fitted.shots?.[0].duration).toBe(minimumDialogueDuration(shortSpeech))
    const longSpeech = '这段对白真的很长，镜头必须拆分。'.repeat(8)
    const needsSplit = parseDirector(JSON.stringify({ shots: [{ title: '长对白', duration: 3, dialogue: longSpeech }] }))
    expect(needsSplit.shots?.[0].duration).toBe(3)
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
    expect(prompt).toContain('逐字保留原剧本中的对白')
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
  it('stores the selected Standard mode on each new job', () => {
    const p = store.save(createProject('standard workflow', '16:9', true))
    store.set('config', { ...defaultConfig, instanceType: 'default', paused: true })
    const q = new Queue(store, {} as RunningHub, () => {})
    q.enqueue(p.id, [p.shots[0].id], false)
    expect(store.jobs()[0]).toMatchObject({
      workflowId: videoWorkflow.id,
      instanceType: 'default',
      mappings: [],
    })
    store.set('config', { ...defaultConfig, instanceType: 'plus', paused: true })
    expect(store.jobs()[0].instanceType).toBe('default')
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
  it('rebuilds the Ref2VA chain from distinct images and the previous video', () => {
    const shot = { ...blankShot('episode'), videoPrompt: 'Continue along the river', duration: 5, seed: 83 }
    const source = {
      '4': { class_type: 'LoadImage', inputs: { image: 'unrelated-template-portrait.png' } },
      '5': { class_type: 'RHMiniMaxH3Ref2VAImageReference', inputs: { image: ['4', 0] } },
      '6': { class_type: 'LoadImage', inputs: { image: 'unrelated-template-scene.png' } },
      '7': { class_type: 'RHMiniMaxH3Ref2VAImageReference', inputs: { image: ['6', 0], references: ['5', 0] } },
      '12': { class_type: 'RHMiniMaxH3Ref2VATarget', inputs: { duration_seconds: 5 } },
      '13': { class_type: 'RHMiniMaxH3Ref2VAEncode', inputs: { prompt: 'old' } },
      '15': { class_type: 'RHMiniMaxH3DualSigmaSampler', inputs: { seed: 42 } },
    }
    const graph = prepareVideoWorkflow(source, shot, '9:16', {
      references: ['previous.png', 'father.png', 'sister.png', 'riverside.png'], video: 'previous.mp4',
    })
    expect(Object.values(graph).filter((node) => node.class_type === 'RHMiniMaxH3Ref2VAImageReference')).toHaveLength(4)
    expect(Object.values(graph).filter((node) => node.class_type === 'LoadImage').map((node) => node.inputs.image))
      .toEqual(['previous.png', 'father.png', 'sister.png', 'riverside.png'])
    expect(Object.values(graph).some((node) => JSON.stringify(node.inputs).includes('unrelated-template'))).toBe(false)
    const video = Object.entries(graph).find(([, node]) => node.class_type === 'RHMiniMaxH3Ref2VAVideoReference')!
    expect(video[1].inputs.reference_type).toBe('video')
    expect(graph['12'].inputs).toMatchObject({ references: [video[0], 0], aspect_ratio: '9:16', duration_seconds: 5, width: 480, height: 864 })
    expect(graph['13'].inputs).toMatchObject({ references: [video[0], 0], prompt: 'Continue along the river' })
    expect(graph['15'].inputs.seed).toBe(83)
    expect(source['13'].inputs.prompt).toBe('old')
  })
  it('adapts the saved RunningHub director graph without dangling node links', () => {
    const shot = { ...blankShot('episode'), videoPrompt: 'A quiet riverside exchange', duration: 4 }
    const graph = prepareVideoWorkflow(directorRef2vaGraph, shot, '16:9', {
      references: ['father.png', 'sister.png', 'riverside.png'],
    })
    for (const node of Object.values(graph))
      for (const value of Object.values(node.inputs))
        if (Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'number')
          expect(graph[value[0]], `missing linked node ${value[0]}`).toBeDefined()
    expect(graph['12'].inputs).toMatchObject({ duration_seconds: 4, width: 864, height: 480 })
    expect(Object.values(graph).filter((node) => node.class_type === 'RHMiniMaxH3Ref2VAImageReference')).toHaveLength(3)
    expect(prepareVideoWorkflow(directorRef2vaGraph, shot, '16:9')['17'].class_type).toBe('MiniMaxH3ImageToVideo')
  })
  it('submits every linked asset image to the Ref2VA workflow', async () => {
    const p = store.save(createProject('two visual references', '16:9', true))
    const png = join(root, 'reference.png')
    await writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
    for (const asset of p.assets.filter((item) => p.shots[0].assetIds.includes(item.id)).slice(0, 2))
      await importMedia(store, p.id, asset.id, 'reference', png)
    const api = {
      workflow: vi.fn().mockResolvedValue({
        '12': { class_type: 'RHMiniMaxH3Ref2VATarget', inputs: {} },
        '13': { class_type: 'RHMiniMaxH3Ref2VAEncode', inputs: {} },
        '15': { class_type: 'RHMiniMaxH3DualSigmaSampler', inputs: {} },
      }),
      upload: vi.fn().mockImplementation(async (_site: string, file: string) => file.split(/[\\/]/).at(-1)),
      start: vi.fn().mockResolvedValue('987'),
    } as unknown as RunningHub
    new Queue(store, api, () => {}).enqueue(p.id, [p.shots[0].id], false)
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1))
    const graph = vi.mocked(api.start).mock.calls[0][2]!
    const references = Object.entries(graph).filter(([, node]) => node.class_type === 'RHMiniMaxH3Ref2VAImageReference')
    expect(references).toHaveLength(2)
    expect(graph['13'].inputs.prompt).toContain('<Picture 2>')
    expect(graph['13'].inputs.references).toEqual([references[1][0], 0])
    expect(store.jobs()[0].referenceMediaIds).toHaveLength(2)
  })
  it.each(['plus', 'default'] as const)('sends the complete workflow with %s instance', async (instanceType) => {
    const j = makeJob()
    j.instanceType = instanceType
    const transport = vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify({
      code: 0,
      data: url.endsWith('/accountStatus')
        ? { apiType: 'NORMAL', remainCoins: '100' }
        : { taskId: '987' },
    }), { status: 200 }))
    const api = new RunningHub(() => 'local-test-key', transport)
    expect(await api.start(j, [], { '17': { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: 'test' } } })).toBe('987')
    const [url, options] = transport.mock.calls[1]
    const body = JSON.parse(options.body)
    expect(url).toBe(`${j.site}/task/openapi/create`)
    expect(body).toMatchObject({ instanceType, workflowId: j.workflowId, apiKey: 'local-test-key' })
    expect(JSON.parse(body.workflow)['17'].inputs.prompt).toBe('test')
  })
  it('refuses wallet-billed keys before creating a task', async () => {
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0, data: { apiType: 'SHARED', remainCoins: '1000' },
    }), { status: 200 }))
    const api = new RunningHub(() => 'local-test-key', transport)
    await expect(api.start(makeJob(), [], directorRef2vaGraph)).rejects.toThrow('钱包计费')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0][0]).toContain('/accountStatus')
  })
  it('refuses unknown workflow nodes even with a coin-billed key', async () => {
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0, data: { apiType: 'NORMAL', remainCoins: '1000' },
    }), { status: 200 }))
    const api = new RunningHub(() => 'local-test-key', transport)
    await expect(api.start(makeJob(), [], {
      '1': { class_type: 'ThirdPartyVideoAPI', inputs: {} },
    })).rejects.toThrow('未核准')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(() => assertCoinOnlyWorkflow(directorRef2vaGraph)).not.toThrow()
  })
  it('shows the remote node validation reason for a failed task', async () => {
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 805,
      msg: 'APIKEY_TASK_STATUS_ERROR',
      data: { failedReason: {
        node_name: 'RHMiniMaxH3Ref2VAVideoReference',
        exception_message: 'Value not in list',
        traceback: "reference_type: 'video_only' not in ['video', 'video_audio']",
      } },
    }), { status: 200 }))
    const api = new RunningHub(() => 'local-test-key', transport)
    expect(await api.failure({ ...makeJob(), taskId: '123' }))
      .toContain("reference_type: 'video_only' not in ['video', 'video_audio']")
  })
  it('prepares the built-in workflow before submitting a Standard job', async () => {
    const p = store.save(createProject('standard submit', '16:9', true))
    store.set('config', { ...defaultConfig, instanceType: 'default' })
    const api = {
      workflow: vi.fn().mockResolvedValue({
        '17': { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: '', length: 5 } },
      }),
      start: vi.fn().mockResolvedValue('123'),
      status: vi.fn().mockResolvedValue('RUNNING'),
    } as unknown as RunningHub
    const q = new Queue(store, api, () => {})
    q.enqueue(p.id, [p.shots[0].id], false)
    await settle()
    expect(api.workflow).toHaveBeenCalledWith(expect.objectContaining({ workflowId: videoWorkflow.id }))
    expect(api.start).toHaveBeenCalledWith(
      expect.objectContaining({ instanceType: 'default' }),
      [],
      expect.objectContaining({ '17': expect.objectContaining({ inputs: expect.objectContaining({ prompt: expect.stringContaining(p.shots[0].videoPrompt) }) }) }),
    )
    expect(store.jobs()[0]).toMatchObject({ status: 'running', taskId: '123' })
  })
  it('keeps a deliberate first frame ahead of the asset portrait and includes identity in the prompt', async () => {
    const p = store.save(createProject('character reference', '16:9', true))
    const asset = p.assets.find((item) => item.kind === 'character' && p.shots[0].assetIds.includes(item.id))!
    const png = join(root, 'portrait.png')
    await writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
    await importMedia(store, p.id, asset.id, 'reference', png)
    await importMedia(store, p.id, p.shots[0].id, 'first', png)
    const api = {
      workflow: vi.fn().mockResolvedValue({ '17': { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: '', length: 5 } } }),
      upload: vi.fn().mockResolvedValue('character.png'),
      start: vi.fn().mockResolvedValue('456'),
    } as unknown as RunningHub
    new Queue(store, api, () => {}).enqueue(p.id, [p.shots[0].id], false)
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1))
    const graph = vi.mocked(api.start).mock.calls[0][2]!
    expect(graph['17'].inputs.prompt).toContain(asset.name)
    expect(graph['17'].inputs.first_frame).toEqual(['18', 0])
    expect(graph['18'].inputs.image).toBe('character.png')
    expect(store.jobs()[0].referenceMediaId).toBe(store.project(p.id).assets.find((a) => a.id === asset.id)?.selectedMediaId)
    const saved = store.project(p.id)
    expect(vi.mocked(api.upload).mock.calls[0][1]).toBe(
      store.file(p.id, saved.media.find((m) => m.id === saved.shots[0].firstMediaId)!.file),
    )
  })
  it('keeps exact screenplay speech and stable asset identities in the video prompt', () => {
    const p = createProject('dialogue', '16:9', true)
    const shot = p.shots[1]
    shot.speaker = '林舟'
    const prompt = videoPromptWithAssets(p, shot, true, true)
    expect(prompt).toContain('<d>[Chinese] 如果你还记得，今晚十一点。</d>')
    expect(prompt).toContain('林舟 (S1)')
    expect(prompt).toContain('character 林舟:')
    expect(prompt).toContain('location 街角咖啡馆:')
    expect(prompt).toContain('prop 未署名的信:')
    expect(prompt.startsWith('For the target video, at 0.00 seconds, <Picture 1>')).toBe(true)
    expect(videoPromptWithAssets(p, p.shots[0], false, false)).toContain('no dialogue or voiceover')
    expect(inputsChanged({ ...shot, dialogue: '新台词' }, shot)).toBe(true)
  })
  it('chains shots in one scene and treats a new scene as a cut', () => {
    const p = createProject('scenes', '16:9', true)
    expect(sameScene(p.shots[0], p.shots[1], p)).toBe(true)
    expect(sameScene(p.shots[2], p.shots[3], p)).toBe(false)
    const riverside = { ...p.shots[0], scene: '河边步道·外·日' }
    expect(sameScene(riverside, { ...p.shots[1], scene: '河边步道垃圾桶旁·外·日' }, p)).toBe(true)
    expect(sameScene(riverside, { ...p.shots[1], scene: '河边步道垃圾桶旁·外·夜' }, p)).toBe(false)
    const q = new Queue(store, {} as RunningHub, () => {})
    const saved = store.save(p)
    store.set('config', { ...defaultConfig, paused: true })
    q.enqueue(saved.id, [saved.shots[3].id], false)
    expect(store.jobs()[0].previousShotId).toBeUndefined()
  })
  it('fits brief dialogue before queueing and rejects dialogue that needs multiple shots', async () => {
    const p = store.save(createProject('anchors', '16:9', true))
    const location = p.assets.find((a) => a.kind === 'location')!
    const png = join(root, 'scene.png')
    await writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
    await importMedia(store, p.id, location.id, 'reference', png)
    store.set('config', { ...defaultConfig, paused: true })
    const q = new Queue(store, {} as RunningHub, () => {})
    q.enqueue(p.id, [p.shots[0].id], false)
    expect(store.jobs()[0].referenceMediaId).toBe(store.project(p.id).assets.find((a) => a.id === location.id)?.selectedMediaId)
    const shortSpeech = '今天我们一起去看看那封信吧'
    store.update(p.id, (current) => {
      current.shots[0].dialogue = shortSpeech
      current.shots[0].duration = 3
    })
    const firstJob = store.jobs()[0]
    firstJob.status = 'cancelled'
    store.saveJob(firstJob)
    expect(q.enqueue(p.id, [p.shots[0].id], false)).toBe(1)
    expect(store.project(p.id).shots[0].duration).toBe(minimumDialogueDuration(shortSpeech))
    expect(store.jobs()[0].snapshot.duration).toBe(minimumDialogueDuration(shortSpeech))
    store.update(p.id, (current) => { current.shots[1].dialogue = '这句话太长了。'.repeat(40) })
    expect(() => q.enqueue(p.id, [p.shots[1].id], false)).toThrow('请在导演台拆成多个镜头')
    expect(store.jobs()).toHaveLength(2)
  })
  it('validates the whole batch before changing durations or creating paid jobs', () => {
    const p = createProject('timing batch', '16:9', true)
    p.shots[0].duration = 3
    p.shots[0].dialogue = '今天我们一起去看看那封信吧'
    p.shots[1].duration = 3
    p.shots[1].dialogue = '这段对白需要拆成多个镜头。'.repeat(12)
    store.save(p)
    store.set('config', { ...defaultConfig, paused: true })
    const queue = new Queue(store, {} as RunningHub, () => {})
    expect(() => queue.enqueue(p.id, p.shots.slice(0, 2).map((shot) => shot.id), false))
      .toThrow('请在导演台拆成多个镜头')
    expect(store.project(p.id).shots[0].duration).toBe(3)
    expect(store.jobs()).toHaveLength(0)
    store.update(p.id, (current) => { current.shots[1].dialogue = '我们去看看那封信吧' })
    expect(queue.enqueue(p.id, p.shots.slice(0, 2).map((shot) => shot.id), false)).toBe(2)
    expect(store.jobs()).toHaveLength(2)
    expect(store.jobs().map((job) => job.snapshot.duration).sort()).toEqual([4, 5])
  })
  it('waits for a regenerated previous shot before submitting the next shot', async () => {
    const p = store.save(createProject('regeneration order', '16:9', true))
    const video = join(root, 'old.mp4')
    await writeFile(video, 'old video placeholder')
    await importMedia(store, p.id, p.shots[0].id, 'video', video)
    store.set('config', { ...defaultConfig, concurrency: 2 })
    const api = {
      workflow: vi.fn().mockResolvedValue({ '17': { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: '', length: 5 } } }),
      start: vi.fn().mockResolvedValue('789'),
    } as unknown as RunningHub
    new Queue(store, api, () => {}).enqueue(p.id, [p.shots[0].id, p.shots[1].id], false)
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1))
    expect(store.jobs().find((j) => j.shotId === p.shots[1].id)).toMatchObject({ status: 'queued' })
  })
  it('marks later videos stale when an earlier shot video changes', async () => {
    const p = store.save(createProject('stale sequence', '16:9', true))
    const file = join(root, 'shot.mp4')
    await writeFile(file, 'video placeholder')
    await importMedia(store, p.id, p.shots[0].id, 'video', file)
    await importMedia(store, p.id, p.shots[1].id, 'video', file)
    expect(store.project(p.id).shots[1].stale).toBe(false)
    await importMedia(store, p.id, p.shots[0].id, 'video', file)
    expect(store.project(p.id).shots[1].stale).toBe(true)
  })
  it('extracts the prior video last frame for a continuing shot', async () => {
    const p = store.save(createProject('continuous shots', '16:9', true))
    const video = join(root, 'first.mp4')
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24',
      '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video,
    ], { windowsHide: true })
    await importMedia(store, p.id, p.shots[0].id, 'video', video)
    const alternate = join(root, 'alternate.png')
    await writeFile(alternate, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
    await importMedia(store, p.id, p.shots[1].id, 'first', alternate)
    const uploaded: Buffer[] = []
    const api = {
      workflow: vi.fn().mockResolvedValue({ '17': { class_type: 'MiniMaxH3ImageToVideo', inputs: { prompt: '', length: 5 } } }),
      upload: vi.fn().mockImplementation(async (_site: string, file: string) => {
        uploaded.push(await readFile(file))
        return 'last-frame.png'
      }),
      start: vi.fn().mockResolvedValue('987'),
    } as unknown as RunningHub
    new Queue(store, api, () => {}).enqueue(p.id, [p.shots[1].id], false)
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1), { timeout: 10000 })
    expect(uploaded[0].subarray(0, 8)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'))
    const graph = vi.mocked(api.start).mock.calls[0][2]!
    expect(graph['17'].inputs.first_frame).toEqual(['18', 0])
    expect(graph['17'].inputs.prompt).toContain('Continue the same action immediately')
    expect(store.jobs()[0].previousShotId).toBe(p.shots[0].id)
  }, 15000)
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
