import { spokenLines } from './director'
import { type Project, type Shot } from './schema'
import { relevantAssets } from './shots'

const speechMarkup = /<\s*\/?\s*(?:d|scenetrans|cutoff)(?:\s[^>]*)?>/i

export function dialoguePlan(p: Project, shot: Shot) {
  const characters = relevantAssets(p, shot).filter((asset) => asset.kind === 'character')
  const knownSpeakers = [...p.assets.filter((asset) => asset.kind === 'character').map((asset) => asset.name),
    ...p.shots.map((item) => item.speaker), '旁白', 'voiceover', 'narrator']
  const speakers: string[] = []
  const lines = spokenLines(shot.dialogue, shot.speaker, knownSpeakers).map((line) => {
    const speaker = line.speaker || (characters.length === 1 ? characters[0].name : '未指定角色')
    // IDs are scoped to this target clip; reference voices are matched by character name.
    if (!speakers.includes(speaker)) speakers.push(speaker)
    return { ...line, speaker, speakerId: `S${speakers.indexOf(speaker) + 1}`,
      language: /[\p{Script=Han}]/u.test(line.words) ? 'Chinese' : 'English',
      voiceover: /^(旁白|voiceover|narrator)$/i.test(speaker) }
  })
  const errors: string[] = []
  if (speechMarkup.test(shot.dialogue)) errors.push('台词中不能包含工作流的语音控制标签，请只填写实际要说的文字。')
  if (shot.dialogue.trim() && !lines.length) errors.push('对白只有角色标签，请填写台词或清空对白。')
  const pronunciations: { text: string; readAs: string }[] = []
  if (lines.length) for (const raw of (shot.pronunciationNotes || '').split(/\r?\n/).filter((line) => line.trim())) {
    const entry = /^\s*(.{1,80}?)\s*[=＝：:]\s*(.{1,120}?)\s*$/.exec(raw)
    if (!entry || speechMarkup.test(raw)) {
      errors.push('读音备注请每行填写“词语=读音”，备注本身不会被朗读。')
      continue
    }
    const text = entry[1].trim(), readAs = entry[2].trim()
    if (!text || !readAs || !lines.some((line) => line.words.includes(text))) {
      errors.push('读音备注的词语必须出现在本镜台词中，读音不能为空。')
      continue
    }
    pronunciations.push({ text, readAs })
  }
  return { lines, pronunciations, errors: [...new Set(errors)] }
}

export function assertDialoguePlan(p: Project, shot: Shot) {
  const plan = dialoguePlan(p, shot)
  if (plan.errors.length) throw new Error(`${shot.title}：${plan.errors.join(' ')}`)
  return plan
}

// This verifies submitted text, not recognition or correctness of generated audio.
export function assertSpeechContract(prompt: string, plan: ReturnType<typeof dialoguePlan>) {
  const encoded = [...prompt.matchAll(/<d>\[([^\]]+)\] ([\s\S]*?)<\/d>/g)]
  const opening = prompt.match(/<d>/g) || [], closing = prompt.match(/<\/d>/g) || []
  if (encoded.length !== plan.lines.length || opening.length !== encoded.length || closing.length !== encoded.length ||
      encoded.some((entry, index) => entry[1] !== plan.lines[index].language || entry[2] !== plan.lines[index].words) ||
      speechMarkup.test(prompt.replace(/<d>\[[^\]]+\] [\s\S]*?<\/d>/g, '')))
    throw new Error('提交提示词中的台词与当前镜头不一致，请移除画面描述或资产中的语音控制标签后重试。')
}

export const speechRules = 'Speech contract: ONLY the content inside the dialogue blocks is spoken, once each, in the listed order. Preserve every word, syllable, repetition and original language. Never paraphrase, translate, summarize, add fillers or greetings, omit words, or finish the sentence with invented words. Speaker names, IDs, language tags, pronunciation notes, visual descriptions and reference content are NOT spoken. For Chinese dialogue use clear natural Mandarin unless the screenplay specifies another delivery; retain the written English terms without translating them. Respect punctuation and take natural breaths. Begin after a brief breath and complete the entire final word before the video ends; leave a short silent tail. Do not rush, overlap speakers, trail off, or cut off speech to fit the duration. Silence between turns is allowed; additional speech is not. Keep ambience below the voice so every syllable remains intelligible.'
