import { dialoguePlan } from '../shared/dialogue'
import { type Project, type Shot } from '../shared/schema'
import { useT } from './i18n'

export function DialoguePreview({ p, shot }: { p: Project; shot: Shot }) {
  const t = useT(), plan = dialoguePlan(p, shot)
  return <div className="dialogue-preview">
    {plan.lines.length ? plan.lines.map((line, index) => <div key={index} className="dialogue-preview-line">
      <strong className="small muted">{line.speaker === '未指定角色' ? t(line.speaker) : line.speaker}</strong><p>{line.words}</p>
    </div>) : <p className="small muted">{t('无台词：不生成人声。')}</p>}
    {plan.lines.some((line) => line.speaker === '未指定角色') && <p className="small muted">
      {t('说话角色尚未指定，建议填写角色名或旁白。')}
    </p>}
    {!!plan.pronunciations.length && <p className="small muted">
      {t('读音指导（不朗读）：')}{plan.pronunciations.map((entry) => `${entry.text} → ${entry.readAs}`).join('；')}
    </p>}
    {plan.errors.map((error) => <p key={error} className="small danger" role="alert">{t(error)}</p>)}
  </div>
}
