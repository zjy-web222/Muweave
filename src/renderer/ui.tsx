import { useT } from './i18n'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { X, Image as ImageIcon, Film, Music2, Loader2 } from 'lucide-react'
import {
  mediaUrl,
  type Command,
  type Media,
  type Project,
  type Reply,
  type Snapshot,
  type AiTask,
} from '../shared/schema'

export const Workspace = createContext<{
  state: Snapshot
  run: (c: Command) => Promise<Reply>
  notice: (s: string) => void
}>(null!)
export const useWorkspace = () => useContext(Workspace)
export function AITaskProgress({ task, runningLabel = 'AI 正在后台生成，完成后自动保存。' }: { task: AiTask; runningLabel?: string }) {
  const t = useT(), { state } = useWorkspace()
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (task.status !== 'running') return
    const refresh = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(task.startedAt || task.createdAt)) / 1000)))
    refresh()
    const timer = setInterval(refresh, 1000)
    return () => clearInterval(timer)
  }, [task.status, task.startedAt, task.createdAt])
  if (!['queued', 'running'].includes(task.status)) return null
  const queued = state.aiTasks.filter((item) => item.status === 'queued').reverse()
  const ahead = Math.max(0, queued.findIndex((item) => item.id === task.id)) +
    (state.aiTasks.some((item) => item.status === 'running') ? 1 : 0)
  return <p className="small muted" role="status">
    {task.status === 'queued' ? t('排队中 · 前面还有 {count} 个任务').replace('{count}', String(ahead)) : t(runningLabel)}
    {task.status === 'running' && <span aria-hidden="true"> {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>}
  </p>
}
export function Button({
  children,
  onClick,
  primary = false,
  disabled = false,
  title,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  primary?: boolean
  disabled?: boolean
  title?: string
  className?: string
}) {
  return (
    <button
      className={`button ${primary ? 'primary' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  )
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}
export function Empty({
  icon,
  heading,
  children,
  action,
}: {
  icon?: ReactNode
  heading: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty">
      {icon || <Film size={30} />}
      <h3>{heading}</h3>
      <p>{children}</p>
      {action}
    </div>
  )
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
      if (e.key === 'Tab') {
        const nodes = ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, textarea, select, [tabindex="0"]',
        )
        if (!nodes?.length) return
        const first = nodes[0],
          last = nodes[nodes.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      prev?.focus()
    }
  }, [])
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? 'wide' : ''}`}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label={t('关闭对话框')} onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}
export function Preview({
  p,
  mediaId,
  slot = 'image',
  controls = false,
}: {
  p: Project
  mediaId?: string
  slot?: string
  controls?: boolean
}) {
  const t = useT()
  const m = p.media.find((m) => m.id === mediaId)
  if (!m)
    return (
      <div className={`media-placeholder ${slot === 'video' ? 'video-placeholder' : ''}`}>
        <div className="placeholder-mark">
          {slot === 'video' ? (
            <Film size={25} strokeWidth={1.3} />
          ) : slot === 'audio' ? (
            <Music2 size={23} />
          ) : (
            <ImageIcon size={25} strokeWidth={1.3} />
          )}
        </div>
        <span>
          {slot === 'video'
            ? t('等待生成视频')
            : slot === 'audio'
              ? t('未导入配音')
              : t('等待参考画面')}
        </span>
      </div>
    )
  if (m.kind === 'video')
    return (
      <video
        src={mediaUrl(p.id, m.id)}
        controls={controls}
        muted={!controls}
        preload="metadata"
        className="media-preview"
      />
    )
  if (m.kind === 'audio')
    return <audio src={mediaUrl(p.id, m.id)} controls className="audio-preview" />
  return <img src={mediaUrl(p.id, m.id)} alt={m.name} className="media-preview" loading="lazy" />
}
export function Versions({
  p,
  ownerId,
  slot,
}: {
  p: Project
  ownerId: string
  slot: Media['slot']
}) {
  const t = useT()
  const { run } = useWorkspace(),
    versions = p.media.filter((m) => m.ownerId === ownerId && m.slot === slot).reverse(),
    s = p.shots.find((s) => s.id === ownerId),
    a = p.assets.find((a) => a.id === ownerId)
  const selected =
    slot === 'reference'
      ? a?.selectedMediaId
      : slot === 'first'
        ? s?.firstMediaId
        : slot === 'last'
          ? s?.lastMediaId
          : slot === 'video'
            ? s?.videoMediaId
            : s?.audioMediaId
  if (!versions.length) return <small className="muted">{t('尚无素材版本')}</small>
  return (
    <div className="versions">
      {versions.map((m, i) => (
        <button
          key={m.id}
          className={m.id === selected ? 'selected' : ''}
          title={`${m.name} · ${new Date(m.createdAt).toLocaleString()}`}
          onClick={() => void run({ type: 'selectMedia', projectId: p.id, mediaId: m.id })}
        >
          v{versions.length - i}
          {m.id === selected && ' ✓'}
        </button>
      ))}
    </div>
  )
}
export const statusNames: Record<string, string> = {
  queued: '待提交',
  submitting: '正在提交',
  running: '远端生成中',
  downloading: '下载素材',
  succeeded: '已完成',
  failed: '失败',
  uncertain: '待核实',
  paused: '已暂停',
  cancelled: '已取消',
}
export function Working() {
  return <Loader2 size={15} className="spin" />
}
