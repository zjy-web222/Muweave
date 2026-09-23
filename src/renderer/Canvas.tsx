import { useT } from './i18n'
import { useCallback, useEffect, useMemo } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import {
  Clapperboard,
  ImagePlus,
  Play,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react'
import { type Project, type Shot, type Job } from '../shared/schema'
import { Preview, statusNames, useWorkspace } from './ui'
import '@xyflow/react/dist/style.css'

type Data = {
  p: Project
  shot: Shot
  index: number
  kind: 'script' | 'frame' | 'video'
  job?: Job
  active: boolean
  onSelect: () => void
  onImage: () => void
  onVideo: () => void
}
type DirectorNode = Node<Data, 'director'>
function DirectorCard({ data: d }: NodeProps<DirectorNode>) {
  const t = useT()
  return (
    <div className={`canvas-card ${d.active ? 'is-active' : ''} ${d.kind}`}>
      {d.kind !== 'script' && <Handle type="target" position={Position.Left} />}
      <div className="card-type">
        <span>
          {d.kind === 'script' ? (
            <Clapperboard size={13} />
          ) : d.kind === 'frame' ? (
            <ImagePlus size={13} />
          ) : (
            <Play size={13} />
          )}{' '}
          {d.kind === 'script' ? t('镜头脚本') : d.kind === 'frame' ? t('画面设计') : t('视频生成')}
        </span>
        <span className="mono">{String(d.index + 1).padStart(2, '0')}</span>
      </div>
      <button className="card-body nodrag" onClick={d.onSelect}>
        {d.kind === 'script' ? (
          <>
            <h3>{d.shot.title}</h3>
            <p>{d.shot.action || t('为这个镜头写下动作与情绪。')}</p>
            <div className="card-tags">
              <span>{t(d.shot.size)}</span>
              <span>{t(d.shot.camera)}</span>
              <span>{d.shot.duration}s</span>
            </div>
            <div className="dialogue">
              {d.shot.dialogue ? `“${d.shot.dialogue}”` : t('无对白 · 以画面叙事')}
            </div>
          </>
        ) : d.kind === 'frame' ? (
          <div className="frame-pair">
            <div>
              <Preview p={d.p} mediaId={d.shot.firstMediaId} />
              <span>{t('首帧')}</span>
            </div>
            <div>
              <Preview p={d.p} mediaId={d.shot.lastMediaId} />
              <span>{t('尾帧 · 可选')}</span>
            </div>
          </div>
        ) : (
          <div className="node-video">
            <Preview p={d.p} mediaId={d.shot.videoMediaId} slot="video" />
            {d.shot.videoMediaId && (
              <span className="play-overlay">
                <Play size={20} />
              </span>
            )}
          </div>
        )}
      </button>
      <div className="card-bottom nodrag">
        {d.kind === 'script' ? (
          <span>
            {d.shot.approved ? (
              <>
                <CheckCircle2 size={12} /> {t('已审定')}
              </>
            ) : (
              `${d.shot.assetIds.length} ${t('个关联资产')}`
            )}
          </span>
        ) : d.kind === 'frame' ? (
          <span>{d.shot.firstMediaId ? t('已有首帧') : t('ChatGPT · 图片')}</span>
        ) : (
          <span className={d.shot.stale ? 'warning' : ''}>
            {d.shot.stale ? (
              <>
                <AlertCircle size={12} /> {t('输入已变更')}
              </>
            ) : d.job ? (
              t(statusNames[d.job.status])
            ) : (
              'RunningHub'
            )}
          </span>
        )}
        <button
          onClick={d.kind === 'script' ? d.onSelect : d.kind === 'frame' ? d.onImage : d.onVideo}
          aria-label={`${d.kind === 'script' ? t('编辑') : d.kind === 'frame' ? t('生图') : t('生成视频')} ${d.shot.title}`}
        >
          {d.kind === 'script' ? t('编辑') : d.kind === 'frame' ? t('生图') : t('生成')}
          <ChevronRight size={13} />
        </button>
      </div>
      {d.kind !== 'video' && <Handle type="source" position={Position.Right} />}
    </div>
  )
}
const nodeTypes = { director: DirectorCard }
export default function Canvas({
  p,
  shots,
  jobs,
  selected,
  onSelect,
  onImage,
  onVideo,
  onLayout,
}: {
  p: Project
  shots: Shot[]
  jobs: Job[]
  selected: string
  onSelect: (id: string) => void
  onImage: (s: Shot) => void
  onVideo: (s: Shot) => void
  onLayout: (positions: Project['layout'], viewport?: Project['viewport']) => void
}) {
  const { state } = useWorkspace()
  const derived = useMemo(
    () =>
      shots.flatMap((s, index) =>
        (['script', 'frame', 'video'] as const).map((kind, column) => ({
          id: `${s.id}-${kind}`,
          type: 'director' as const,
          position: p.layout[`${s.id}-${kind}`] || { x: column * 318, y: index * 266 },
          data: {
            p,
            shot: s,
            index,
            kind,
            job: jobs.find((j) => j.shotId === s.id),
            active: s.id === selected,
            onSelect: () => onSelect(s.id),
            onImage: () => onImage(s),
            onVideo: () => onVideo(s),
          },
        })),
      ),
    [p, shots, jobs, selected, onSelect, onImage, onVideo],
  )
  const [nodes, setNodes, onNodesChange] = useNodesState<DirectorNode>(derived)
  useEffect(
    () =>
      setNodes((old) =>
        derived.map((n) => ({
          ...n,
          position: old.find((o) => o.id === n.id)?.position || n.position,
        })),
      ),
    [derived, setNodes],
  )
  const edges = useMemo(
    () =>
      shots.flatMap((s) => [
        { id: `${s.id}-a`, source: `${s.id}-script`, target: `${s.id}-frame`, type: 'smoothstep' },
        {
          id: `${s.id}-b`,
          source: `${s.id}-frame`,
          target: `${s.id}-video`,
          type: 'smoothstep',
          animated: jobs.some((j) => j.shotId === s.id && j.status === 'running'),
        },
      ]),
    [shots, jobs],
  )
  const save = useCallback(
    () => onLayout(Object.fromEntries(nodes.map((n) => [n.id, n.position]))),
    [nodes, onLayout],
  )
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={save}
      nodesConnectable={false}
      deleteKeyCode={null}
      minZoom={0.2}
      maxZoom={1.5}
      defaultViewport={p.viewport || { x: 32, y: 32, zoom: 0.96 }}
      onMoveEnd={(_, viewport) => onLayout({}, viewport)}
      colorMode={state.config.theme}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor="var(--line-strong)" maskColor="var(--minimap-mask)" />
    </ReactFlow>
  )
}
