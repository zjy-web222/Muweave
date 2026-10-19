import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  Box,
  Camera,
  Plus,
  Play,
  Pause,
  SkipBack,
  Undo2,
  Redo2,
  Trash2,
  Copy,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Move,
  RotateCw,
  Scaling,
  Route,
  Image,
  Film,
  X,
  Upload,
  Save,
  Check,
} from 'lucide-react'
import { z } from 'zod'
import { type Project, type Shot, mediaUrl, randomId } from '../shared/schema'
import {
  blankPrevisPlan,
  defaultCamera,
  objectAt,
  cameraAt,
  putKey,
  isPrevisCurrent,
  poseKinds,
  type PrevisScene,
  type PrevisPlan,
  type PrevisObject,
  type Vec3,
} from '../shared/previs'
import { Button, Field, Preview, Versions, useWorkspace } from './ui'
import { useT } from './i18n'
import type { PrevisStage } from './previs-stage'

type Draft = { scene: PrevisScene; plan: PrevisPlan }
const names: Record<PrevisObject['kind'], string> = {
  person: '人物',
  box: '方块',
  table: '桌子',
  chair: '椅子',
  wall: '墙体',
  door: '门框',
  sphere: '球体',
  model: '模型',
}
const poses: Record<string, string> = {
  idle: '站立',
  walk: '行走',
  run: '奔跑',
  sit: '坐下',
  wave: '挥手',
}
function newObject(kind: PrevisObject['kind'], index: number): PrevisObject {
  return {
    id: randomId(),
    kind,
    name: `${names[kind]} ${index + 1}`,
    position: [0, 0, 0],
    yaw: 0,
    scale: [1, 1, 1],
    color: kind === 'person' ? ['#b77851', '#718f9a', '#8b83a1'][index % 3] : '#a5afa0',
    hidden: false,
    locked: false,
  }
}
function initial(p: Project, shot: Shot): Draft {
  const saved = p.previsScenes?.find((scene) => scene.id === shot.previs?.sceneId)
  if (saved && shot.previs) return structuredClone({ scene: saved, plan: shot.previs })
  const location = p.assets.find(
    (asset) => asset.kind === 'location' && shot.assetIds.includes(asset.id),
  )
  const shared = location && p.previsScenes?.find((scene) => scene.locationAssetId === location.id)
  if (shared) return { scene: structuredClone(shared), plan: blankPrevisPlan(shared.id) }
  const objects: PrevisObject[] = p.assets
    .filter((asset) => asset.kind === 'character' && shot.assetIds.includes(asset.id))
    .slice(0, 6)
    .map((asset, i) => ({
      ...newObject('person', i),
      name: asset.name,
      assetId: asset.id,
      position: [i * 1.6 - 0.8, 0, 0] as Vec3,
    }))
  if (!objects.length) objects.push({ ...newObject('person', 0), assetId: undefined })
  const scene: PrevisScene = {
    id: randomId(),
    name: location?.name || shot.scene || '新片场',
    locationAssetId: location?.id,
    revision: 0,
    objects: [...objects, { ...newObject('table', 0), position: [0, 0, -1.5] }],
  }
  return { scene, plan: blankPrevisPlan(scene.id) }
}
function VectorField({
  label,
  value,
  onChange,
  min = -500,
  max = 500,
}: {
  label: string
  value: Vec3
  onChange(value: Vec3): void
  min?: number
  max?: number
}) {
  const t = useT()
  return (
    <div className="previs-vector">
      <span>{t(label)}</span>
      <div>
        {value.map((v, i) => (
          <label key={i}>
            <small>{'XYZ'[i]}</small>
            <input
              type="number"
              aria-label={`${t(label)} ${'XYZ'[i]}`}
              step="0.1"
              min={min}
              max={max}
              value={Number(v.toFixed(2))}
              onChange={(event) => {
                const next: Vec3 = [...value]
                next[i] = Math.min(max, Math.max(min, Number(event.target.value)))
                onChange(next)
              }}
            />
          </label>
        ))}
      </div>
    </div>
  )
}

export default function Previs({
  p,
  shot,
  shots,
  onSelect,
  beforeLeave,
}: {
  p: Project
  shot: Shot
  shots: Shot[]
  onSelect(id: string): void
  beforeLeave: MutableRefObject<(() => Promise<boolean>) | null>
}) {
  const t = useT(),
    { run, state, notice } = useWorkspace()
  const [draft, setDraft] = useState(() => initial(p, shot)),
    [selected, setSelected] = useState('camera')
  const [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [dirty, setDirty] = useState(!shot.previs)
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false)
  const [stageCreated, setStageCreated] = useState(false)
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [drawing, setDrawing] = useState(false)
  const [points, setPoints] = useState<Vec3[]>([]),
    [snap, setSnap] = useState(true),
    [mode, setMode] = useState<'translate' | 'rotate' | 'scale'>('translate')
  const [view, setView] = useState<'editor' | 'camera' | 'top'>('editor'),
    [action, setAction] = useState('walk'),
    [actionEnd, setActionEnd] = useState(shot.duration)
  const [targetId, setTargetId] = useState(
    draft.scene.objects.find((object) => object.kind === 'person')?.id || '',
  )
  const [compositionId, setCompositionId] = useState(
    p.media.filter((m) => m.ownerId === shot.id && m.slot === 'composition').at(-1)?.id || '',
  )
  const host = useRef<HTMLDivElement>(null),
    stage = useRef<PrevisStage | null>(null),
    latest = useRef(draft),
    dirtyRef = useRef(dirty)
  const saveInFlight = useRef<Promise<boolean> | null>(null),
    undo = useRef<Draft[]>([]),
    redo = useRef<Draft[]>([])
  const rendering = useRef<string | null>(null),
    cancelled = useRef(false),
    callbacks = useRef({
      select: (id: string) => setSelected(id),
      transform: (_id: string, _position: Vec3, _yaw: number, _scale: Vec3) => {},
      point: (_position: Vec3) => {},
      error: (message: string) => setError(message),
    })
  latest.current = draft
  dirtyRef.current = dirty
  const object = draft.scene.objects.find((object) => object.id === selected),
    current = object && objectAt(object, draft.plan, time),
    camera = cameraAt(draft.plan, time)
  const objectTrack = draft.plan.tracks.find((track) => track.objectId === selected)
  const aspect = p.aspect === '16:9' ? 16 / 9 : p.aspect === '9:16' ? 9 / 16 : 1

  function edit(change: (value: Draft) => void) {
    if (busy) return
    undo.current = [...undo.current.slice(-29), structuredClone(latest.current)]
    redo.current = []
    const value = structuredClone(latest.current)
    change(value)
    latest.current = value
    setDraft(value)
    dirtyRef.current = true
    setDirty(true)
    setError('')
  }
  function travel(from: Draft[], to: Draft[]) {
    const value = from.pop()
    if (!value || busy) return
    to.push(structuredClone(latest.current))
    value.scene.revision =
      p.previsScenes?.find((scene) => scene.id === value.scene.id)?.revision || 0
    value.plan.revision = latest.current.plan.revision
    latest.current = value
    setDraft(value)
    setDirty(true)
  }
  async function save(): Promise<boolean> {
    if (saveInFlight.current) {
      if (!(await saveInFlight.current)) return false
      if (dirtyRef.current) return save()
      return true
    }
    if (!dirtyRef.current) return true
    const source = latest.current
    setSaving(true)
    const pending = (async () => {
      const result = await run({
        type: 'savePrevis',
        projectId: p.id,
        shotId: shot.id,
        scene: source.scene,
        plan: source.plan,
      })
      if (!result.ok) {
        setError(result.error)
        return false
      }
      const project = result.state.projects.find((item) => item.id === p.id),
        plan = project?.shots.find((item) => item.id === shot.id)?.previs
      const scene = project?.previsScenes?.find((item) => item.id === source.scene.id)
      if (!plan || !scene) return false
      const changed = latest.current !== source
      const next = changed
        ? {
            scene: { ...latest.current.scene, revision: scene.revision },
            plan: { ...latest.current.plan, revision: plan.revision },
          }
        : { scene, plan }
      latest.current = next
      setDraft(next)
      dirtyRef.current = changed
      setDirty(changed)
      return true
    })()
    saveInFlight.current = pending
    try {
      return await pending
    } finally {
      saveInFlight.current = null
      setSaving(false)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (!dirty || busy || saving || error) return
    const timer = setTimeout(() => {
      void saveRef.current()
    }, 900)
    return () => clearTimeout(timer)
  }, [draft, dirty, busy, saving, error])
  useEffect(() => {
    const previous = beforeLeave.current
    const leave = async () => {
      if (rendering.current) {
        notice(t('请先完成或取消预演导出'))
        return false
      }
      if (!(await saveRef.current())) return false
      return previous ? previous() : true
    }
    beforeLeave.current = leave
    return () => {
      if (beforeLeave.current === leave) beforeLeave.current = previous
    }
  }, [beforeLeave, notice])
  useEffect(() => {
    let disposed = false
    void import('./previs-stage')
      .then(({ PrevisStage }) => {
        if (disposed || !host.current) return
        stage.current = new PrevisStage(host.current, {
          select: (id) => callbacks.current.select(id),
          transform: (...args) => callbacks.current.transform(...args),
          point: (point) => callbacks.current.point(point),
          error: (message) => callbacks.current.error(message),
        })
        setStageCreated(true)
      })
      .catch((error: unknown) =>
        setError(error instanceof Error ? error.message : t('无法启动 3D 预演')),
      )
    return () => {
      disposed = true
      cancelled.current = true
      stage.current?.destroy()
      stage.current = null
      if (rendering.current)
        void window.director.command({
          type: 'previsOutput',
          projectId: p.id,
          shotId: shot.id,
          action: 'cancel',
          sessionId: rendering.current,
        })
    }
  }, [])
  useEffect(() => {
    if (!stageCreated) return
    setReady(false)
    let active = true
    const urls = new Map(
      p.media.filter((m) => m.kind === 'model').map((m) => [m.id, mediaUrl(p.id, m.id)]),
    )
    void stage.current
      ?.setScene(draft.scene, urls)
      .then(() => {
        if (active) {
          stage.current?.setPlan(latest.current.plan, aspect)
          setReady(true)
        }
      })
      .catch((error: unknown) => {
        if (active) setError(error instanceof Error ? error.message : t('模型加载失败'))
      })
    return () => {
      active = false
    }
  }, [draft.scene, stageCreated])
  useEffect(() => {
    stage.current?.setPlan(draft.plan, aspect)
  }, [draft.plan, aspect])
  useEffect(() => {
    stage.current?.seek(time)
  }, [time])
  useEffect(() => {
    stage.current?.select(selected)
  }, [selected, draft.scene, ready])
  useEffect(() => {
    stage.current?.mode(mode)
  }, [mode, ready])
  useEffect(() => {
    stage.current?.setSnap(snap)
  }, [snap, ready])
  useEffect(() => {
    stage.current?.draw(drawing)
  }, [drawing])
  useEffect(() => {
    stage.current?.path(
      drawing
        ? points
        : selected === 'camera'
          ? draft.plan.camera.map((key) => key.position)
          : objectTrack?.keys.map((key) => key.position) || [],
    )
  }, [points, drawing, selected, draft.plan])
  useEffect(() => {
    if (!playing || busy) return
    const start = performance.now(),
      offset = time
    let frame = 0
    const tick = () => {
      const next = offset + (performance.now() - start) / 1000
      setTime(Math.min(shot.duration, next))
      if (next < shot.duration) frame = requestAnimationFrame(tick)
      else setPlaying(false)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, busy])
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        busy ||
        (event.target instanceof HTMLElement && event.target.closest('input,textarea,select'))
      )
        return
      if (event.code === 'Space') {
        event.preventDefault()
        setPlaying((value) => !value)
        if (time >= shot.duration) setTime(0)
      }
      if (event.key.toLowerCase() === 'w') setMode('translate')
      if (event.key.toLowerCase() === 'e') setMode('rotate')
      if (event.key.toLowerCase() === 'r') setMode('scale')
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        travel(
          event.shiftKey ? redo.current : undo.current,
          event.shiftKey ? undo.current : redo.current,
        )
      }
    }
    document.addEventListener('keydown', keyboard)
    return () => document.removeEventListener('keydown', keyboard)
  }, [time, busy, shot.duration])

  function trackFor(value: Draft, id: string) {
    let track = value.plan.tracks.find((track) => track.objectId === id)
    if (!track) {
      track = { objectId: id, keys: [], actions: [] }
      value.plan.tracks.push(track)
    }
    return track
  }
  function transform(id: string, position: Vec3, yaw: number, scale: Vec3) {
    const source = latest.current.scene.objects.find((object) => object.id === id)
    if (!source || source.locked) return
    edit((value) => {
      const object = value.scene.objects.find((object) => object.id === id)!
      object.scale = scale.map((v) => Math.min(30, Math.max(0.05, v))) as Vec3
      if (
        time > 0 ||
        value.plan.tracks.some((track) => track.objectId === id && track.keys.length)
      ) {
        const track = trackFor(value, id)
        if (!track.keys.length && time > 0)
          track.keys.push({ time: 0, position: object.position, yaw: object.yaw })
        track.keys = putKey(track.keys, { time: Math.round(time * 24) / 24, position, yaw })
      } else {
        object.position = position
        object.yaw = yaw
      }
    })
  }
  callbacks.current = {
    select: (id) => {
      if (!busy && !drawing) setSelected(id)
    },
    transform,
    point: (point) => setPoints((points) => [...points.slice(0, 98), point]),
    error: setError,
  }
  function add(kind: PrevisObject['kind'], modelMediaId?: string) {
    if (draft.scene.objects.length >= 100) return
    const next = {
      ...newObject(kind, draft.scene.objects.filter((object) => object.kind === kind).length),
      modelMediaId,
    }
    edit((value) => value.scene.objects.push(next))
    setSelected(next.id)
  }
  function keyframe() {
    edit((value) => {
      if (selected === 'camera')
        value.plan.camera = putKey(value.plan.camera, {
          ...camera,
          time: Math.round(time * 24) / 24,
        })
      else if (object && current && !object.locked) {
        const track = trackFor(value, object.id)
        track.keys = putKey(track.keys, {
          time: Math.round(time * 24) / 24,
          position: current.position,
          yaw: current.yaw,
        })
      }
    })
  }
  function finishPath() {
    if (points.length < 2 || time >= shot.duration) return
    const start = time,
      end = shot.duration,
      pts = [...points]
    edit((value) => {
      if (selected === 'camera')
        value.plan.camera = [
          ...value.plan.camera.filter((key) => key.time < start),
          ...pts.map((point, i) => ({
            time: start + ((end - start) * i) / (pts.length - 1),
            position: [point[0], camera.position[1], point[2]] as Vec3,
            target: camera.target,
            fov: camera.fov,
          })),
        ]
      else if (object && !object.locked) {
        const track = trackFor(value, object.id)
        track.keys = [
          ...track.keys.filter((key) => key.time < start),
          ...pts.map((point, i) => {
            const next = pts[Math.min(pts.length - 1, i + 1)],
              previous = pts[Math.max(0, i - 1)]
            return {
              time: start + ((end - start) * i) / (pts.length - 1),
              position: point,
              yaw: (Math.atan2(next[0] - previous[0], next[2] - previous[2]) * 180) / Math.PI,
            }
          }),
        ]
        if (object.kind === 'person') track.actions = [{ start, end, kind: 'walk', speed: 1 }]
      }
    })
    setDrawing(false)
    setPoints([])
  }
  function cameraPreset(kind: string) {
    const target = draft.scene.objects.find((object) => object.id === targetId)
    const center: Vec3 = target
      ? [target.position[0], target.position[1] + 1, target.position[2]]
      : camera.target
    edit((value) => {
      if (kind === 'orbit') {
        const radius = Math.max(
          2,
          Math.hypot(camera.position[0] - center[0], camera.position[2] - center[2]),
        )
        const angle = Math.atan2(camera.position[2] - center[2], camera.position[0] - center[0])
        value.plan.camera = Array.from({ length: 9 }, (_, i) => ({
          time: (shot.duration * i) / 8,
          fov: camera.fov,
          target: center,
          position: [
            center[0] + Math.cos(angle + (Math.PI * i) / 8) * radius,
            camera.position[1],
            center[2] + Math.sin(angle + (Math.PI * i) / 8) * radius,
          ] as Vec3,
        }))
      } else if (kind === 'follow' && target) {
        const initial = objectAt(target, value.plan, 0).position
        value.plan.camera = Array.from({ length: 9 }, (_, i) => {
          const time = (shot.duration * i) / 8,
            position = objectAt(target, value.plan, time).position
          return {
            time,
            fov: camera.fov,
            target: [position[0], position[1] + 1, position[2]] as Vec3,
            position: camera.position.map((v, axis) => v + position[axis] - initial[axis]) as Vec3,
          }
        })
      } else {
        const end: Vec3 =
          kind === 'push'
            ? (camera.position.map((v, i) => v + (center[i] - v) * 0.35) as Vec3)
            : [camera.position[0] + 3, camera.position[1], camera.position[2]]
        value.plan.camera = [
          { ...camera, time: 0, target: center },
          { ...camera, time: shot.duration, position: end, target: center },
        ]
      }
    })
  }
  async function output(format: 'image' | 'video') {
    setPlaying(false)
    setError('')
    if (!stage.current || !window.director.previsFrame || !(await save())) return
    setBusy(true)
    cancelled.current = false
    setProgress(0)
    try {
      const reply = await run({
        type: 'previsOutput',
        projectId: p.id,
        shotId: shot.id,
        action: 'start',
        format,
        time,
      })
      if (!reply.ok) throw new Error(reply.error)
      const session = z
        .object({
          sessionId: z.string().uuid(),
          width: z.number(),
          height: z.number(),
          count: z.number(),
          fps: z.number(),
        })
        .parse(JSON.parse(reply.text || ''))
      rendering.current = session.sessionId
      for (let index = 0; index < session.count; index++) {
        if (cancelled.current || !stage.current) throw new Error(t('已取消预演导出'))
        const bytes = await stage.current.capture(
          format === 'image'
            ? time
            : session.count === 1
              ? 0
              : (shot.duration * index) / (session.count - 1),
          session.width,
          session.height,
        )
        await window.director.previsFrame(session.sessionId, index, bytes)
        setProgress(Math.round(((index + 1) / session.count) * 95))
      }
      if (cancelled.current) throw new Error(t('已取消预演导出'))
      const result = await run({
        type: 'previsOutput',
        projectId: p.id,
        shotId: shot.id,
        action: 'finish',
        sessionId: session.sessionId,
        format,
      })
      if (!result.ok) throw new Error(result.error)
      if (format === 'image' && result.text) setCompositionId(result.text)
      setProgress(100)
    } catch (error) {
      setError(error instanceof Error ? error.message : t('预演导出失败'))
    } finally {
      if (rendering.current)
        await window.director.command({
          type: 'previsOutput',
          projectId: p.id,
          shotId: shot.id,
          action: 'cancel',
          sessionId: rendering.current,
        })
      rendering.current = null
      setBusy(false)
      stage.current?.seek(time)
    }
  }
  function moveKey(kind: string, keyTime: number, newTime: number) {
    edit((value) => {
      const time = Math.max(0, Math.min(shot.duration, Math.round(newTime * 24) / 24))
      if (kind === 'camera') {
        const key = value.plan.camera.find((key) => key.time === keyTime)
        if (key)
          value.plan.camera = putKey(
            value.plan.camera.filter((key) => key.time !== keyTime),
            { ...key, time },
          )
      } else {
        const track = value.plan.tracks.find((track) => track.objectId === kind),
          key = track?.keys.find((key) => key.time === keyTime)
        if (track && key)
          track.keys = putKey(
            track.keys.filter((key) => key.time !== keyTime),
            { ...key, time },
          )
      }
    })
  }
  const rows = [
    { id: 'camera', name: t('摄影机'), keys: draft.plan.camera, actions: [] },
    ...draft.scene.objects.map((object) => ({
      id: object.id,
      name: object.name,
      keys: draft.plan.tracks.find((track) => track.objectId === object.id)?.keys || [],
      actions: draft.plan.tracks.find((track) => track.objectId === object.id)?.actions || [],
    })),
  ]
  return (
    <section className="previs" aria-label={t('3D 预演台')}>
      <header className="previs-header">
        <div className="previs-title">
          <Box size={18} />
          <strong>{t('3D 预演台')}</strong>
          <span className="small muted" role="status">
            {saving ? t('正在保存…') : dirty ? t('未保存') : t('已保存到本机')}
          </span>
        </div>
        <select
          aria-label={t('预演镜头')}
          value={shot.id}
          disabled={busy}
          onChange={async (event) => {
            if (await save()) onSelect(event.target.value)
          }}
        >
          {shots.map((shot, i) => (
            <option key={shot.id} value={shot.id}>
              {String(i + 1).padStart(2, '0')} · {shot.title}
            </option>
          ))}
        </select>
        <Button disabled={busy || saving || !dirty} onClick={() => void save()}>
          <Save size={13} />
          {t('保存预演')}
        </Button>
        <Button disabled={!ready || busy} onClick={() => void output('image')}>
          <Image size={13} />
          {t('导出构图图')}
        </Button>
        <Button primary disabled={!ready || busy} onClick={() => void output('video')}>
          <Film size={13} />
          {t('导出白模视频')}
        </Button>
      </header>
      {error && (
        <div className="previs-message" role="alert">
          {error}
          <button aria-label={t('关闭提示')} onClick={() => setError('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {busy && (
        <div className="previs-export" role="status">
          <progress max="100" value={progress} />
          <span>{progress >= 95 ? t('正在编码并保存…') : `${t('逐帧渲染')} ${progress}%`}</span>
          <Button
            onClick={() => {
              cancelled.current = true
              if (rendering.current)
                void window.director.command({
                  type: 'previsOutput',
                  projectId: p.id,
                  shotId: shot.id,
                  action: 'cancel',
                  sessionId: rendering.current,
                })
            }}
          >
            {t('取消导出')}
          </Button>
        </div>
      )}
      <div className="previs-workbench">
        <aside className="previs-library">
          <div className="previs-section-title">{t('片场与对象')}</div>
          <Field label={t('当前片场')}>
            <select
              disabled={busy || saving}
              value={draft.scene.id}
              onChange={async (event) => {
                const scene = p.previsScenes?.find((scene) => scene.id === event.target.value)
                if (scene && (await save())) {
                  edit((value) => {
                    value.scene = structuredClone(scene)
                    value.plan = {
                      ...blankPrevisPlan(scene.id),
                      revision: latest.current.plan.revision,
                    }
                  })
                  setSelected('camera')
                }
              }}
            >
              <option value={draft.scene.id}>{draft.scene.name}</option>
              {p.previsScenes
                ?.filter((scene) => scene.id !== draft.scene.id)
                .map((scene) => (
                  <option key={scene.id} value={scene.id}>
                    {scene.name}
                  </option>
                ))}
            </select>
          </Field>
          <Button
            disabled={busy || saving}
            onClick={() =>
              edit((value) => {
                value.scene = {
                  ...value.scene,
                  id: randomId(),
                  revision: 0,
                  name: `${value.scene.name} · ${t('副本')}`,
                }
                value.plan.sceneId = value.scene.id
              })
            }
          >
            <Copy size={12} />
            {t('复制片场')}
          </Button>
          <div className="previs-objects">
            <button
              className={selected === 'camera' ? 'active' : ''}
              onClick={() => setSelected('camera')}
            >
              <Camera size={14} />
              <span>{t('摄影机')}</span>
            </button>
            {draft.scene.objects.map((object) => (
              <div
                className={`previs-object ${selected === object.id ? 'active' : ''}`}
                key={object.id}
              >
                <button disabled={busy} onClick={() => setSelected(object.id)}>
                  <i style={{ background: object.color }} />
                  <span>{object.name}</span>
                </button>
                <button
                  aria-label={`${t(object.hidden ? '显示' : '隐藏')} ${object.name}`}
                  disabled={busy || object.locked}
                  onClick={() =>
                    edit((value) => {
                      const item = value.scene.objects.find((item) => item.id === object.id)!
                      item.hidden = !item.hidden
                    })
                  }
                >
                  {object.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
                <button
                  aria-label={`${t(object.locked ? '解锁' : '锁定')} ${object.name}`}
                  disabled={busy}
                  onClick={() =>
                    edit((value) => {
                      const item = value.scene.objects.find((item) => item.id === object.id)!
                      item.locked = !item.locked
                    })
                  }
                >
                  {object.locked ? <Lock size={12} /> : <Unlock size={12} />}
                </button>
              </div>
            ))}
          </div>
          <div className="previs-section-title">{t('添加资源')}</div>
          <div className="previs-resources">
            {(['person', 'table', 'chair', 'wall', 'door', 'box', 'sphere'] as const).map(
              (kind) => (
                <Button
                  key={kind}
                  disabled={busy || draft.scene.objects.length >= 100}
                  onClick={() => add(kind)}
                >
                  <Plus size={12} />
                  {t(names[kind])}
                </Button>
              ),
            )}
          </div>
          <Button
            disabled={busy}
            onClick={async () => {
              const reply = await run({
                type: 'importMedia',
                projectId: p.id,
                ownerId: shot.id,
                slot: 'model',
              })
              if (reply.ok) {
                const model = reply.state.projects
                  .find((item) => item.id === p.id)
                  ?.media.filter((m) => m.kind === 'model')
                  .at(-1)
                if (model && !p.media.some((m) => m.id === model.id)) add('model', model.id)
              }
            }}
          >
            <Upload size={12} />
            {t('导入 GLB 模型')}
          </Button>
          <p className="small muted">{t('内嵌贴图 GLB · 最大 50 MB')}</p>
          <Button
            disabled={busy}
            onClick={() =>
              edit((value) => {
                if (value.scene.objects.length > 97) return
                value.scene.objects.push(
                  { ...newObject('wall', 0), position: [0, 0, -4] },
                  { ...newObject('wall', 1), position: [-4, 0, 0], yaw: 90 },
                  { ...newObject('door', 0), position: [3, 0, -2] },
                )
              })
            }
          >
            {t('添加房间模板')}
          </Button>
        </aside>
        <div className="previs-stage-column">
          <div className="previs-stage-toolbar">
            <div className="segmented">
              {(
                [
                  ['translate', Move, '移动'],
                  ['rotate', RotateCw, '旋转'],
                  ['scale', Scaling, '缩放'],
                ] as const
              ).map(([id, Icon, label]) => (
                <button
                  key={id}
                  disabled={busy}
                  className={mode === id ? 'active' : ''}
                  onClick={() => setMode(id)}
                  title={`${t(label)} · ${id === 'translate' ? 'W' : id === 'rotate' ? 'E' : 'R'}`}
                  aria-label={t(label)}
                >
                  <Icon size={14} />
                </button>
              ))}
            </div>
            <button
              className="icon-button"
              aria-label={t('撤销')}
              disabled={busy || !undo.current.length}
              onClick={() => travel(undo.current, redo.current)}
            >
              <Undo2 size={14} />
            </button>
            <button
              className="icon-button"
              aria-label={t('重做')}
              disabled={busy || !redo.current.length}
              onClick={() => travel(redo.current, undo.current)}
            >
              <Redo2 size={14} />
            </button>
            <label className="previs-check">
              <input
                type="checkbox"
                checked={snap}
                onChange={(event) => setSnap(event.target.checked)}
              />
              {t('吸附')}
            </label>
            <select
              aria-label={t('观察视角')}
              value={view}
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value as typeof view
                setView(next)
                stage.current?.view(next)
              }}
            >
              <option value="editor">{t('导演视角')}</option>
              <option value="top">{t('俯视')}</option>
              <option value="camera">{t('摄影机视角')}</option>
            </select>
          </div>
          <div className="previs-stage" ref={host}>
            {!ready && !error && <span className="previs-loading">{t('正在准备 3D 视窗…')}</span>}
            <div className="previs-stage-caption">
              <span>
                {p.aspect} · {shot.duration}s
              </span>
              <span>{view === 'camera' ? t('摄影机视角') : t('实时取景')}</span>
            </div>
          </div>
          <div className="previs-stage-help">
            {drawing
              ? t('在地面点击布点，完成后应用轨迹。')
              : t('拖动环绕 · 中键平移 · 滚轮缩放 · W/E/R 变换')}
            <Button
              disabled={busy || !selected || !!object?.locked || time >= shot.duration}
              onClick={() => {
                setPlaying(false)
                setDrawing(!drawing)
                setPoints([])
              }}
            >
              <Route size={13} />
              {t(drawing ? '取消绘制' : '绘制轨迹')}
            </Button>
            {drawing && (
              <Button primary disabled={points.length < 2} onClick={finishPath}>
                {t('应用轨迹')} · {points.length}
              </Button>
            )}
          </div>
        </div>
        <aside className="previs-properties">
          <div className="previs-section-title">
            {t(selected === 'camera' ? '摄影机参数' : object ? '对象属性' : '片场属性')}
          </div>
          <fieldset disabled={busy || !!object?.locked}>
            {selected === 'camera' ? (
              <>
                <VectorField
                  label="机位位置"
                  value={camera.position}
                  onChange={(position) =>
                    edit((value) => {
                      value.plan.camera = putKey(value.plan.camera, {
                        ...camera,
                        time: Math.round(time * 24) / 24,
                        position,
                      })
                    })
                  }
                />
                <VectorField
                  label="注视位置"
                  value={camera.target}
                  onChange={(target) =>
                    edit((value) => {
                      value.plan.camera = putKey(value.plan.camera, {
                        ...camera,
                        time: Math.round(time * 24) / 24,
                        target,
                      })
                    })
                  }
                />
                <Field label={t('视野角度 FOV')}>
                  <input
                    aria-label={t('视野角度 FOV')}
                    type="number"
                    min="15"
                    max="100"
                    value={Math.round(camera.fov)}
                    onChange={(event) =>
                      edit((value) => {
                        value.plan.camera = putKey(value.plan.camera, {
                          ...camera,
                          time: Math.round(time * 24) / 24,
                          fov: Math.max(15, Math.min(100, Number(event.target.value))),
                        })
                      })
                    }
                  />
                </Field>
                <Button
                  disabled={busy}
                  onClick={() => {
                    const camera = stage.current?.currentCamera()
                    if (camera)
                      edit((value) => {
                        value.plan.camera = putKey(value.plan.camera, camera)
                      })
                  }}
                >
                  {t('当前视角设为机位')}
                </Button>
                <Field label={t('运镜主体')}>
                  <select
                    aria-label={t('运镜主体')}
                    value={targetId}
                    onChange={(event) => setTargetId(event.target.value)}
                  >
                    <option value="">{t('当前注视点')}</option>
                    {draft.scene.objects.map((object) => (
                      <option key={object.id} value={object.id}>
                        {object.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="previs-resources">
                  {[
                    ['push', '推近'],
                    ['pan', '平移'],
                    ['orbit', '环绕'],
                    ['follow', '跟随'],
                  ].map(([id, label]) => (
                    <Button
                      key={id}
                      disabled={busy || (id === 'follow' && !targetId)}
                      onClick={() => cameraPreset(id)}
                    >
                      {t(label)}
                    </Button>
                  ))}
                </div>
                <Button
                  disabled={busy}
                  onClick={() =>
                    edit((value) => {
                      value.plan.camera = [defaultCamera()]
                    })
                  }
                >
                  {t('重置机位')}
                </Button>
              </>
            ) : object && current ? (
              <>
                <Field label={t('对象名称')}>
                  <input
                    aria-label={t('对象名称')}
                    value={object.name}
                    onChange={(event) =>
                      edit((value) => {
                        value.scene.objects.find((item) => item.id === object.id)!.name =
                          event.target.value || names[object.kind]
                      })
                    }
                  />
                </Field>
                <Field label={t('关联资产')}>
                  <select
                    aria-label={t('关联资产')}
                    value={object.assetId || ''}
                    onChange={(event) =>
                      edit((value) => {
                        value.scene.objects.find((item) => item.id === object.id)!.assetId =
                          event.target.value || undefined
                      })
                    }
                  >
                    <option value="">{t('未关联')}</option>
                    {p.assets
                      .filter((asset) =>
                        object.kind === 'person'
                          ? asset.kind === 'character'
                          : asset.kind !== 'character',
                      )
                      .map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <VectorField
                  label="位置"
                  value={current.position}
                  onChange={(position) => transform(object.id, position, current.yaw, object.scale)}
                />
                <Field label={t('朝向（度）')}>
                  <input
                    aria-label={t('朝向（度）')}
                    type="number"
                    step="5"
                    min="-3600"
                    max="3600"
                    value={Math.round(current.yaw)}
                    onChange={(event) =>
                      transform(
                        object.id,
                        current.position,
                        Math.max(-3600, Math.min(3600, Number(event.target.value))),
                        object.scale,
                      )
                    }
                  />
                </Field>
                <VectorField
                  label="尺寸"
                  min={0.05}
                  max={30}
                  value={object.scale}
                  onChange={(scale) => transform(object.id, current.position, current.yaw, scale)}
                />
                <Field label={t('标识颜色')}>
                  <input
                    aria-label={t('标识颜色')}
                    type="color"
                    value={object.color}
                    onChange={(event) =>
                      edit((value) => {
                        value.scene.objects.find((item) => item.id === object.id)!.color =
                          event.target.value
                      })
                    }
                  />
                </Field>
                {object.kind === 'person' && (
                  <>
                    <div className="previs-section-title">{t('基础动作')}</div>
                    <select
                      aria-label={t('基础动作')}
                      value={action}
                      onChange={(event) => setAction(event.target.value)}
                    >
                      {poseKinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {t(poses[kind])}
                        </option>
                      ))}
                    </select>
                    <Field label={t('动作结束时间')}>
                      <input
                        aria-label={t('动作结束时间')}
                        type="number"
                        step="0.1"
                        min={time}
                        max={shot.duration}
                        value={actionEnd}
                        onChange={(event) =>
                          setActionEnd(Math.min(shot.duration, Number(event.target.value)))
                        }
                      />
                    </Field>
                    <Button
                      disabled={busy || actionEnd <= time}
                      onClick={() =>
                        edit((value) => {
                          const track = trackFor(value, object.id)
                          track.actions = [
                            ...track.actions.filter(
                              (clip) => clip.end <= time || clip.start >= actionEnd,
                            ),
                            {
                              start: time,
                              end: actionEnd,
                              kind: action as (typeof poseKinds)[number],
                              speed: 1,
                            },
                          ]
                        })
                      }
                    >
                      {t('从当前时间添加动作')}
                    </Button>
                  </>
                )}
                <div className="previs-resources">
                  <Button
                    disabled={busy || draft.scene.objects.length >= 100}
                    onClick={() => {
                      const copy = {
                        ...structuredClone(object),
                        id: randomId(),
                        name: `${object.name} · ${t('副本')}`,
                        position: [
                          object.position[0] + 1,
                          object.position[1],
                          object.position[2],
                        ] as Vec3,
                      }
                      edit((value) => value.scene.objects.push(copy))
                      setSelected(copy.id)
                    }}
                  >
                    <Copy size={12} />
                    {t('复制')}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      edit((value) => {
                        value.scene.objects = value.scene.objects.filter(
                          (item) => item.id !== object.id,
                        )
                        value.plan.tracks = value.plan.tracks.filter(
                          (track) => track.objectId !== object.id,
                        )
                      })
                      setSelected('camera')
                    }}
                  >
                    <Trash2 size={12} />
                    {t('删除')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Field label={t('片场名称')}>
                  <input
                    value={draft.scene.name}
                    onChange={(event) =>
                      edit((value) => {
                        value.scene.name = event.target.value || t('新片场')
                      })
                    }
                  />
                </Field>
                <Field label={t('关联场景')}>
                  <select
                    value={draft.scene.locationAssetId || ''}
                    onChange={(event) =>
                      edit((value) => {
                        value.scene.locationAssetId = event.target.value || undefined
                      })
                    }
                  >
                    <option value="">{t('未关联')}</option>
                    {p.assets
                      .filter((asset) => asset.kind === 'location')
                      .map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.name}
                        </option>
                      ))}
                  </select>
                </Field>
              </>
            )}
          </fieldset>
          {object?.locked && <p className="small muted">{t('对象已锁定，请在左侧解锁后编辑。')}</p>}
        </aside>
      </div>
      <div className="previs-timeline">
        <div className="previs-transport">
          <Button
            disabled={busy}
            onClick={() => {
              setPlaying(false)
              setTime(0)
            }}
          >
            <SkipBack size={13} />
          </Button>
          <Button
            disabled={busy || !ready}
            onClick={() => {
              if (time >= shot.duration) setTime(0)
              setPlaying(!playing)
            }}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
            {t(playing ? '暂停' : '播放')}
          </Button>
          <span className="mono">
            {time.toFixed(2)} / {shot.duration.toFixed(2)} s · 24 FPS
          </span>
          <Button disabled={busy || !selected || !!object?.locked} onClick={keyframe}>
            ＋ {t('关键帧')}
          </Button>
          <Button
            disabled={busy || !!object?.locked}
            onClick={() =>
              edit((value) => {
                if (selected === 'camera') {
                  if (value.plan.camera.length > 1)
                    value.plan.camera = value.plan.camera.filter(
                      (key) => Math.abs(key.time - time) > 1 / 24,
                    )
                } else {
                  const track = value.plan.tracks.find((track) => track.objectId === selected)
                  if (track) {
                    track.keys = track.keys.filter((key) => Math.abs(key.time - time) > 1 / 24)
                    track.actions = track.actions.filter(
                      (clip) => time < clip.start || time >= clip.end,
                    )
                  }
                }
              })
            }
          >
            {t('删除当前关键帧 / 动作')}
          </Button>
        </div>
        <input
          className="previs-scrubber"
          aria-label={t('预演时间')}
          type="range"
          min="0"
          max={shot.duration}
          step={1 / 24}
          value={time}
          disabled={busy}
          onChange={(event) => {
            setPlaying(false)
            setTime(Number(event.target.value))
          }}
        />
        <div className="previs-tracks">
          {rows.map((row) => (
            <div className={`previs-track ${selected === row.id ? 'active' : ''}`} key={row.id}>
              <button className="previs-track-name" onClick={() => setSelected(row.id)}>
                {row.id === 'camera' ? <Camera size={12} /> : <Box size={12} />}
                {row.name}
              </button>
              <div className="previs-track-lane">
                {row.actions.map((clip, i) => (
                  <button
                    key={`clip-${i}`}
                    className="previs-action-clip"
                    style={{
                      left: `${(clip.start / shot.duration) * 100}%`,
                      width: `${((clip.end - clip.start) / shot.duration) * 100}%`,
                    }}
                    onClick={() => {
                      setSelected(row.id)
                      setTime(clip.start)
                    }}
                  >
                    {t(poses[clip.kind])}
                  </button>
                ))}
                {row.keys.map((key) => (
                  <button
                    key={key.time}
                    className="previs-keyframe"
                    aria-label={`${row.name} ${t('关键帧')} ${key.time.toFixed(2)}s`}
                    style={{ left: `${(key.time / shot.duration) * 100}%` }}
                    disabled={
                      busy || draft.scene.objects.find((object) => object.id === row.id)?.locked
                    }
                    onClick={() => {
                      setSelected(row.id)
                      setPlaying(false)
                      setTime(key.time)
                    }}
                    onPointerDown={(event) => {
                      const rect = event.currentTarget.parentElement!.getBoundingClientRect(),
                        start = event.clientX
                      const up = (event: PointerEvent) => {
                        if (Math.abs(event.clientX - start) > 4)
                          moveKey(
                            row.id,
                            key.time,
                            ((event.clientX - rect.left) / rect.width) * shot.duration,
                          )
                      }
                      document.addEventListener('pointerup', up, { once: true })
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                        event.preventDefault()
                        moveKey(
                          row.id,
                          key.time,
                          key.time + (event.key === 'ArrowRight' ? 1 : -1) / 24,
                        )
                      }
                    }}
                  >
                    ◆
                  </button>
                ))}
                <i
                  className="previs-playhead"
                  style={{ left: `${(time / shot.duration) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        {shot.dialogue && (
          <p className="previs-dialogue">
            <span>{t('当前对白')}</span>
            {shot.dialogue}
          </p>
        )}
      </div>
      <footer className="previs-results">
        <div>
          <strong>{t('镜头预演素材')}</strong>
          <p className="small muted">
            {t('白模只参考空间、动作和运镜；外观沿用正式资产，结果需逐镜审看。')}
          </p>
        </div>
        <div className="previs-result">
          <div className="previs-result-thumb">
            <Preview p={p} mediaId={compositionId} />
          </div>
          <div>
            <span>{t('构图图')}</span>
            <select
              aria-label={t('构图图版本')}
              value={compositionId}
              onChange={(event) => setCompositionId(event.target.value)}
            >
              <option value="">{t('尚无素材版本')}</option>
              {p.media
                .filter((m) => m.ownerId === shot.id && m.slot === 'composition')
                .map((m, i) => (
                  <option key={m.id} value={m.id}>
                    v{i + 1} · {new Date(m.createdAt).toLocaleTimeString()}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <div className="previs-result">
          <div className="previs-result-thumb">
            <Preview p={p} mediaId={shot.previsMediaId} controls />
          </div>
          <div>
            <span>
              {t('白模视频')}{' '}
              {shot.previsMediaId && (
                <small className={!dirty && isPrevisCurrent(p, shot) ? 'success' : 'warning'}>
                  {t(!dirty && isPrevisCurrent(p, shot) ? '当前版本' : '需重新导出')}
                </small>
              )}
            </span>
            <Versions p={p} ownerId={shot.id} slot="previs" />
          </div>
        </div>
        <label className="previs-check previs-use">
          <input
            aria-label={t('视频生成使用预演参考')}
            type="checkbox"
            checked={shot.usePrevis || false}
            disabled={
              busy ||
              saving ||
              (state.config.models.video.provider !== 'runninghub' && !shot.usePrevis)
            }
            onChange={(event) =>
              void run({
                type: 'shot',
                projectId: p.id,
                shot: { ...shot, usePrevis: event.target.checked },
              })
            }
          />
          <span>
            {t('视频生成使用预演参考')}
            <small>{t('RunningHub · H3 Ref2VA')}</small>
          </span>
        </label>
      </footer>
    </section>
  )
}
