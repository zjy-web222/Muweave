import { useT } from './i18n'
import { providerNames } from '../shared/models'
import { ScriptPolishOptions } from './ScriptPolish'
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  Plus,
  Upload,
  WandSparkles,
  UserRound,
  MapPin,
  Package,
  ImagePlus,
  Trash2,
  Check,
  FileText,
  Play,
  Pause,
  RotateCcw,
  Link2,
  X,
  FolderOpen,
  PencilLine,
  MessageSquareText,
  ChevronLeft,
  ChevronRight,
  Paperclip,
} from 'lucide-react'
import { mediaUrl, type AiTask, type Asset, type Job, type Project, type Shot } from '../shared/schema'
import { AITaskProgress, Button, Empty, Field, Modal, Preview, statusNames, useWorkspace, Versions } from './ui'

export function ScriptEditor({
  p,
  active,
  episodeId,
  onEpisodeChange,
  beforeEpisodeChange,
}: {
  p: Project
  active: boolean
  episodeId: string
  onEpisodeChange: (id: string) => Promise<void>
  beforeEpisodeChange: MutableRefObject<(() => Promise<boolean>) | null>
}) {
  const t = useT()
  const { run, notice, state } = useWorkspace(),
    ep = p.episodes.find((e) => e.id === episodeId)!,
    episodeIndex = p.episodes.findIndex((e) => e.id === episodeId),
    [script, setScript] = useState(ep.script),
    [title, setTitle] = useState(ep.title),
    [dirty, setDirty] = useState(false),
    [chatRequest, setChatRequest] = useState(''),
    [chatBusy, setChatBusy] = useState(false),
    [attachedFiles, setAttachedFiles] = useState<{ id: string; name: string; size: number }[]>([]),
    [accountConnected, setAccountConnected] = useState<boolean | null | 'error'>(null)
  const draftRef = useRef({ episodeId, title: ep.title, script: ep.script, dirty: false })
  const historyRef = useRef<HTMLDivElement>(null)
  const chatTasks = state.aiTasks.filter((task) => task.projectId === p.id && task.request.type === 'scriptChatGenerate')
  const pendingChat = chatTasks.filter((task) => ['queued', 'running', 'failed', 'cancelled'].includes(task.status)).reverse()
  const turns = p.episodes
    .flatMap((episode, index) =>
      episode.scriptChat.map((turn, order) => ({ episode, index, order, turn })),
    )
    .sort(
      (a, b) =>
        a.turn.createdAt.localeCompare(b.turn.createdAt) || a.index - b.index || a.order - b.order,
    )
  useLayoutEffect(() => {
    if (draftRef.current.episodeId === ep.id && draftRef.current.dirty &&
        (draftRef.current.script !== ep.script || draftRef.current.title !== ep.title)) return
    draftRef.current = { episodeId: ep.id, title: ep.title, script: ep.script, dirty: false }
    setScript(ep.script)
    setTitle(ep.title)
    setDirty(false)
  }, [ep.id, ep.script, ep.title])
  useEffect(() => {
    const refresh = () => {
      void run(state.modelServicesReady ? { type: 'modelStatus', channel: 'text' } : { type: 'codexStatus' }).then((r) => {
        setAccountConnected(r.ok ? r.text === 'connected' : 'error')
      })
    }
    refresh()
    window.addEventListener('director:codex-login', refresh)
    return () => window.removeEventListener('director:codex-login', refresh)
  }, [p.id, run, state.modelServicesReady, state.config.models.text.provider, state.config.models.text.model, state.config.models.text.region, JSON.stringify(state.credentials)])
  async function save() {
    const draft = { ...draftRef.current }
    const r = await run({ type: 'episode', projectId: p.id, episodeId: draft.episodeId,
      title: draft.title, script: draft.script })
    if (r.ok && draftRef.current.episodeId === draft.episodeId &&
        draftRef.current.title === draft.title && draftRef.current.script === draft.script) {
      draftRef.current.dirty = false
      setDirty(false)
    }
    return r.ok
  }
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const guard = async () => !draftRef.current.dirty || (await saveRef.current())
    beforeEpisodeChange.current = guard
    return () => {
      if (beforeEpisodeChange.current === guard) beforeEpisodeChange.current = null
    }
  }, [beforeEpisodeChange])
  useEffect(() => {
    if (active && historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight
  }, [active, turns.length, pendingChat.length, p.id])
  async function pickFiles() {
    if (attachedFiles.length >= 10) return
    const r = await run({
      type: 'scriptChatPickFiles',
      projectId: p.id,
      max: 10 - attachedFiles.length,
    })
    if (r.ok && r.text) {
      const picked = JSON.parse(r.text) as { id: string; name: string; size: number }[]
      setAttachedFiles((current) => [...current, ...picked])
    }
  }
  async function sendChatRequest() {
    const request = chatRequest.trim()
    if ((!request && !attachedFiles.length) || chatBusy) return
    setChatBusy(true)
    try {
      if (draftRef.current.dirty && !(await save())) return
      const generated = await run({
        type: 'aiEnqueue',
        request: { type: 'scriptChatGenerate', projectId: p.id, episodeId, request,
          attachmentIds: attachedFiles.map((file) => file.id) },
      })
      if (generated.ok) {
        setChatRequest('')
        setAttachedFiles([])
      }
    } finally {
      setChatBusy(false)
    }
  }
  async function applyChatScript(next: string, targetEpisodeId: string) {
    if (chatBusy) return
    setChatBusy(true)
    try {
      if (draftRef.current.dirty && !(await save())) return
      const applied = await run({
        type: 'episode',
        projectId: p.id,
        episodeId: targetEpisodeId,
        title: p.episodes.find((episode) => episode.id === targetEpisodeId)!.title,
        script: next,
      })
      if (applied.ok) {
        if (targetEpisodeId === episodeId) {
          draftRef.current = { episodeId, title, script: next, dirty: false }
          setScript(next)
          setDirty(false)
        } else await onEpisodeChange(targetEpisodeId)
        notice(t('已应用到剧本'))
      }
    } finally {
      setChatBusy(false)
    }
  }
  useEffect(() => {
    if (!active) return
    const handler = () => {
      void save()
    }
    window.addEventListener('director:save', handler)
    return () => window.removeEventListener('director:save', handler)
  }, [active, script, title])
  return (
    <div className="script-view" hidden={!active}>
      <div className="page-heading">
        <div>
          <span className="eyebrow">STORY DEVELOPMENT</span>
          <h1>{t('每个镜头，始于一个好故事。')}</h1>
          <p>{t('左侧编辑当前集，右侧与 AI 讨论整个项目。')}</p>
        </div>
      </div>
      <div className="script-grid">
        <section className="script-paper">
          <div className="script-paper-header">
            <input
              className="episode-title"
              aria-label={t('集标题')}
              value={title}
              onChange={(e) => {
                draftRef.current.title = e.target.value
                draftRef.current.dirty = true
                setTitle(e.target.value)
                setDirty(true)
              }}
            />
            <Button onClick={() => void save()}>
              <Check size={14} />
              {dirty ? t('保存剧本') : t('已保存')}
            </Button>
          </div>
          <div className="script-episode-switch">
            <button
              aria-label={t('上一集')}
              disabled={episodeIndex <= 0}
              onClick={() => void onEpisodeChange(p.episodes[episodeIndex - 1].id)}
            >
              <ChevronLeft size={15} />
              {t('上一集')}
            </button>
            <span>
              {episodeIndex + 1} / {p.episodes.length}
            </span>
            <button
              aria-label={t('下一集')}
              disabled={episodeIndex >= p.episodes.length - 1}
              onClick={() => void onEpisodeChange(p.episodes[episodeIndex + 1].id)}
            >
              {t('下一集')}
              <ChevronRight size={15} />
            </button>
          </div>
          <textarea
            className="script-text"
            aria-label={t('剧本正文')}
            value={script}
            onChange={(e) => {
              draftRef.current.script = e.target.value
              draftRef.current.dirty = true
              setScript(e.target.value)
              setDirty(true)
            }}
            placeholder={t(
              '写下你的故事，或导入小说 / 剧本。\n\n人物想要什么？什么阻碍了他们？这一集的最后，什么发生了变化？',
            )}
          />
          <div className="paper-footer">
            <span>
              {script.length.toLocaleString()} {t('字')}
            </span>
            <span>{t('纯文本剧本 · 手动保存')}</span>
          </div>
        </section>
        <aside className="script-chat" aria-label={t('AI 编剧对话')}>
          <div className="script-chat-header">
            <div className="note-heading">
              <MessageSquareText size={17} />
              <h3>{t('AI 编剧对话')}</h3>
            </div>
            <span className="small muted">
              {turns.length + pendingChat.length} {t('条项目对话')}
            </span>
          </div>
          <p className="small muted">
            {t('这里显示当前项目所有分集的对话。生成的剧本可直接放入对应集。')}
          </p>
          <div className="script-chat-account">
            <span className={accountConnected === true ? 'green-dot' : 'neutral-dot'} />
            <span>
              {accountConnected === null
                ? t('正在检查账号…')
                : accountConnected === true
                  ? `${t(providerNames[state.config.models.text.provider])} · ${t('已连接')}`
                  : accountConnected === 'error'
                    ? t('账号检查失败，请重试')
                    : t(state.config.models.text.provider === 'chatgpt' ? '需要连接 ChatGPT 账号' : '需要配置文字模型 Key')}
            </span>
            {accountConnected === 'error' && (
              <Button onClick={() => window.dispatchEvent(new Event('director:codex-login'))}>
                {t('重试检查')}
              </Button>
            )}
            {accountConnected === false && (
              <Button
                disabled={chatBusy}
                onClick={async () => {
                  setChatBusy(true)
                  try {
                    if (state.config.models.text.provider !== 'chatgpt') { window.dispatchEvent(new Event('director:open-settings')); return }
                    const r = await run({ type: 'codexLogin' })
                    if (r.ok) setAccountConnected(true)
                  } finally {
                    setChatBusy(false)
                  }
                }}
              >
                {t('连接账号')}
              </Button>
            )}
          </div>
          <div className="script-chat-history" aria-label={t('对话记录')} ref={historyRef}>
            {turns.length === 0 && !pendingChat.length ? (
              <p className="small muted">{t('还没有对话。可以从人物、冲突或下一场戏开始。')}</p>
            ) : (
              turns.map(({ episode, turn }) => (
                <article className={`script-chat-turn ${turn.role}`} key={turn.id}>
                  <div className="script-chat-turn-meta">
                    <strong>{turn.role === 'user' ? t('你') : turn.polishSourceTurnId ? t('AI 润色') : t('AI 编剧')}</strong>
                    <span>{episode.title}</span>
                  </div>
                  <p>{turn.text}</p>
                  {!!turn.attachments?.length && (
                    <div className="script-chat-files">
                      {turn.attachments.map((file) => (
                        <span key={file.id}>
                          <Paperclip size={12} />
                          {file.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {!!turn.analysis && (
                    <div className="script-chat-analysis">
                      <strong>{t('创作思路摘要')}</strong>
                      <p>{turn.analysis}</p>
                    </div>
                  )}
                  {!!turn.script?.trim() && (
                    <div className="script-chat-draft">
                      <details>
                        <summary>
                          {t('查看候选剧本')} · {turn.script.length.toLocaleString()} {t('字')}
                        </summary>
                        <pre>{turn.script}</pre>
                      </details>
                      <Button
                        disabled={chatBusy || turn.script === episode.script}
                        onClick={() => void applyChatScript(turn.script!, episode.id)}
                      >
                        {turn.script === episode.script ? t('已应用') : t('应用到剧本')}
                      </Button>
                      {turn.role === 'assistant' && <ScriptPolishOptions projectId={p.id}
                        episodeId={episode.id} turn={turn} disabled={chatBusy} />}
                    </div>
                  )}
                </article>
              ))
            )}
            {pendingChat.map((task) => task.request.type === 'scriptChatGenerate' && (
              <article className="script-chat-turn user" key={task.id}>
                <div className="script-chat-turn-meta"><strong>{t('你')}</strong>
                  <span>{p.episodes.find((episode) => task.request.type === 'scriptChatGenerate' && episode.id === task.request.episodeId)?.title}</span></div>
                <p>{task.request.polishTurnId ? `${t('润色方向')}：${task.request.request}` : task.request.request || t('请分析附件')}</p>
                {!!task.attachments.length && <p>{task.attachments.map((file) => file.name).join(' · ')}</p>}
                <AITaskProgress task={task} runningLabel={task.request.polishTurnId ? 'AI 正在润色剧本…' : 'AI 正在分析并生成回复…'} />
                {task.error && <p className="danger" role="alert">{t(task.error)}</p>}
                {task.status === 'cancelled' && <p>{t('已取消')}</p>}
                {task.status === 'queued' && <Button onClick={() => void run({ type: 'aiTask', taskId: task.id, action: 'cancel' })}>{t('取消排队')}</Button>}
                {task.status === 'failed' && <Button onClick={() => void run({ type: 'aiTask', taskId: task.id, action: 'retry' })}>{t('手动重试')}</Button>}
              </article>
            ))}
          </div>
          {chatBusy && (
            <p className="script-chat-working">
              <span className="neutral-dot" />
              {t('AI 正在分析并生成回复…')}
            </p>
          )}
          <div className="script-chat-composer">
            <Field label={t('发送到当前集')}>
              <textarea
                rows={3}
                maxLength={2000}
                value={chatRequest}
                onChange={(e) => setChatRequest(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    void sendChatRequest()
                  }
                }}
                placeholder={t('提出要求，或添加文件让 AI 分析。Ctrl+Enter 发送。')}
              />
            </Field>
            {!!attachedFiles.length && (
              <div className="script-chat-files pending">
                {attachedFiles.map((file) => (
                  <span key={file.id}>
                    <Paperclip size={12} />
                    {file.name}
                    <button
                      aria-label={`${t('移除附件')} ${file.name}`}
                      onClick={() =>
                        setAttachedFiles((current) => current.filter((item) => item.id !== file.id))
                      }
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="script-chat-actions">
              <Button
                disabled={chatBusy || attachedFiles.length >= 10}
                onClick={() => void pickFiles()}
              >
                <Paperclip size={14} />
                {t('添加文件')}
              </Button>
              <Button
                primary
                disabled={chatBusy || (!chatRequest.trim() && !attachedFiles.length)}
                onClick={() => void sendChatRequest()}
              >
                <WandSparkles size={14} />
                {chatBusy ? t('正在生成回复…') : t('发送给 AI 编剧')}
              </Button>
            </div>
            <p className="small muted">
              {t('可选任意类型文件，每轮最多 10 个、单个 50 MB。无法解析的格式会在回复中说明。')}
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}
export function AssetsView({ p, onGenerate }: { p: Project; onGenerate: (a: Asset) => void }) {
  const t = useT()
  const { run } = useWorkspace(),
    [kind, setKind] = useState<'all' | Asset['kind']>('all'),
    [draft, setDraft] = useState<Asset | null>(null),
    [uploadKind, setUploadKind] = useState<Asset['kind'] | null>(null),
    [uploading, setUploading] = useState(false)
  const labels = { character: t('角色'), location: t('场景'), prop: t('道具') },
    icons = {
      character: <UserRound size={17} />,
      location: <MapPin size={17} />,
      prop: <Package size={17} />,
    }
  return (
    <div className="assets-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">VISUAL BIBLE</span>
          <h1>{t('让每次生成，都属于同一个世界。')}</h1>
          <p>{t('建立稳定的人物、场景与道具参考，关联到每一个镜头。')}</p>
        </div>
        <div className="asset-heading-actions">
          <Button onClick={() => setUploadKind('character')}>
            <Upload size={15} />
            {t('上传资产图片')}
          </Button>
          <Button
            primary
            onClick={() =>
              setDraft({
                id: crypto.randomUUID(),
                kind: 'character',
                name: '',
                description: '',
                prompt: '',
              })
            }
          >
            <Plus size={15} />
            {t('新建资产')}
          </Button>
        </div>
      </div>
      <div className="filter-tabs">
        {(['all', 'character', 'location', 'prop'] as const).map((k) => (
          <button className={kind === k ? 'active' : ''} key={k} onClick={() => setKind(k)}>
            {k === 'all' ? t('全部资产') : labels[k]}
            <span>{p.assets.filter((a) => k === 'all' || a.kind === k).length}</span>
          </button>
        ))}
      </div>
      <div className="assets-grid">
        {p.assets
          .filter((a) => kind === 'all' || a.kind === kind)
          .map((a) => (
            <article className="asset-card" key={a.id}>
              <div className="asset-visual">
                <Preview p={p} mediaId={a.selectedMediaId} />
                <span>
                  {icons[a.kind]}
                  {labels[a.kind]}
                </span>
                <button
                  aria-label={`${t('编辑资产')} ${a.name}`}
                  className="icon-button"
                  onClick={() => setDraft(a)}
                >
                  <PencilLine size={14} />
                </button>
              </div>
              <div className="asset-description">
                <h3>{a.name}</h3>
                <p>{a.description}</p>
                <Versions p={p} ownerId={a.id} slot="reference" />
                <div className="field-row">
                  <Button onClick={() => onGenerate(a)}>
                    <ImagePlus size={14} />
                    {t('生成参考图')}
                  </Button>
                  <Button
                    title={t('导入参考图')}
                    onClick={() =>
                      void run({
                        type: 'importMedia',
                        projectId: p.id,
                        ownerId: a.id,
                        slot: 'reference',
                      })
                    }
                  >
                    <Upload size={14} />
                  </Button>
                </div>
              </div>
            </article>
          ))}
      </div>
      {!p.assets.length && (
        <Empty icon={<UserRound size={30} />} heading={t('这个世界，等待你的设定')}>
          {t('上传参考图片、新建资产，或在剧本页用 ChatGPT 提取人物与场景。')}
        </Empty>
      )}
      {uploadKind && (
        <Modal title={t('上传资产图片')} onClose={() => !uploading && setUploadKind(null)}>
          <div className="modal-body">
            <Field label={t('类型')}>
              <select
                value={uploadKind}
                disabled={uploading}
                onChange={(e) => setUploadKind(e.target.value as Asset['kind'])}
              >
                {Object.entries(labels).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <p className="small muted">{t('支持 PNG、JPG 和 WebP；文件名将作为资产名称。')}</p>
          </div>
          <div className="modal-footer">
            <Button disabled={uploading} onClick={() => setUploadKind(null)}>
              {t('返回')}
            </Button>
            <Button
              primary
              disabled={uploading}
              onClick={async () => {
                setUploading(true)
                try {
                  const result = await run({
                    type: 'uploadAssetImage',
                    projectId: p.id,
                    kind: uploadKind,
                  })
                  if (result.ok && result.text) {
                    setKind(uploadKind)
                    setUploadKind(null)
                  }
                } finally {
                  setUploading(false)
                }
              }}
            >
              <Upload size={14} />
              {uploading ? t('正在上传…') : t('选择图片上传')}
            </Button>
          </div>
        </Modal>
      )}
      {draft && (
        <Modal title={draft.name || t('新建视觉资产')} onClose={() => setDraft(null)}>
          <div className="modal-body">
            <Field label={t('类型')}>
              <select
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as Asset['kind'] })}
              >
                {Object.entries(labels).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('名称')}>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label={t('外观 / 设定')}>
              <textarea
                rows={4}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </Field>
            <Field label={t('参考图提示词')}>
              <textarea
                rows={4}
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              />
            </Field>
          </div>
          <div className="modal-footer">
            <Button
              onClick={async () => {
                const r = await run({ type: 'deleteAsset', projectId: p.id, assetId: draft.id })
                if (r.ok) setDraft(null)
              }}
            >
              <Trash2 size={14} />
              {t('移除资产（保留素材）')}
            </Button>
            <Button
              primary
              disabled={!draft.name.trim()}
              onClick={async () => {
                const r = await run({ type: 'asset', projectId: p.id, asset: draft })
                if (r.ok) setDraft(null)
              }}
            >
              {t('保存资产')}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
export function CutView({
  p,
  episodeId,
  shots,
  onSelect,
  onExport,
}: {
  p: Project
  episodeId: string
  shots: Shot[]
  onSelect: (id: string) => void
  onExport: () => void
}) {
  const t = useT()
  const { run } = useWorkspace(),
    [current, setCurrent] = useState(shots[0]?.id || ''),
    [previewUrl, setPreviewUrl] = useState(''),
    [previewing, setPreviewing] = useState(false),
    [previewError, setPreviewError] = useState(''),
    [autoplay, setAutoplay] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const complete = shots.length > 0 && shots.every((shot) => !!shot.videoMediaId)
  const previewVersion = JSON.stringify([p.aspect, ...shots.map((shot) =>
    [shot.id, shot.videoMediaId, shot.audioMediaId, shot.duration])])
  useEffect(() => {
    setCurrent(shots[0]?.id || '')
    setAutoplay(false)
  }, [episodeId])
  useEffect(() => {
    let active = true
    setPreviewUrl('')
    setPreviewError('')
    if (!complete) {
      setPreviewing(false)
      return
    }
    setPreviewing(true)
    void run({ type: 'previewEpisode', projectId: p.id, episodeId }).then((reply) => {
      if (!active) return
      setPreviewing(false)
      if (reply.ok) setPreviewUrl(reply.text || '')
      else setPreviewError(reply.error)
    })
    return () => { active = false }
  }, [p.id, episodeId, complete, previewVersion, run])
  useEffect(() => {
    if (autoplay && !previewUrl) void videoRef.current?.play().catch(() => setAutoplay(false))
  }, [current, previewUrl, autoplay])
  const shot = shots.find((s) => s.id === current) || shots[0]
  const selectedVideo = p.media.find((media) => media.id === shot?.videoMediaId && media.kind === 'video')
  const jumpTo = (id: string) => {
    setCurrent(id)
    if (previewUrl && videoRef.current) {
      const index = shots.findIndex((shot) => shot.id === id)
      videoRef.current.currentTime = shots.slice(0, index).reduce((time, shot) => time + shot.duration, 0)
      void videoRef.current.play()
    } else if (p.shots.find((shot) => shot.id === id)?.videoMediaId) setAutoplay(true)
  }
  return (
    <div className="cut-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">ASSEMBLY & DELIVERY</span>
          <h1>{t('从镜头，走向一个完整的故事。')}</h1>
          <p>{t('整集连续预览按镜头顺序播放；选择下方镜头可跳转到对应位置。')}</p>
        </div>
        <Button primary onClick={onExport}>
          <FolderOpen size={15} />
          {t('导出整集')}
        </Button>
      </div>
      {shot ? (
        <>
          <div className="review-player">
            {previewUrl ? (
              <video
                ref={videoRef}
                src={previewUrl}
                controls
                preload="metadata"
                className="media-preview"
                onTimeUpdate={(event) => {
                  const time = event.currentTarget.currentTime
                  let elapsed = 0
                  for (const item of shots) {
                    elapsed += item.duration
                    if (time < elapsed || item === shots.at(-1)) {
                      if (item.id !== current) setCurrent(item.id)
                      break
                    }
                  }
                }}
              />
            ) : selectedVideo ? (
              <video
                key={selectedVideo.id}
                ref={videoRef}
                src={mediaUrl(p.id, selectedVideo.id)}
                controls
                preload="metadata"
                autoPlay={autoplay}
                className="media-preview"
                onPlay={() => setAutoplay(true)}
                onEnded={() => {
                  const next = shots[shots.findIndex((item) => item.id === shot.id) + 1]
                  if (next?.videoMediaId) setCurrent(next.id)
                  else setAutoplay(false)
                }}
              />
            ) : <Preview p={p} mediaId={shot.firstMediaId} slot="video" />}
          </div>
          <div className="review-preview-state small muted" role="status">
            {previewing ? t('正在拼接整集预览…') : previewUrl
              ? t('预览使用与 MP4 导出相同的镜头顺序、画幅、时长和音频。')
              : complete ? previewError : t('有镜头尚无视频；可连续播放已完成的相邻镜头。')}
            {shots.some((item) => item.stale && item.videoMediaId) &&
              <span>{t('部分镜头的视频已过期，建议按顺序重新生成。')}</span>}
            {previewError && <Button onClick={() => {
              setPreviewing(true)
              setPreviewError('')
              void run({ type: 'previewEpisode', projectId: p.id, episodeId }).then((reply) => {
                setPreviewing(false)
                if (reply.ok) setPreviewUrl(reply.text || '')
                else setPreviewError(reply.error)
              })
            }}>{t('重试拼接预览')}</Button>}
          </div>
          <div className="row-between review-title">
            <div>
              <strong>{shot.title}</strong>
              <p className="small muted">
                {shot.dialogue || t('无对白')} · {shot.duration}s
              </p>
            </div>
            <div className="field-row">
              <Button onClick={() => onSelect(shot.id)}>{t('编辑镜头')}</Button>
              <Button
                onClick={() =>
                  void run({
                    type: 'importMedia',
                    projectId: p.id,
                    ownerId: shot.id,
                    slot: 'audio',
                  })
                }
              >
                <Upload size={14} />
                {t('导入配音')}
              </Button>
              <Button
                onClick={() =>
                  void run({
                    type: 'importMedia',
                    projectId: p.id,
                    ownerId: shot.id,
                    slot: 'video',
                  })
                }
              >
                {t('导入视频')}
              </Button>
            </div>
          </div>
          <div className="timeline-ruler">
            <span>00:00</span>
            <span>
              {shots.reduce((n, s) => n + s.duration, 0)} {t('秒')}
            </span>
          </div>
          <div className="timeline">
            {shots.map((s, i) => (
              <button
                key={s.id}
                className={s.id === shot.id ? 'selected' : ''}
                style={{ flexGrow: s.duration }}
                onClick={() => jumpTo(s.id)}
              >
                <Preview p={p} mediaId={s.firstMediaId} />
                <span>
                  {String(i + 1).padStart(2, '0')} · {s.title}
                </span>
                <small>
                  {s.duration}s {s.stale && s.videoMediaId ? t('· 待更新') :
                    s.videoMediaId ? t('· 有视频') : t('· 待生成')}
                </small>
              </button>
            ))}
          </div>
        </>
      ) : (
        <Empty heading={t('还没有可预览的镜头')}>
          {t('在导演台中新建镜头，或从 ChatGPT 导入分镜。')}
        </Empty>
      )}
    </div>
  )
}
export function Tasks({ jobs, aiTasks, onClose }: { jobs: Job[]; aiTasks: AiTask[]; onClose: () => void }) {
  const t = useT()
  const { run, state } = useWorkspace(),
    [attach, setAttach] = useState<Job | null>(null),
    [taskId, setTaskId] = useState(''),
    [confirm, setConfirm] = useState<{ job: Job; action: 'retry' | 'cancel' } | null>(null)
  const orderedAI = [
    ...aiTasks.filter((task) => task.status === 'running'),
    ...aiTasks.filter((task) => task.status === 'queued').reverse(),
    ...aiTasks.filter((task) => !['queued', 'running'].includes(task.status)),
  ]
  return (
    <Modal
      title={t('任务中心')}
      subtitle={t('暂停只停止新任务；AI 中断后需核对重试，视频任务可凭远端 ID 恢复查询。')}
      wide
      onClose={onClose}
    >
      <div className="modal-body">
        <div className="row-between">
          <span className="muted">
            {jobs.length + aiTasks.length} {t('条本地记录')}
          </span>
          <Button onClick={() => void run({ type: 'pause', paused: !state.config.paused })}>
            {state.config.paused ? <Play size={14} /> : <Pause size={14} />}{' '}
            {state.config.paused ? t('继续队列') : t('暂停队列')}
          </Button>
        </div>
        {aiTasks.length > 0 && <div className="job-list">
          {orderedAI.map((task) => <article className="job" key={task.id}>
            <div className="row-between"><strong>{t(task.title.split(' · ')[0])} · {task.title.split(' · ').slice(1).join(' · ')}</strong>
              <span className={`status ${task.status}`}>{t(task.status === 'queued' ? '排队中' : task.status === 'running' ? '生成中' : statusNames[task.status])}</span></div>
            <p className="small muted">{state.projects.find((project) => project.id === task.projectId)?.title} · {new Date(task.createdAt).toLocaleString()}</p>
            {task.model && <p className="small muted">{t(providerNames[task.model.provider])} {task.model.model}</p>}
            {task.remoteTaskId && <p className="small muted break">Task ID: {task.remoteTaskId}</p>}
            <AITaskProgress task={task} />
            {task.error && <p className="job-error" role="alert">{t(task.error)}</p>}
            {task.resultText && <details><summary>{t('查看生成结果')}</summary><pre className="prompt-editor">{task.resultText}</pre></details>}
            <div className="field-row">
              {task.status === 'queued' && <Button onClick={() => void run({ type: 'aiTask', taskId: task.id, action: 'cancel' })}>{t('取消排队')}</Button>}
              {['failed', 'cancelled'].includes(task.status) && <Button onClick={() => void run({ type: 'aiTask', taskId: task.id, action: 'retry' })}>{t(task.remoteTaskId ? '继续查询原任务' : '核对后手动重试')}</Button>}
            </div>
          </article>)}
        </div>}
        {!jobs.length && !aiTasks.length ? (
          <Empty heading={t('队列很安静')}>{t('提交 AI 生成或视频任务后会显示在这里。')}</Empty>
        ) : (
          <div className="job-list">
            {jobs.map((j) => (
              <article className="job" key={j.id}>
                <div className="row-between">
                  <strong>{j.snapshot.title}</strong>
                  <span className={`status ${j.status}`}>{t(statusNames[j.status])}</span>
                </div>
                <p className="small muted">
                  {new Date(j.createdAt).toLocaleString()} · workflow {j.workflowId}
                  {j.model && ` · ${t(providerNames[j.model.provider])}${j.model.model ? ` / ${j.model.model}` : ''}`}
                  {(!j.model || j.model.provider === 'runninghub') && j.instanceType && ` · ${j.instanceType === 'plus' ? 'Plus' : 'Standard'}`}
                </p>
                {j.taskId && <p className="mono small break">Task ID: {j.taskId}</p>}
                {j.error && <p className="job-error">{t(j.error)}</p>}
                <div className="field-row">
                  {j.status === 'paused' && (
                    <Button
                      onClick={() => void run({ type: 'job', jobId: j.id, action: 'resume' })}
                    >
                      <Play size={13} />
                      {t('继续原任务')}
                    </Button>
                  )}
                  {['failed', 'cancelled'].includes(j.status) && (
                    <Button onClick={() => setConfirm({ job: j, action: 'retry' })}>
                      <RotateCcw size={13} />
                      {t('重新提交')}
                    </Button>
                  )}
                  {['uncertain', 'paused'].includes(j.status) && (
                    <Button
                      onClick={() => {
                        setAttach(j)
                        setTaskId(j.taskId || '')
                      }}
                    >
                      <Link2 size={13} />
                      {t('绑定远端任务 ID')}
                    </Button>
                  )}
                  {!['succeeded', 'cancelled', 'failed'].includes(j.status) && (
                    <Button onClick={() => setConfirm({ job: j, action: 'cancel' })}>
                      <X size={13} />
                      {t('取消')}
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      {attach && (
        <Modal
          title={t('绑定已有任务')}
          subtitle={t('在所用服务商任务记录中核实镜头、时间和模型，再粘贴对应 ID。')}
          onClose={() => setAttach(null)}
        >
          <div className="modal-body">
            <Field label="Task ID">
              <input
                value={taskId}
                onChange={(e) => setTaskId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
              />
            </Field>
          </div>
          <div className="modal-footer">
            <Button
              primary
              disabled={!taskId}
              onClick={async () => {
                const r = await run({ type: 'job', jobId: attach.id, action: 'attach', taskId })
                if (r.ok) setAttach(null)
              }}
            >
              {t('绑定并继续查询')}
            </Button>
          </div>
        </Modal>
      )}
      {confirm && (
        <Modal
          title={confirm.action === 'retry' ? t('确认重新生成？') : t('确认取消任务？')}
          onClose={() => setConfirm(null)}
        >
          <div className="modal-body">
            <p>
              {confirm.action === 'retry'
                ? t(
                    '这会发起新的视频任务，可能再次计费。确认原任务已结束，或确实需要重新生成。',
                  )
                : confirm.job.status === 'uncertain'
                  ? t(
                      '原提交结果不确定。必须先在所用服务商核实并处理可能存在的任务；此操作仅关闭本地待核实记录，不保证远端取消。',
                    )
                  : t('已产生的费用以所用服务商为准。提交中的任务需要先等待返回 ID。')}
            </p>
          </div>
          <div className="modal-footer">
            <Button onClick={() => setConfirm(null)}>{t('返回')}</Button>
            <Button
              primary
              onClick={async () => {
                const r = await run({ type: 'job', jobId: confirm.job.id, action: confirm.action })
                if (r.ok) setConfirm(null)
              }}
            >
              {t('已核实，确认')}
              {confirm.action === 'retry' ? t('重新提交') : t('取消')}
            </Button>
          </div>
        </Modal>
      )}
    </Modal>
  )
}
