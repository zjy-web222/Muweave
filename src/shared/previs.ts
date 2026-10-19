import { z } from 'zod'
import type { Project, Shot } from './schema'

const ref = z.string().min(1).max(100)
export const vec3Schema = z.tuple([
  z.number().finite().min(-500).max(500),
  z.number().finite().min(-500).max(500),
  z.number().finite().min(-500).max(500),
])
export type Vec3 = z.infer<typeof vec3Schema>
export const objectKinds = [
  'person',
  'box',
  'table',
  'chair',
  'wall',
  'door',
  'sphere',
  'model',
] as const
export const poseKinds = ['idle', 'walk', 'run', 'sit', 'wave'] as const
export const objectKeySchema = z.object({
  time: z.number().min(0).max(120),
  position: vec3Schema,
  yaw: z.number().finite().min(-3600).max(3600),
})
export const cameraKeySchema = z.object({
  time: z.number().min(0).max(120),
  position: vec3Schema,
  target: vec3Schema,
  fov: z.number().min(15).max(100),
})
const ordered = <T extends { time: number }>(keys: T[]) =>
  keys.every((key, i) => !i || key.time > keys[i - 1].time)
export const previsObjectSchema = z.object({
  id: ref,
  name: z.string().trim().min(1).max(100),
  kind: z.enum(objectKinds),
  assetId: ref.optional(),
  modelMediaId: ref.optional(),
  position: vec3Schema,
  yaw: z.number().finite().min(-3600).max(3600),
  scale: z.tuple([
    z.number().min(0.05).max(30),
    z.number().min(0.05).max(30),
    z.number().min(0.05).max(30),
  ]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  hidden: z.boolean().default(false),
  locked: z.boolean().default(false),
})
export const previsSceneSchema = z
  .object({
    id: ref,
    name: z.string().trim().min(1).max(100),
    locationAssetId: ref.optional(),
    revision: z.number().int().min(0),
    objects: z.array(previsObjectSchema).max(100),
  })
  .refine(
    (scene) => new Set(scene.objects.map((object) => object.id)).size === scene.objects.length,
    '片场对象 ID 重复',
  )
export const previsPlanSchema = z
  .object({
    sceneId: ref,
    revision: z.number().int().min(0),
    camera: z
      .array(cameraKeySchema)
      .min(1)
      .max(100)
      .refine(ordered, '机位关键帧必须按时间排序且不重复'),
    tracks: z
      .array(
        z.object({
          objectId: ref,
          keys: z
            .array(objectKeySchema)
            .max(100)
            .refine(ordered, '人物关键帧必须按时间排序且不重复'),
          actions: z
            .array(
              z
                .object({
                  start: z.number().min(0).max(120),
                  end: z.number().min(0).max(120),
                  kind: z.enum(poseKinds),
                  speed: z.number().min(0.1).max(4),
                })
                .refine((clip) => clip.end > clip.start, '动作结束时间必须晚于开始时间'),
            )
            .max(40),
        }),
      )
      .max(100),
  })
  .refine(
    (plan) => new Set(plan.tracks.map((track) => track.objectId)).size === plan.tracks.length,
    '对象轨道重复',
  )
export const previsSourceSchema = z.object({
  sceneId: ref,
  sceneRevision: z.number().int().min(0),
  planRevision: z.number().int().min(0),
  duration: z.number().min(1).max(120),
  aspect: z.enum(['16:9', '9:16', '1:1']),
})
export const previsFrameSchema = z.object({
  sessionId: z.string().uuid(),
  index: z.number().int().min(0).max(2879),
})
export type PrevisObject = z.infer<typeof previsObjectSchema>
export type PrevisScene = z.infer<typeof previsSceneSchema>
export type PrevisPlan = z.infer<typeof previsPlanSchema>
export type PrevisSource = z.infer<typeof previsSourceSchema>
export const defaultCamera = (): PrevisPlan['camera'][number] => ({
  time: 0,
  position: [5, 3, 6],
  target: [0, 1, 0],
  fov: 45,
})
export const blankPrevisPlan = (sceneId: string): PrevisPlan => ({
  sceneId,
  revision: 0,
  camera: [defaultCamera()],
  tracks: [],
})
export function previsSource(
  scene: PrevisScene,
  plan: PrevisPlan,
  duration: number,
  aspect: Project['aspect'],
): PrevisSource {
  return {
    sceneId: scene.id,
    sceneRevision: scene.revision,
    planRevision: plan.revision,
    duration,
    aspect,
  }
}
export function isPrevisCurrent(p: Project, shot: Shot) {
  const source = p.media.find(
    (m) => m.id === shot.previsMediaId && m.ownerId === shot.id && m.slot === 'previs',
  )?.previsSource
  const scene = p.previsScenes?.find((s) => s.id === shot.previs?.sceneId)
  return (
    !!source &&
    !!scene &&
    !!shot.previs &&
    JSON.stringify(source) ===
      JSON.stringify(previsSource(scene, shot.previs, shot.duration, p.aspect))
  )
}
export function interpolateKeys<T extends { time: number }>(
  keys: T[],
  time: number,
  lerp: (a: T, b: T, t: number) => T,
): T | undefined {
  if (!keys.length) return undefined
  const next = keys.findIndex((key) => key.time > time)
  if (next === 0) return keys[0]
  if (next < 0) return keys[keys.length - 1]
  const a = keys[next - 1],
    b = keys[next]
  return lerp(a, b, (time - a.time) / (b.time - a.time))
}
const mix = (a: number, b: number, t: number) => a + (b - a) * t
export const mixVector = (a: Vec3, b: Vec3, t: number): Vec3 => [
  mix(a[0], b[0], t),
  mix(a[1], b[1], t),
  mix(a[2], b[2], t),
]
export function objectAt(object: PrevisObject, plan: PrevisPlan, time: number) {
  const track = plan.tracks.find((track) => track.objectId === object.id)
  const key = interpolateKeys(track?.keys || [], time, (a, b, t) => ({
    time,
    position: mixVector(a.position, b.position, t),
    yaw: mix(a.yaw, b.yaw, t),
  }))
  const action = track?.actions.find((clip) => time >= clip.start && time < clip.end)
  return {
    position: key?.position || object.position,
    yaw: key?.yaw ?? object.yaw,
    pose: action?.kind || 'idle',
    phase: (time - (action?.start || 0)) * (action?.speed || 1),
  }
}
export function cameraAt(plan: PrevisPlan, time: number) {
  return interpolateKeys(plan.camera, time, (a, b, t) => ({
    time,
    position: mixVector(a.position, b.position, t),
    target: mixVector(a.target, b.target, t),
    fov: mix(a.fov, b.fov, t),
  }))!
}
export function putKey<T extends { time: number }>(keys: T[], key: T) {
  return [...keys.filter((item) => Math.abs(item.time - key.time) > 0.001), key].sort(
    (a, b) => a.time - b.time,
  )
}
export function validatePrevis(p: Project, scene: PrevisScene, plan: PrevisPlan) {
  if (plan.sceneId !== scene.id) throw new Error('预演与片场不匹配')
  if (
    scene.locationAssetId &&
    !p.assets.some((asset) => asset.id === scene.locationAssetId && asset.kind === 'location')
  )
    throw new Error('片场关联场景不存在')
  for (const object of scene.objects) {
    if (object.assetId && !p.assets.some((asset) => asset.id === object.assetId))
      throw new Error('预演关联资产不存在')
    if (
      object.kind === 'model' &&
      !p.media.some((m) => m.id === object.modelMediaId && m.kind === 'model')
    )
      throw new Error('三维模型素材不存在')
  }
  if (plan.tracks.some((track) => !scene.objects.some((object) => object.id === track.objectId)))
    throw new Error('轨道所属对象不存在')
}
export function validateGlb(bytes: Uint8Array) {
  if (bytes.byteLength < 20 || bytes.byteLength > 50 * 1024 * 1024)
    throw new Error('GLB 模型必须小于 50 MB')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.byteLength ||
    view.getUint32(16, true) !== 0x4e4f534a
  )
    throw new Error('需要有效的 GLB 2.0 模型')
  const size = view.getUint32(12, true)
  if (size > 4 * 1024 * 1024 || 20 + size > bytes.byteLength) throw new Error('GLB 描述过大或损坏')
  const json = z
    .object({
      buffers: z
        .array(z.object({ uri: z.string().optional() }))
        .max(4)
        .optional(),
      images: z
        .array(z.object({ uri: z.string().optional() }))
        .max(32)
        .optional(),
      nodes: z.array(z.unknown()).max(2000).optional(),
      accessors: z
        .array(z.object({ count: z.number().int().min(0).max(500000) }))
        .max(2000)
        .optional(),
      extensionsRequired: z.array(z.string()).optional(),
    })
    .parse(JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + size))))
  if ([...(json.buffers || []), ...(json.images || [])].some((item) => item.uri !== undefined))
    throw new Error('仅支持贴图和缓冲区内嵌的 GLB，不加载外部地址')
  if (
    json.extensionsRequired?.some((name) =>
      ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(
        name,
      ),
    )
  )
    throw new Error('请导出未使用 Draco、Meshopt 或 KTX2 压缩的 GLB')
}
