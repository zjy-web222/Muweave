import { useState } from 'react'
import { Layers3 } from 'lucide-react'
import { sameScene } from '../shared/continuity'
import type { Project, Shot, ShotBatchPatch } from '../shared/schema'
import { Button, Field, Modal, useWorkspace } from './ui'
import { useT } from './i18n'

type BatchField = keyof ShotBatchPatch
const fieldLabels: Record<BatchField, string> = {
  assetIds: '关联资产',
  scene: '关联场景',
  size: '景别',
  camera: '运镜',
  lighting: '光线',
  duration: '时长 / 秒',
}

export default function BatchShotDialog({
  p,
  source,
  assetId,
  onClose,
}: {
  p: Project
  source: Shot
  assetId?: string
  onClose: () => void
}) {
  const t = useT(),
    { run } = useWorkspace()
  const others = p.shots.filter(
    (shot) => shot.episodeId === source.episodeId && shot.id !== source.id,
  )
  const sceneShots = others.filter((shot) => sameScene(source, shot, p))
  const [scope, setScope] = useState<'scene' | 'episode' | 'manual'>(
    sceneShots.length ? 'scene' : 'episode',
  )
  const [ids, setIds] = useState((sceneShots.length ? sceneShots : others).map((shot) => shot.id))
  const [fields, setFields] = useState<BatchField[]>(
    assetId || source.assetIds.length ? ['assetIds'] : ['camera', 'lighting'],
  )
  const [assets, setAssets] = useState(assetId ? [assetId] : source.assetIds)
  const [assetMode, setAssetMode] = useState<'merge' | 'replace'>('merge')
  const [applying, setApplying] = useState(false)
  const values: ShotBatchPatch = {
    ...(fields.includes('assetIds') ? { assetIds: assets } : {}),
    ...(fields.includes('scene') ? { scene: source.scene } : {}),
    ...(fields.includes('size') ? { size: source.size } : {}),
    ...(fields.includes('camera') ? { camera: source.camera } : {}),
    ...(fields.includes('lighting') ? { lighting: source.lighting } : {}),
    ...(fields.includes('duration') ? { duration: source.duration } : {}),
  }
  const selected = others.filter((shot) => ids.includes(shot.id))
  return (
    <Modal
      title={t('批量应用镜头设置')}
      wide
      onClose={() => {
        if (!applying) onClose()
      }}
      subtitle={`${t('参数来源')}：${source.title}`}
    >
      <div className="modal-body batch-edit-body">
        <section className="batch-edit-fields">
          <h3>{t('选择要统一的内容')}</h3>
          <p className="small muted">{t('只修改勾选的字段，镜头动作、对白和素材版本保持独立。')}</p>
          {(Object.keys(fieldLabels) as BatchField[]).map((field) => (
            <label className="batch-edit-field" key={field}>
              <input
                type="checkbox"
                checked={fields.includes(field)}
                onChange={(e) =>
                  setFields(
                    e.target.checked ? [...fields, field] : fields.filter((item) => item !== field),
                  )
                }
              />
              <span>{t(fieldLabels[field])}</span>
              <small className="muted">
                {field === 'assetIds'
                  ? assets
                      .map((id) => p.assets.find((asset) => asset.id === id)?.name)
                      .filter(Boolean)
                      .join('、') || t('未选择资产')
                  : String(source[field]) || t('留空')}
              </small>
            </label>
          ))}
          {fields.includes('assetIds') && (
            <div className="batch-edit-assets">
              <div className="asset-checks">
                {p.assets.map((asset) => (
                  <label key={asset.id}>
                    <input
                      type="checkbox"
                      checked={assets.includes(asset.id)}
                      onChange={(e) =>
                        setAssets(
                          e.target.checked
                            ? [...assets, asset.id]
                            : assets.filter((id) => id !== asset.id),
                        )
                      }
                    />
                    {asset.name}
                  </label>
                ))}
                {!p.assets.length && <small>{t('在资产库中添加角色、场景和道具。')}</small>}
              </div>
              <Field label={t('资产绑定方式')}>
                <select
                  value={assetMode}
                  onChange={(e) => setAssetMode(e.target.value === 'replace' ? 'replace' : 'merge')}
                >
                  <option value="merge">{t('追加绑定，保留原有关联')}</option>
                  <option value="replace">{t('替换关联，以勾选资产为准')}</option>
                </select>
              </Field>
              {assetMode === 'replace' && (
                <p className="small danger">
                  {t('将替换目标镜头的全部资产关联；未勾选的原有关联会被移除。')}
                </p>
              )}
            </div>
          )}
        </section>
        <section className="batch-edit-targets">
          <h3>{t('选择目标镜头')}</h3>
          <Field label={t('应用范围')}>
            <select
              value={scope}
              onChange={(e) => {
                const next =
                  e.target.value === 'scene'
                    ? 'scene'
                    : e.target.value === 'episode'
                      ? 'episode'
                      : 'manual'
                setScope(next)
                if (next !== 'manual')
                  setIds((next === 'scene' ? sceneShots : others).map((shot) => shot.id))
              }}
            >
              <option value="scene">
                {t('同场景其他镜头')} ({sceneShots.length})
              </option>
              <option value="episode">
                {t('本集其他镜头')} ({others.length})
              </option>
              <option value="manual">{t('手动选择镜头')}</option>
            </select>
          </Field>
          <div className="row-between batch-selection-toolbar">
            <span className="small muted">
              {t('已选择')} {selected.length} / {others.length}
            </span>
            <div className="field-row">
              <Button
                onClick={() => {
                  setScope('episode')
                  setIds(others.map((shot) => shot.id))
                }}
              >
                {t('全选')}
              </Button>
              <Button
                onClick={() => {
                  setScope('manual')
                  setIds([])
                }}
              >
                {t('清空选择')}
              </Button>
            </div>
          </div>
          <div className="batch-shots batch-edit-shot-list">
            {others.map((shot) => (
              <label key={shot.id}>
                <input
                  type="checkbox"
                  checked={ids.includes(shot.id)}
                  onChange={(e) => {
                    setScope('manual')
                    setIds(
                      e.target.checked ? [...ids, shot.id] : ids.filter((id) => id !== shot.id),
                    )
                  }}
                />
                <span className="batch-shot-detail">
                  {String(
                    p.shots.filter((item) => item.episodeId === source.episodeId).indexOf(shot) + 1,
                  ).padStart(2, '0')}{' '}
                  · {shot.title}
                  <small className="muted">{shot.scene || t('未设置场景')}</small>
                </span>
              </label>
            ))}
            {!others.length && <p className="small muted">{t('本集没有其他镜头')}</p>}
          </div>
        </section>
      </div>
      <div className="modal-footer">
        <span className="small muted">
          {t('将更新')} {selected.length} {t('个镜头')} · {fields.length} {t('项设置')}
        </span>
        <Button onClick={onClose} disabled={applying}>
          {t('返回')}
        </Button>
        <Button
          primary
          disabled={
            applying ||
            !selected.length ||
            !fields.length ||
            (fields.length === 1 &&
              fields[0] === 'assetIds' &&
              !assets.length &&
              assetMode === 'merge')
          }
          onClick={async () => {
            setApplying(true)
            const reply = await run({
              type: 'batchShots',
              projectId: p.id,
              episodeId: source.episodeId,
              shotIds: selected.map((shot) => shot.id),
              patch: values,
              assetMode,
            })
            setApplying(false)
            if (reply.ok) onClose()
          }}
        >
          <Layers3 size={14} />
          {applying ? t('正在应用…') : t('确认批量应用')}
        </Button>
      </div>
    </Modal>
  )
}
