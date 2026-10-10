import { useState } from 'react'
import { WandSparkles } from 'lucide-react'
import { defaultScriptPolishDirections } from '../shared/director'
import type { ScriptChatTurn } from '../shared/schema'
import { useT } from './i18n'
import { Button, Field, useWorkspace } from './ui'

export function ScriptPolishOptions({ projectId, episodeId, turn, disabled }: {
  projectId: string
  episodeId: string
  turn: ScriptChatTurn
  disabled: boolean
}) {
  const t = useT(), { run, state } = useWorkspace()
  const [direction, setDirection] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = state.aiTasks.some((task) => task.projectId === projectId &&
    task.request.type === 'scriptChatGenerate' && task.request.episodeId === episodeId &&
    task.request.polishTurnId === turn.id && ['queued', 'running'].includes(task.status))
  const locked = disabled || busy || pending
  const directions = turn.polishDirections || defaultScriptPolishDirections

  async function polish(instruction: string) {
    if (locked || !instruction.trim()) return
    setBusy(true)
    try {
      const result = await run({ type: 'aiEnqueue', request: {
        type: 'scriptChatGenerate', projectId, episodeId, polishTurnId: turn.id,
        request: instruction.trim(), attachmentIds: [],
      } })
      if (result.ok) setDirection('')
    } finally {
      setBusy(false)
    }
  }

  async function decide(skipped: boolean) {
    if (locked) return
    setBusy(true)
    try {
      await run({ type: 'scriptChatPolishDecision', projectId, episodeId, turnId: turn.id, skipped })
    } finally {
      setBusy(false)
    }
  }

  if (turn.polishSkipped) return <div className="script-polish-kept">
    <span>{t('已选择不润色，保留此版')}</span>
    <Button disabled={locked} onClick={() => void decide(false)}>{t('重新选择')}</Button>
  </div>

  return <section className="script-polish" aria-label={t('AI 润色选项')}>
    <div className="script-polish-heading">
      <WandSparkles size={13} aria-hidden="true" />
      <strong>{t('要润色这版剧本吗？')}</strong>
    </div>
    <p className="muted">{t('基于这次返回的剧本，生成新的候选版本。')}</p>
    <div className="script-polish-directions">
      {directions.map((item, index) => {
        const title = turn.polishDirections ? item.title : t(item.title)
        const instruction = turn.polishDirections ? item.instruction : t(item.instruction)
        return <button key={index} type="button" className="script-polish-direction"
          aria-label={`${t('润色方向')} ${index + 1}：${title}`} disabled={locked}
          onClick={() => void polish(instruction)}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <div><strong>{title}</strong><p>{instruction}</p></div>
        </button>
      })}
    </div>
    <Field label={t('自定义润色方向')}>
      <textarea rows={2} maxLength={2000} value={direction} disabled={locked}
        placeholder={t('例如：保留结局，让父女对白更克制自然。')}
        onChange={(event) => setDirection(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            void polish(direction)
          }
        }} />
    </Field>
    <div className="script-polish-actions">
      <Button disabled={locked} onClick={() => void decide(true)}>{t('不润色')}</Button>
      <Button primary disabled={locked || !direction.trim()} onClick={() => void polish(direction)}>
        {t('按自定义方向润色')}
      </Button>
    </div>
    {pending && <p className="small muted" role="status">{t('已加入润色队列，完成后会返回新剧本。')}</p>}
  </section>
}
