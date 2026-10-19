import {
  shotBatchPatchSchema,
  shotSchema,
  type Project,
  type Shot,
  type ShotBatchPatch,
} from './schema'

export function inputsChanged(current: Shot, snapshot: Shot) {
  return (
    !!current.usePrevis !== !!snapshot.usePrevis ||
    (!!current.usePrevis && current.previsMediaId !== snapshot.previsMediaId) ||
    current.assetIds.join(',') !== snapshot.assetIds.join(',') ||
    [
      'scene',
      'action',
      'dialogue',
      'speaker',
      'pronunciationNotes',
      'size',
      'camera',
      'lighting',
      'imagePrompt',
      'videoPrompt',
      'firstMediaId',
      'lastMediaId',
      'duration',
      'seed',
    ].some((k) => current[k as keyof Shot] !== snapshot[k as keyof Shot])
  )
}

export function relevantAssets(p: Project, shot: Shot) {
  const scene = [shot.title, shot.scene, shot.action, shot.dialogue, shot.speaker, shot.videoPrompt].join(' ')
  const previs = shot.usePrevis ? p.previsScenes?.find((scene) => scene.id === shot.previs?.sceneId) : undefined
  const linked = new Set([...shot.assetIds, ...previs?.objects.filter((object) => !object.hidden).flatMap((object) => object.assetId ? [object.assetId] : []) || [],
    ...(previs?.locationAssetId ? [previs.locationAssetId] : [])])
  return p.assets.filter((asset) => linked.has(asset.id) ||
    (asset.name.length >= 2 && scene.includes(asset.name)))
}

export function applyShotBatch(
  p: Project,
  episodeId: string,
  shotIds: string[],
  patch: ShotBatchPatch,
  assetMode: 'merge' | 'replace',
) {
  const values = shotBatchPatchSchema.parse(patch)
  for (const key of Object.keys(values) as (keyof ShotBatchPatch)[]) {
    if (values[key] === undefined) delete values[key]
  }
  if (!p.episodes.some((episode) => episode.id === episodeId)) throw new Error('集不存在')
  const ids = new Set(shotIds)
  const targets = p.shots.filter((shot) => ids.has(shot.id) && shot.episodeId === episodeId)
  if (!ids.size || targets.length !== ids.size) throw new Error('只能批量修改当前集内存在的镜头')
  if (values.assetIds?.some((id) => !p.assets.some((asset) => asset.id === id)))
    throw new Error('关联资产不存在于当前项目')
  // Validate every target before changing any of them; Store.update saves one revision.
  const updates = targets.map((old) => {
    const next = shotSchema.parse({
      ...old,
      ...values,
      assetIds: values.assetIds
        ? assetMode === 'merge'
          ? [...new Set([...old.assetIds, ...values.assetIds])]
          : values.assetIds
        : old.assetIds,
    })
    next.stale = old.stale || (!!old.videoMediaId && inputsChanged(next, old))
    return next
  })
  const byId = new Map(updates.map((shot) => [shot.id, shot]))
  p.shots = p.shots.map((shot) => byId.get(shot.id) || shot)
}
