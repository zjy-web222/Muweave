import { useT } from './i18n'
import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  ArrowDown,
  Check,
  ImagePlus,
  Play,
  Upload,
  SlidersHorizontal,
  Trash2,
  ExternalLink,
  Layers3,
} from 'lucide-react'
import { type Project, type Shot } from '../shared/schema'
import { Button, Field, Preview, useWorkspace, Versions } from './ui'
import BatchShotDialog from './BatchShotDialog'
import { DialoguePreview } from './DialoguePreview'

export default function Inspector({
  p,
  shot,
  onGenerate,
  onVideo,
  onDelete,
  onPrevis,
}: {
  p: Project
  shot: Shot
  onGenerate: (s: Shot, slot: 'first' | 'last') => void
  onVideo: (s: Shot) => void
  onDelete: () => void
  onPrevis: () => void
}) {
  const t = useT()
  const { run, state } = useWorkspace(),
    [draft, setDraft] = useState(shot),
    [tab, setTab] = useState<'shot' | 'media'>('shot'),
    [dirty, setDirty] = useState(false),
    [saving, setSaving] = useState(false),
    [batchEdit, setBatchEdit] = useState<{ source: Shot; assetId?: string } | null>(null),
    [assetSuggestion, setAssetSuggestion] = useState<string | null>(null)
  const pending = useRef<Shot | null>(null)
  useEffect(() => {
    if (!pending.current) setDraft(shot)
  }, [shot])
  const set = <K extends keyof Shot>(k: K, v: Shot[K]) => {
    const next = { ...draft, [k]: v }
    pending.current = next
    setDraft(next)
    setDirty(true)
  }
  async function save() {
    const next = pending.current
    if (!next) return true
    pending.current = null
    setSaving(true)
    const r = await run({ type: 'shot', projectId: p.id, shot: next })
    if (!r.ok && !pending.current) pending.current = next
    setDirty(!!pending.current)
    setSaving(false)
    return r.ok
  }
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => void save(), 700)
    return () => clearTimeout(t)
  }, [draft, dirty])
  useEffect(
    () => () => {
      if (pending.current) void run({ type: 'shot', projectId: p.id, shot: pending.current })
    },
    [p.id, shot.id, run],
  )
  useEffect(() => {
    const handler = () => {
      void save()
    }
    window.addEventListener('director:save', handler)
    return () => window.removeEventListener('director:save', handler)
  }, [draft])
  return (
    <aside className="inspector">
      <header>
        <span>
          <SlidersHorizontal size={15} /> {t('镜头检查器')}
        </span>
        <span className="mono">
          {String(p.shots.filter((s) => s.episodeId === shot.episodeId).indexOf(shot) + 1).padStart(
            2,
            '0',
          )}
        </span>
      </header>
      <div className="inspector-tabs">
        <button className={tab === 'shot' ? 'active' : ''} onClick={() => setTab('shot')}>
          {t('导演参数')}
        </button>
        <button className={tab === 'media' ? 'active' : ''} onClick={() => setTab('media')}>
          {t('素材与版本')}
        </button>
      </div>
      <div className="inspector-content">
        {tab === 'shot' ? (
          <>
            <div className="inspector-batch-tools">
              <Button onClick={async () => { if (await save()) onPrevis() }}><Layers3 size={14} />{t('打开 3D 预演')}</Button>
              <Button disabled={saving || p.shots.filter((s) => s.episodeId === shot.episodeId).length < 2}
                onClick={async () => { if (await save()) setBatchEdit({ source: draft }) }}>
                <Layers3 size={14} />{t('批量应用到其他镜头')}
              </Button>
              <p className="small muted">{t('统一资产、场景、景别、运镜、光线或时长。')}</p>
            </div>
            <div className="inspector-preview">
              <Preview
                p={p}
                mediaId={shot.videoMediaId || shot.firstMediaId}
                slot={shot.videoMediaId ? 'video' : 'image'}
                controls
              />
            </div>
            <Field label={t('镜头标题')}>
              <input value={draft.title} onChange={(e) => set('title', e.target.value)} />
            </Field>
            <div className="field-row">
              <Field label={t('景别')}>
                <select value={draft.size} onChange={(e) => set('size', e.target.value)}>
                  {['大全景', '全景', '中景', '近景', '特写', '双人近景'].map((v) => (
                    <option key={v} value={v}>
                      {t(v)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('时长 / 秒')}>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={draft.duration}
                  onChange={(e) => set('duration', Number(e.target.value) || 1)}
                />
              </Field>
            </div>
            <Field label={t('画面动作')}>
              <textarea
                rows={3}
                value={draft.action}
                onChange={(e) => set('action', e.target.value)}
              />
            </Field>
            <Field label={t('对白 / 字幕')} hint={t('只填实际说出的文字；多人对白每行填写“角色：台词”，动作和读音说明单独填写。')}>
              <textarea
                rows={2}
                value={draft.dialogue}
                onChange={(e) => set('dialogue', e.target.value)}
                placeholder={t('留空表示无对白')}
              />
            </Field>
            <Field label={t('说话角色')}>
              <input
                value={draft.speaker}
                onChange={(e) => set('speaker', e.target.value)}
                placeholder={t('无对白时留空；旁白填写“旁白”')}
              />
            </Field>
            <Field label={t('读音备注（不朗读）')} hint={t('每行填写“词语=读音”，例如“重庆=chóng qìng”；数字、英文缩写可写明读法。')}>
              <textarea rows={2} maxLength={2000} value={draft.pronunciationNotes || ''}
                disabled={!state.dialogueRulesReady}
                onChange={(event) => set('pronunciationNotes', event.target.value)} />
            </Field>
            {!state.dialogueRulesReady && <p className="small muted">{t('台词规范更新需在当前任务结束后重启开发版。')}</p>}
            <details className="dialogue-review">
              <summary>{t('实际朗读台词预览')}</summary>
              <DialoguePreview p={p} shot={draft} />
            </details>
            <div className="field-row">
              <Field label={t('运镜')}>
                <input value={draft.camera} onChange={(e) => set('camera', e.target.value)} />
              </Field>
              <Field label={t('光线')}>
                <input value={draft.lighting} onChange={(e) => set('lighting', e.target.value)} />
              </Field>
            </div>
            <Field label={t('关联场景')}>
              <input value={draft.scene} onChange={(e) => set('scene', e.target.value)} />
            </Field>
            <Field label={t('图片提示词')}>
              <textarea
                rows={4}
                value={draft.imagePrompt}
                onChange={(e) => set('imagePrompt', e.target.value)}
              />
            </Field>
            <Field label={t('视频提示词')}>
              <textarea
                rows={4}
                value={draft.videoPrompt}
                onChange={(e) => set('videoPrompt', e.target.value)}
              />
            </Field>
            <Field label={t('随机种子')}>
              <input
                type="number"
                min={0}
                value={draft.seed}
                onChange={(e) => set('seed', Number(e.target.value) || 0)}
              />
            </Field>
            <Field label={t('关联资产')}>
              <div className="asset-checks">
                {p.assets.map((a) => (
                  <label key={a.id}>
                    <input
                      type="checkbox"
                      checked={draft.assetIds.includes(a.id)}
                      onChange={(e) => {
                        set(
                          'assetIds',
                          e.target.checked
                            ? [...draft.assetIds, a.id]
                            : draft.assetIds.filter((id) => id !== a.id),
                        )
                        if (e.target.checked && p.shots.some((s) => s.episodeId === shot.episodeId && s.id !== shot.id))
                          setAssetSuggestion(a.id)
                        else if (assetSuggestion === a.id) setAssetSuggestion(null)
                      }}
                    />
                    {a.name}
                  </label>
                ))}
                {!p.assets.length && <small>{t('在资产库中添加角色、场景和道具。')}</small>}
              </div>
            </Field>
            {assetSuggestion && draft.assetIds.includes(assetSuggestion) && <div className="inspector-asset-suggestion" role="status">
              <p className="small">{t('是否将其他镜头也绑定此资产？')} <strong>{p.assets.find((a) => a.id === assetSuggestion)?.name}</strong></p>
              <div className="field-row"><Button onClick={async () => {
                if (await save()) { setBatchEdit({ source: draft, assetId: assetSuggestion }); setAssetSuggestion(null) }
              }}>{t('选择镜头并应用')}</Button><Button onClick={() => setAssetSuggestion(null)}>{t('仅当前镜头')}</Button></div>
            </div>}
            <label className="check-label">
              <input
                type="checkbox"
                checked={draft.approved}
                onChange={(e) => set('approved', e.target.checked)}
              />
              {t('标记为已审定')}
            </label>
            <div className="field-row">
              <Button
                onClick={() =>
                  void run({ type: 'reorder', projectId: p.id, shotId: shot.id, delta: 'up' })
                }
              >
                <ArrowUp size={13} />
                {t('前移')}
              </Button>
              <Button
                onClick={() =>
                  void run({ type: 'reorder', projectId: p.id, shotId: shot.id, delta: 'down' })
                }
              >
                <ArrowDown size={13} />
                {t('后移')}
              </Button>
              <Button onClick={onDelete} title={t('删除镜头')}>
                <Trash2 size={14} />
              </Button>
            </div>
          </>
        ) : (
          <>
            {(['first', 'last', 'video', 'audio'] as const).map((slot) => (
              <section className="media-section" key={slot}>
                <h4>
                  {
                    {
                      first: t('首帧'),
                      last: t('尾帧'),
                      video: t('生成视频'),
                      audio: t('配音 / 音频'),
                    }[slot]
                  }
                </h4>
                <Preview
                  p={p}
                  mediaId={
                    slot === 'first'
                      ? shot.firstMediaId
                      : slot === 'last'
                        ? shot.lastMediaId
                        : slot === 'video'
                          ? shot.videoMediaId
                          : shot.audioMediaId
                  }
                  slot={slot === 'audio' ? 'audio' : slot === 'video' ? 'video' : 'image'}
                  controls
                />
                <Versions p={p} ownerId={shot.id} slot={slot} />
                <div className="field-row">
                  <Button
                    onClick={() =>
                      void run({ type: 'importMedia', projectId: p.id, ownerId: shot.id, slot })
                    }
                  >
                    <Upload size={13} />
                    {t('导入')}
                  </Button>
                  {slot === 'first' || slot === 'last' ? (
                    <Button
                      onClick={async () => {
                        if (await save()) onGenerate(draft, slot)
                      }}
                    >
                      <ImagePlus size={13} />
                      {t('AI 生图')}
                    </Button>
                  ) : slot === 'video' ? (
                    <Button
                      onClick={async () => {
                        if (await save()) onVideo(draft)
                      }}
                    >
                      <Play size={13} />
                      {t('生成')}
                    </Button>
                  ) : null}
                </div>
              </section>
            ))}
            <Button onClick={() => void run({ type: 'reveal', projectId: p.id })}>
              <ExternalLink size={13} />
              {t('打开项目素材目录')}
            </Button>
          </>
        )}
      </div>
      <footer>
        <span className={dirty ? 'warning' : 'muted'}>
          {saving ? t('正在保存…') : dirty ? t('尚未保存') : t('已保存到本机')}
        </span>
        <Button onClick={() => void save()} disabled={saving}>
          <Check size={14} />
          {t('保存')}
        </Button>
      </footer>
      {batchEdit && <BatchShotDialog p={p} source={batchEdit.source} assetId={batchEdit.assetId} onClose={() => setBatchEdit(null)} />}
    </aside>
  )
}
