import type { Job, Project, Shot } from './schema'

export function sameScene(previous: Shot | undefined, shot: Shot, p: Project) {
  if (!previous || previous.episodeId !== shot.episodeId) return false
  const before = previous.scene.trim(),
    after = shot.scene.trim()
  if (before && after) {
    if (before === after) return true
    const [beforePlace, ...beforeContext] = before.split('·').map((part) => part.trim())
    const [afterPlace, ...afterContext] = after.split('·').map((part) => part.trim())
    const shorter = beforePlace.length <= afterPlace.length ? beforePlace : afterPlace
    const longer = beforePlace.length > afterPlace.length ? beforePlace : afterPlace
    return (
      beforeContext.join('·') === afterContext.join('·') &&
      shorter.length >= 4 &&
      longer.startsWith(shorter) &&
      longer.length - shorter.length <= 8
    )
  }
  const locations = new Set(p.assets.filter((a) => a.kind === 'location').map((a) => a.id))
  const sharedLocation = previous.assetIds.some(
    (id) => locations.has(id) && shot.assetIds.includes(id),
  )
  return (
    sharedLocation ||
    (!before &&
      !after &&
      !previous.assetIds.some((id) => locations.has(id)) &&
      !shot.assetIds.some((id) => locations.has(id)))
  )
}

const pending = new Set<Job['status']>([
  'queued',
  'submitting',
  'running',
  'downloading',
  'uncertain',
  'paused',
])
export type VideoBoundary = { shotId: string; videoMediaId?: string }

// Selected predecessors must supply their NEW output, never the old version they replace.
// A successor is an end target only when it is retained, avoiding forward dependency cycles.
export function planVideoContinuity(
  p: Project,
  shot: Shot,
  selected: ReadonlySet<string>,
  jobs: Job[] = [],
) {
  const shots = p.shots.filter((s) => s.episodeId === shot.episodeId)
  const position = shots.findIndex((s) => s.id === shot.id)
  const before = shots[position - 1],
    after = shots[position + 1]
  const videoId = (s: Shot) =>
    p.media.find(
      (m) =>
        m.id === s.videoMediaId && m.ownerId === s.id && m.kind === 'video' && m.slot === 'video',
    )?.id
  const active = (s: Shot) =>
    jobs.some((j) => j.projectId === p.id && j.shotId === s.id && pending.has(j.status))
  let previous: VideoBoundary | undefined, next: VideoBoundary | undefined
  if (before && sameScene(before, shot, p)) {
    if (selected.has(before.id) || active(before)) previous = { shotId: before.id }
    else if (videoId(before)) previous = { shotId: before.id, videoMediaId: videoId(before) }
  }
  if (
    after &&
    sameScene(shot, after, p) &&
    !selected.has(after.id) &&
    !active(after) &&
    videoId(after)
  )
    next = { shotId: after.id, videoMediaId: videoId(after) }
  return { previous, next }
}

export function videoBoundaryContext(p: Project, job: Job) {
  const previous = p.shots.find((s) => s.id === job.previousShotId)
  const next = p.shots.find((s) => s.id === job.nextShotId)
  const describe = (s: Shot) =>
    `${s.title}; scene: ${s.scene}; action: ${s.action.slice(0, 350)}; camera: ${s.camera.slice(0, 100)}; lighting: ${s.lighting.slice(0, 100)}`
  return [
    previous
      ? `Continuity before this shot (context only): ${describe(previous)}. Continue from its completed final state, never replay its action or speech.`
      : '',
    next
      ? `Continuity after this shot (context only): ${describe(next)}. End in the supplied successor opening state, ready for its action. Do not perform the successor's action or speak its dialogue in this shot.`
      : '',
    'Bridge only the current screenplay action between the supplied boundary states with physically plausible motion, coherent screen direction, eyelines, props and camera movement. No teleporting, time jumps, added events or unrelated scene changes. Boundary references do not authorize rewriting the screenplay.',
  ]
    .filter(Boolean)
    .join('\n')
}
