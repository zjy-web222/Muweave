import { describe, expect, it } from 'vitest'
import { createProject } from '../src/main/store'
import { applyShotBatch } from '../src/shared/shots'
import { commandSchema, shotBatchPatchSchema } from '../src/shared/schema'

describe('batch shot editing', () => {
  it('validates only requested fields without supplying defaults for untouched parameters', () => {
    expect(shotBatchPatchSchema.parse({ assetIds: ['asset-one'] })).toEqual({
      assetIds: ['asset-one'],
    })
    expect(() => shotBatchPatchSchema.parse({})).toThrow()
    expect(() => shotBatchPatchSchema.parse({ dialogue: 'overwrite' })).toThrow()
  })

  it('merges assets and preserves dialogue, action, frames and video versions', () => {
    const p = createProject('Batch', '16:9', true),
      shot = p.shots[0],
      asset = p.assets.at(-1)!
    shot.assetIds = [p.assets[0].id]
    shot.videoMediaId = 'existing-video'
    shot.firstMediaId = 'existing-frame'
    const old = structuredClone(shot)
    applyShotBatch(
      p,
      shot.episodeId,
      [shot.id],
      { assetIds: [asset.id], lighting: '暖光' },
      'merge',
    )
    expect(p.shots[0]).toMatchObject({
      ...old,
      lighting: '暖光',
      stale: true,
      assetIds: [...new Set([p.assets[0].id, asset.id])],
    })
    expect(p.shots[1].lighting).not.toBe('暖光')
  })

  it('replaces assets only when explicitly requested, including clearing associations', () => {
    const p = createProject('Batch', '16:9', true),
      shot = p.shots[0]
    applyShotBatch(p, shot.episodeId, [shot.id], { assetIds: [] }, 'replace')
    expect(p.shots[0].assetIds).toEqual([])
    expect(p.shots[0].camera).toBe(shot.camera)
  })

  it('rejects cross-episode targets and missing assets before modifying any shot', () => {
    const p = createProject('Batch', '16:9', true),
      before = structuredClone(p)
    expect(() =>
      applyShotBatch(
        p,
        p.episodes[0].id,
        [p.shots[0].id, 'another-project-shot'],
        { camera: '推近' },
        'merge',
      ),
    ).toThrow('当前集')
    expect(p).toEqual(before)
    expect(() =>
      applyShotBatch(
        p,
        p.episodes[0].id,
        [p.shots[0].id],
        { assetIds: ['foreign-asset'] },
        'merge',
      ),
    ).toThrow('当前项目')
    expect(p).toEqual(before)
    p.episodes.push({ id: 'other-episode', title: 'Second', script: '', scriptChat: [] })
    p.shots[1].episodeId = 'other-episode'
    expect(() =>
      applyShotBatch(p, p.episodes[0].id, [p.shots[0].id, p.shots[1].id], { duration: 8 }, 'merge'),
    ).toThrow('当前集')
  })

  it('bounds batch input and refuses an empty patch at the shared command boundary', () => {
    expect(() =>
      commandSchema.parse({
        type: 'batchShots',
        projectId: 'project',
        episodeId: 'episode',
        shotIds: ['shot'],
        patch: {},
      }),
    ).toThrow()
    expect(
      commandSchema.parse({
        type: 'batchShots',
        projectId: 'project',
        episodeId: 'episode',
        shotIds: ['shot'],
        patch: { camera: '固定' },
      }),
    ).toMatchObject({ assetMode: 'merge' })
  })
})
