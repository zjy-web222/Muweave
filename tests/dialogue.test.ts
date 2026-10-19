import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, Store } from '../src/main/store'
import { Queue, type RunningHub, videoPromptWithAssets, modelVideoPrompt } from '../src/main/runninghub'
import { assertDialoguePlan, assertSpeechContract, dialoguePlan } from '../src/shared/dialogue'
import { minimumDialogueDuration, parseDirector, spokenLines } from '../src/shared/director'
import { defaultConfig, shotSchema } from '../src/shared/schema'
import { inputsChanged } from '../src/shared/shots'
import graphFixture from './fixtures/director-ref2va-api.json'

describe('verbatim dialogue workflow', () => {
  it('keeps repeats, punctuation, numbers and mixed-language words verbatim in turn order', () => {
    const p = createProject('speech', '16:9', true)
    const shot = { ...p.shots[1], speaker: '旁白', dialogue: '旁白：别、别急，ADHD 不是懒。\n林舟：明天 12:30 见，2026 年再来。\n旁白：Wait, wait!' }
    const plan = dialoguePlan(p, shot)
    expect(plan.lines.map(({ speaker, speakerId, words }) => ({ speaker, speakerId, words }))).toEqual([
      { speaker: '旁白', speakerId: 'S1', words: '别、别急，ADHD 不是懒。' },
      { speaker: '林舟', speakerId: 'S2', words: '明天 12:30 见，2026 年再来。' },
      { speaker: '旁白', speakerId: 'S1', words: 'Wait, wait!' },
    ])
    const prompt = videoPromptWithAssets(p, shot, false, false)
    expect(() => assertSpeechContract(prompt, plan)).not.toThrow()
    expect([...prompt.matchAll(/<d>\[[^\]]+\] (.*?)<\/d>/g)].map((match) => match[1]))
      .toEqual(plan.lines.map((line) => line.words))
    expect(prompt).toContain('Never paraphrase, translate, summarize, add fillers or greetings')
    expect(prompt).toContain('complete the entire final word before the video ends')
    expect(prompt).toContain('on-screen characters keep their lips closed')
  })
  it('preserves colons inside speech, clock times and URLs instead of losing the preceding words', () => {
    const p = createProject('colons', '16:9', true)
    const shot = { ...p.shots[0], speaker: '旁白', dialogue: '注意：不要加词。\n12:30 开始。\nhttps://example.test/a' }
    expect(dialoguePlan(p, shot).lines.map((line) => line.words)).toEqual(shot.dialogue.split('\n'))
    expect(spokenLines('角色1：准备好了。', '角色1', ['角色1']))
      .toEqual([{ speaker: '角色1', words: '准备好了。' }])
  })
  it('keeps pronunciation guidance outside the actual speech and marks changes stale', () => {
    const p = createProject('readings', '16:9', true)
    const shot = { ...p.shots[0], speaker: '旁白', dialogue: '2026 年去重庆。', pronunciationNotes: '重庆=chóng qìng\n2026=二零二六' }
    const prompt = videoPromptWithAssets(p, shot, false, false)
    expect(prompt).toContain('Pronunciation guidance (NOT spoken')
    expect(prompt).toContain('chóng qìng')
    expect(prompt.match(/<d>\[Chinese\] (.*?)<\/d>/)?.[1]).toBe(shot.dialogue)
    expect(modelVideoPrompt(p, shot, false)).toContain('备注不朗读、不增删原台词')
    expect(inputsChanged(shot, { ...shot, pronunciationNotes: '重庆=zhòng qìng' })).toBe(true)
    expect(dialoguePlan(p, { ...shot, pronunciationNotes: '不存在=读音' }).errors).not.toHaveLength(0)
    expect(dialoguePlan(p, { ...shot, pronunciationNotes: '读慢一些' }).errors).not.toHaveLength(0)
    expect(shotSchema.parse({ ...p.shots[0], pronunciationNotes: undefined }).pronunciationNotes).toBeUndefined()
    expect(parseDirector(JSON.stringify({ shots: [shot] })).shots?.[0].pronunciationNotes).toBe(shot.pronunciationNotes)
  })
  it('rejects extra or missing submitted speech and speech tags embedded in visual directions', () => {
    const p = createProject('contract', '16:9', true)
    const shot = { ...p.shots[0], speaker: '旁白', dialogue: '原文，不能变。' }
    const plan = assertDialoguePlan(p, shot)
    const prompt = videoPromptWithAssets(p, shot, false, false)
    expect(() => assertSpeechContract(prompt.replace('原文，不能变。', '原文。'), plan)).toThrow('台词与当前镜头不一致')
    expect(() => assertSpeechContract(`${prompt}\n<d>[Chinese] 额外台词</d>`, plan)).toThrow()
    expect(() => videoPromptWithAssets(p, { ...shot, action: '<d>[Chinese] 旧台词</d>' }, false, false)).toThrow()
    expect(() => assertDialoguePlan(p, { ...shot, dialogue: '<d>嵌入标签</d>' })).toThrow('语音控制标签')
    expect(() => assertDialoguePlan(p, { ...shot, dialogue: '旁白：' })).toThrow('只有角色标签')
    expect(() => assertSpeechContract('No speech.', dialoguePlan(p, { ...shot, dialogue: '' }))).not.toThrow()
  })
  it('counts digit and acronym pronunciation instead of treating those dialogues as silent or one short word', () => {
    expect(minimumDialogueDuration('12345678901234567890')).toBeGreaterThanOrEqual(6)
    expect(minimumDialogueDuration('ADHD ADHD ADHD')).toBeGreaterThan(minimumDialogueDuration('word word word'))
    expect(minimumDialogueDuration('12:30 开始。')).toBeGreaterThan(minimumDialogueDuration('开始。'))
  })
  it('validates every shot before saving durations or adding jobs, then freezes notes at enqueue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muweave-dialogue-'))
    const store = new Store(root)
    const api = { workflow: vi.fn().mockResolvedValue(graphFixture), start: vi.fn().mockResolvedValue('local-dialogue-only') } as unknown as RunningHub
    const queue = new Queue(store, api, () => {})
    try {
      const p = createProject('preflight', '16:9', true)
      p.shots[0] = { ...p.shots[0], action: '看向镜头', duration: 3, speaker: '旁白', dialogue: '今天我们一起去看看那封信吧' }
      p.shots[1] = { ...p.shots[1], speaker: '旁白', dialogue: '去重庆。', pronunciationNotes: '无关词语=读音' }
      store.save(p)
      store.set('config', { ...defaultConfig, paused: true })
      expect(() => queue.enqueue(p.id, [p.shots[0].id, p.shots[1].id], false)).toThrow('必须出现在本镜台词')
      expect(store.jobs()).toHaveLength(0)
      expect(store.project(p.id).shots[0].duration).toBe(3)
      p.shots[1].pronunciationNotes = '重庆=chóng qìng'
      store.save(p)
      queue.enqueue(p.id, [p.shots[1].id], false)
      p.shots[1].pronunciationNotes = '重庆=别的读法'
      p.shots[1].dialogue = '这句已经改变。'
      store.save(p)
      expect(store.jobs()[0].snapshot).toMatchObject({ dialogue: '去重庆。', pronunciationNotes: '重庆=chóng qìng' })
      store.set('config', { ...defaultConfig, paused: false })
      queue.start()
      await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(1))
      const submitted = JSON.stringify(vi.mocked(api.start).mock.calls[0][2])
      expect(submitted).toContain('chóng qìng')
      expect(submitted).toContain('<d>[Chinese] 去重庆。</d>')
      expect(submitted).not.toContain('别的读法')
      expect(submitted).not.toContain('这句已经改变。')
    } finally { queue.stop(); store.close(); await rm(root, { recursive: true, force: true }) }
  })
})
