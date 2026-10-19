import './bridge'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import brandMark from './assets/muweave-mark.png'
import { createRoot } from 'react-dom/client'
import {
  Clapperboard,
  Plus,
  Settings2,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  Download,
  Check,
  Film,
  PanelsTopLeft,
  List,
  Sparkles,
  Clock3,
  ArrowUpRight,
  PanelRightClose,
  PanelRightOpen,
  FolderArchive,
  Layers3,
  FileText,
  UsersRound,
  Scissors,
  Search,
  X,
  Play,
  Moon,
  Sun,
  History,
  Trash2,
  Menu,
} from 'lucide-react'
import {
  blankShot,
  type Asset,
  type Command,
  type Project,
  type Reply,
  type Shot,
  type Snapshot,
  type AiRequest,
  videoWorkflow,
  replySchema,
} from '../shared/schema'
import { planVideoTiming, videoDurationLimits } from '../shared/director'
import { planVideoContinuity } from '../shared/continuity'
import { credentialId, providerNames } from '../shared/models'
import { Button, Empty, Modal, Field, Preview, Workspace, Working } from './ui'
import Canvas from './Canvas'
import Inspector from './Inspector'
import { VideoResolutionField } from './VideoResolutionField'
import { DialoguePreview } from './DialoguePreview'
import { dialoguePlan } from '../shared/dialogue'
import { CreateDialog, GenerationDialog, StoryboardDialog, SettingsDialog, ExportDialog } from './Dialogs'
import { AssetsView, CutView, ScriptEditor, Tasks } from './Production'
import './styles.css'
import { Language, translate } from './i18n'
import { isPrevisCurrent } from '../shared/previs'
const Previs = React.lazy(() => import('./Previs'))

type Stage = 'script' | 'assets' | 'board' | 'cut'
type Generator = {
  kind: 'script' | 'assets' | 'storyboard' | 'image'
  shot?: Shot
  assetId?: string
  slot?: 'first' | 'last'
}
function commandError(message: string) {
  try {
    const issues = JSON.parse(message)
    if (
      Array.isArray(issues) &&
      issues.some(
        (issue) =>
          issue.code === 'invalid_union' &&
          issue.discriminator === 'type' &&
          issue.path?.length === 0,
      )
    )
      return '开发版界面与主进程版本不一致，请重启应用后重试。'
  } catch {
    // Keep ordinary application errors as they are.
  }
  return message
}
function App() {
  const [state, setState] = useState<Snapshot | null>(null),
    [chatgptConnected, setChatgptConnected] = useState(false),
    [imageConnected, setImageConnected] = useState(false),
    [pid, setPid] = useState(''),
    [epid, setEpid] = useState(''),
    [selected, setSelected] = useState(''),
    [stage, setStage] = useState<Stage>('board'),
    [view, setView] = useState<'canvas' | 'list' | 'previs'>('list'),
    [inspector, setInspector] = useState(true),
    [query, setQuery] = useState(''),
    [toast, setToast] = useState(''),
    [error, setError] = useState(''),
    [create, setCreate] = useState(false),
    [settings, setSettings] = useState(false),
    [exporting, setExporting] = useState(false),
    [tasks, setTasks] = useState(false),
    [generator, setGenerator] = useState<Generator | null>(null),
    [generatorTask, setGeneratorTask] = useState<{ id: string; dialog: Generator | null } | null>(null),
    [confirm, setConfirm] = useState<{
      title: string
      text: string
      run: () => Promise<unknown>
    } | null>(null),
    [batch, setBatch] = useState<string[] | null>(null),
    [stop, setStop] = useState(false),
    [groupName, setGroupName] = useState(''),
    [groups, setGroups] = useState(false),
    [history, setHistory] = useState<{ revision: number; created: string }[] | null>(null),
    [scriptArchiveOpen, setScriptArchiveOpen] = useState(false),
    [scriptArchiveId, setScriptArchiveId] = useState(''),
    [archiveShotId, setArchiveShotId] = useState(''),
    [archiveVideoId, setArchiveVideoId] = useState(''),
    [newEpisode, setNewEpisode] = useState(false),
    [studioNavigation, setStudioNavigation] = useState(false),
    [episodeTitle, setEpisodeTitle] = useState('第二集')
  const t = (text: string) => translate(state?.config.locale || 'zh', text)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const beforeEpisodeChange = useRef<(() => Promise<boolean>) | null>(null)
  const notice = useCallback((s: string) => {
    setToast(s)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 6500)
  }, [])
  const run = useCallback(
    async (c: Command): Promise<Reply> => {
      try {
        const r = replySchema.parse(await window.director.command(c))
        if (r.ok) {
          setState(r.state)
          if (r.message) notice(r.message)
        } else setError(commandError(r.error))
        return r
      } catch (e) {
        const error = e instanceof Error ? e.message : t('桌面连接失败')
        setError(error)
        return { ok: false, error }
      }
    },
    [notice],
  )
  async function submitAI(request: AiRequest) {
    const dialog = generator
    const reply = await run({ type: 'aiEnqueue', request })
    if (reply.ok && reply.text) setGeneratorTask({ id: reply.text, dialog })
    return reply
  }
  useEffect(() => {
    if (!generatorTask) return
    const task = state?.aiTasks.find((task) => task.id === generatorTask.id)
    if (task?.status === 'succeeded') {
      notice(t(task.message || 'AI 任务已完成'))
      if (generatorTask.dialog?.kind === 'image' || generatorTask.dialog?.kind === 'storyboard')
        setGenerator((current) => current === generatorTask.dialog ? null : current)
      setGeneratorTask(null)
    }
  }, [state?.aiTasks, generatorTask, notice])
  useEffect(() => {
    void run({ type: 'snapshot' })
    return window.director.onChange(() => {
      void run({ type: 'snapshot' })
    })
  }, [run])
  useEffect(() => {
    const refresh = () => {
      void run(state?.modelServicesReady ? { type: 'modelStatus', channel: 'text' } : { type: 'codexStatus' }).then((reply) =>
        setChatgptConnected(reply.ok && reply.text === 'connected'),
      )
      void run(state?.modelServicesReady ? { type: 'modelStatus', channel: 'image' } : { type: 'codexStatus' }).then((reply) =>
        setImageConnected(reply.ok && reply.text === 'connected'),
      )
    }
    refresh()
    window.addEventListener('director:codex-login', refresh)
    return () => window.removeEventListener('director:codex-login', refresh)
  }, [run, state?.modelServicesReady, JSON.stringify(state?.config.models), JSON.stringify(state?.credentials)])
  useEffect(() => {
    const show = () => setSettings(true)
    window.addEventListener('director:open-settings', show)
    return () => window.removeEventListener('director:open-settings', show)
  }, [])
  const p = state?.projects.find((p) => p.id === pid) || state?.projects[0],
    episodeId = p?.episodes.find((e) => e.id === epid)?.id || p?.episodes[0]?.id || '',
    episode = p?.episodes.find((e) => e.id === episodeId)
  const aiTasks = state?.aiTasks || []
  const videoKeyReady = !!state && (state.config.models.video.provider === 'runninghub' ? state.hasKey :
    !!state.credentials[credentialId('video', state.config.models.video)])
  const pendingAI = aiTasks.filter((task) => ['queued', 'running'].includes(task.status))
  const currentAI = pendingAI.find((task) => task.status === 'running') || pendingAI.at(-1)
  async function showAIGeneration() {
    if (!currentAI) return
    const request = currentAI.request, project = state?.projects.find((project) => project.id === request.projectId)
    if (!project) return
    if (beforeEpisodeChange.current && !(await beforeEpisodeChange.current())) return
    setPid(project.id)
    if ('episodeId' in request) setEpid(request.episodeId)
    if (request.type === 'generateImage') {
      const shot = project.shots.find((shot) => shot.id === request.ownerId)
      if (shot) setEpid(shot.episodeId)
      setGenerator({ kind: 'image', assetId: request.slot === 'reference' ? request.ownerId : undefined,
        shot, slot: request.slot === 'last' ? 'last' : 'first' })
    } else if (request.type === 'generateStoryboard') setGenerator({ kind: 'storyboard' })
    else if (request.type === 'scriptChatGenerate') { setStage('script'); setGenerator(null) }
    else setGenerator({ kind: request.kind === 'storyboard' ? 'storyboard' : request.kind })
  }
  async function changeEpisode(nextId: string) {
    if (nextId === episodeId) return
    if (beforeEpisodeChange.current && !(await beforeEpisodeChange.current())) return
    setEpid(nextId)
  }
  const shots = p?.shots.filter((s) => s.episodeId === episodeId) || [],
    filtered = shots.filter((s) =>
      `${s.title} ${s.action} ${s.scene}`.toLowerCase().includes(query.toLowerCase()),
    ),
    shot = shots.find((s) => s.id === selected) || shots[0],
    jobs = state?.jobs.filter((j) => j.projectId === p?.id) || [],
    activeJobs =
      [...(state?.jobs.filter((j) =>
        ['queued', 'running', 'submitting', 'downloading'].includes(j.status),
      ) || []), ...pendingAI]
  const videoProvider = state?.config.models.video.provider || 'runninghub'
  const videoLimits = videoDurationLimits(videoProvider)
  const shotTiming = new Map(shots.map((shot) => [shot.id, planVideoTiming(shot, videoProvider)]))
  const batchTiming = shots.filter((shot) => batch?.includes(shot.id)).map((shot) => ({
    shot, ...shotTiming.get(shot.id)!,
  }))
  const autoFit = batchTiming.filter(({ shot, duration, issue }) => !issue && duration > shot.duration)
  const needsSplit = batchTiming.filter(({ issue }) => !!issue)
  const previsIssues = p ? batchTiming.filter(({ shot, duration }) => shot.usePrevis &&
    (videoProvider !== 'runninghub' || !isPrevisCurrent(p, shot) || duration !== shot.duration ||
      (Math.ceil(duration * 24) / 24 > 13 && !!planVideoContinuity(p, shot, new Set(batch || []), state?.jobs || []).previous))) : []
  const dialogueIssues = p ? batchTiming.filter(({ shot }) => dialoguePlan(p, shot).errors.length) : []
  const selectedArchive = p?.scriptArchives.find((item) => item.id === scriptArchiveId) ||
    p?.scriptArchives.at(-1)
  const archivedShot = selectedArchive?.shots.find((item) => item.id === archiveShotId) ||
    selectedArchive?.shots[0]
  const archivedVideos = p?.media.filter((media) => media.ownerId === archivedShot?.id && media.slot === 'video') || []
  const archivedVideo = archivedVideos.find((media) => media.id === archiveVideoId) ||
    archivedVideos.find((media) => media.id === archivedShot?.videoMediaId) || archivedVideos.at(-1)
  useEffect(() => {
    if (!state) return
    document.documentElement.dataset.theme = state.config.theme
    document.documentElement.lang = state.config.locale === 'en' ? 'en' : 'zh-CN'
    document.title =
      state.config.locale === 'en' ? 'Muweave · AI Director Board' : 'Muweave 幕织 · AI 导演台'
  }, [state?.config.theme, state?.config.locale])
  useEffect(() => {
    if (p && p.id !== pid) setPid(p.id)
  }, [p?.id, pid])
  useEffect(() => {
    setSelected('')
    setQuery('')
  }, [p?.id, episodeId])
  const chooseShot = useCallback((id: string) => {
    setSelected(id)
    setInspector(true)
  }, [])
  const image = useCallback((s: Shot) => setGenerator({ kind: 'image', shot: s }), [])
  const video = useCallback((s: Shot) => setBatch([s.id]), [])
  const deleteShot = (s: Shot) => {
    if (!p) return
    setConfirm({
      title: t('移除这个镜头？'),
      text: `${s.title} · ${t('镜头将从分镜列表移除，素材文件和历史版本会保留。')}`,
      run: () => run({ type: 'deleteShot', projectId: p.id, shotId: s.id }),
    })
  }
  const layout = useCallback(
    (layout: Project['layout'], viewport?: Project['viewport']) => {
      if (p) void run({ type: 'layout', projectId: p.id, layout, viewport })
    },
    [p?.id, run],
  )
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        window.dispatchEvent(new Event('director:save'))
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault()
        setCreate(true)
      }
      if (e.key === 'Escape') {
        setToast('')
        setError('')
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [notice])
  if (!state)
    return (
      <div className="boot">
        <img src={brandMark} alt={t('幕织 Muweave')} width={64} height={64} />
        <h2>{t('Muweave 幕织')}</h2>
        {error ? (
          <p>{error}</p>
        ) : (
          <>
            <Working />
            <p>{t('正在打开本地资料库…')}</p>
          </>
        )}
      </div>
    )
  return (
    <Workspace.Provider value={{ state, run, notice }}>
      <Language.Provider value={state.config.locale}>
        <div className="app-shell">
          <aside className={`sidebar ${studioNavigation ? 'studio-navigation-open' : ''}`}>
            <div className="brand">
              <div className="brand-mark">
                <img src={brandMark} alt="" />
              </div>
              {window.director.studio && <button className="icon-button studio-navigation-toggle"
                aria-label={t('关闭项目导航')} onClick={() => setStudioNavigation(false)}><X size={16} /></button>}
              <div>
                Muweave <span className="brand-cn">{t('幕织')}</span>
                <small>{window.director.studio ? 'MUWEAVE STUDIO' : 'WEAVE YOUR STORY'}</small>
              </div>
            </div>
            <Button className="new-project" onClick={() => setCreate(true)}>
              <Plus size={16} />
              {t('新建项目')}
              <span>Ctrl N</span>
            </Button>
            <div className="sidebar-label">
              {t('工作空间')}
              <span>{state.projects.length}</span>
            </div>
            <nav className="project-nav">
              {state.projects.map((project) => (
                <div key={project.id} className={`nav-node ${p?.id === project.id ? 'active' : ''}`}>
                  <button
                    className="nav-select"
                    onClick={async () => {
                      if (project.id === p?.id) return
                      if (beforeEpisodeChange.current && !(await beforeEpisodeChange.current()))
                        return
                      setPid(project.id)
                      setEpid('')
                    }}
                  >
                    <FolderOpen size={16} />
                    <span>{project.title}</span>
                  </button>
                  <button
                    className="nav-remove"
                    aria-label={`${t('移除项目')} ${project.title}`}
                    title={`${t('移除项目')} ${project.title}`}
                    onClick={() =>
                      setConfirm({
                        title: `${t('移除项目')}「${project.title}」？`,
                        text: t('项目会从列表移除，原素材目录仍保留。此操作不会自动备份。'),
                        run: async () => {
                          const r = await run({ type: 'deleteProject', projectId: project.id })
                          if (
                            r.ok &&
                            p?.id === project.id &&
                            !r.state.projects.some((item) => item.id === project.id)
                          ) {
                            setPid(r.state.projects[0]?.id || '')
                            setEpid('')
                          }
                        },
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {!state.projects.length && <p className="small muted">{t('还没有项目')}</p>}
            </nav>
            {p && (
              <>
                <div className="sidebar-label episode-label">
                  {t('当前项目 / 分集')}{' '}
                  <button
                    className="icon-button"
                    aria-label={t('添加分集')}
                    onClick={() => {
                      setEpisodeTitle(
                        state.config.locale === 'en'
                          ? `Episode ${p.episodes.length + 1}`
                          : `第 ${p.episodes.length + 1} 集`,
                      )
                      setNewEpisode(true)
                    }}
                  >
                    <Plus size={14} />
                  </button>
                </div>
                <nav className="episode-nav">
                  {p.episodes.map((ep, i) => (
                    <div key={ep.id} className={`nav-node ${ep.id === episodeId ? 'active' : ''}`}>
                      <button className="nav-select" onClick={() => void changeEpisode(ep.id)}>
                        <span className="mono">{String(i + 1).padStart(2, '0')}</span>
                        <span>{ep.title}</span>
                      </button>
                      <button
                        className="nav-remove"
                        aria-label={`${t('移除分集')} ${ep.title}`}
                        title={`${t('移除分集')} ${ep.title}`}
                        disabled={p.episodes.length === 1}
                        onClick={() =>
                          setConfirm({
                            title: `${t('移除分集')}「${ep.title}」？`,
                            text: t(
                              '此集的剧本、对话与镜头会从项目中移除；素材文件和历史版本仍保留。',
                            ),
                            run: async () => {
                              if (
                                ep.id === episodeId &&
                                beforeEpisodeChange.current &&
                                !(await beforeEpisodeChange.current())
                              )
                                return
                              const r = await run({
                                type: 'deleteEpisode',
                                projectId: p.id,
                                episodeId: ep.id,
                              })
                              if (r.ok && ep.id === episodeId) {
                                const remaining = r.state.projects.find((item) => item.id === p.id)
                                setEpid(remaining?.episodes[Math.min(i, remaining.episodes.length - 1)]?.id || '')
                              }
                            },
                          })
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </nav>
                <div className="project-note">
                  <span className="eyebrow">PROJECT NOTES</span>
                  <p>{p.description || t('一个故事，无限种可能。')}</p>
                  <span className="small muted">
                    {p.aspect} · {p.shots.length} {t('镜头')}
                  </span>
                </div>
              </>
            )}
            <div className="sidebar-bottom">
              <button onClick={() => setTasks(true)}>
                <Clock3 size={16} />
                {t('任务中心')}
                {activeJobs.length > 0 && <span className="count">{activeJobs.length}</span>}
              </button>
              <button onClick={() => void run({ type: 'importArchive' })}>
                <FolderArchive size={16} />
                {t('打开项目存档')}
              </button>
              <button onClick={() => setSettings(true)}>
                <Settings2 size={16} />
                {t('连接与设置')}
              </button>
              <div className="quick-preferences">
                <div className="preference-switch" role="group" aria-label={t('界面语言')}>
                  <button
                    className={state.config.locale === 'zh' ? 'active' : ''}
                    aria-pressed={state.config.locale === 'zh'}
                    onClick={() =>
                      void run({ type: 'config', config: { ...state.config, locale: 'zh' } })
                    }
                  >
                    中文
                  </button>
                  <button
                    className={state.config.locale === 'en' ? 'active' : ''}
                    aria-pressed={state.config.locale === 'en'}
                    onClick={() =>
                      void run({ type: 'config', config: { ...state.config, locale: 'en' } })
                    }
                  >
                    EN
                  </button>
                </div>
                <div className="preference-switch" role="group" aria-label={t('界面主题')}>
                  <button
                    className={state.config.theme === 'light' ? 'active' : ''}
                    aria-label={t('浅色 · Warm paper')}
                    aria-pressed={state.config.theme === 'light'}
                    onClick={() =>
                      void run({ type: 'config', config: { ...state.config, theme: 'light' } })
                    }
                  >
                    <Sun size={14} />
                  </button>
                  <button
                    className={state.config.theme === 'dark' ? 'active' : ''}
                    aria-label={t('深色 · Graphite')}
                    aria-pressed={state.config.theme === 'dark'}
                    onClick={() =>
                      void run({ type: 'config', config: { ...state.config, theme: 'dark' } })
                    }
                  >
                    <Moon size={14} />
                  </button>
                </div>
              </div>
              <div className="local-status">
                <span className="green-dot" />
                {t('本地工作空间')}
              </div>
            </div>
          </aside>
          <main className="main-workspace">
            <header className="topbar">
              <div className="breadcrumb">
                {window.director.studio && <button className="icon-button studio-navigation-toggle"
                  aria-label={t('项目导航')} aria-expanded={studioNavigation}
                  onClick={() => setStudioNavigation(!studioNavigation)}><Menu size={17} /></button>}
                <FolderOpen size={15} />
                <span>{p?.title || t('工作空间')}</span>
                {p && (
                  <>
                    <ChevronRight size={13} />
                    <strong>{episode?.title}</strong>
                  </>
                )}
              </div>
              <div className="topbar-actions">
                {p && (
                  <>
                    <span className="saved-status">
                      <Check size={13} />
                      {t('本地已保存')}
                    </span>
                    <button
                      className="icon-button"
                      title={t('项目版本历史')}
                      onClick={async () => {
                        const r = await run({ type: 'history', projectId: p.id })
                        if (r.ok) setHistory(JSON.parse(r.text || '[]'))
                      }}
                    >
                      <History size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={t('剧本与视频存档')}
                      title={t('剧本与视频存档')}
                      onClick={() => setScriptArchiveOpen(true)}
                    >
                      <FolderArchive size={16} />
                    </button>
                    <Button onClick={() => setExporting(true)}>
                      <Download size={14} />
                      {t('导出 / 存档')}
                    </Button>
                  </>
                )}
              </div>
            </header>
            {currentAI && (
              <div className="image-generation-status" role="status" aria-label={t('AI 任务队列')}>
                <Working />
                <div>
                  <span>{t(currentAI.status === 'running' ? 'AI 正在后台生成，完成后自动保存。' : 'AI 请求已排队，轮到后自动生成。')}</span>
                  <small>{state.projects.find((project) => project.id === currentAI.projectId)?.title} · {t(currentAI.title.split(' · ')[0])} · {currentAI.title.split(' · ').slice(1).join(' · ')} · {pendingAI.filter((task) => task.status === 'queued').length} {t('个任务等待中')}</small>
                </div>
                <Button onClick={() => void showAIGeneration()}>{t('查看生成')}</Button>
                <Button onClick={() => setTasks(true)}>{t('任务中心')}</Button>
              </div>
            )}
            {p ? (
              <>
                <div className="stagebar">
                  <nav>
                    {(
                      [
                        { id: 'script', icon: <FileText size={15} />, label: t('剧本') },
                        { id: 'assets', icon: <UsersRound size={15} />, label: t('资产库') },
                        { id: 'board', icon: <Clapperboard size={15} />, label: t('导演台') },
                        { id: 'cut', icon: <Scissors size={15} />, label: t('成片') },
                      ] as const
                    ).map((s, i) => (
                      <React.Fragment key={s.id}>
                        <button
                          className={stage === s.id ? 'active' : ''}
                          onClick={async () => {
                            if (
                              s.id !== stage &&
                              beforeEpisodeChange.current &&
                              !(await beforeEpisodeChange.current())
                            )
                              return
                            setStage(s.id)
                          }}
                        >
                          {s.icon}
                          {s.label}
                          <span className="step-number">0{i + 1}</span>
                        </button>
                        {i < 3 && <ChevronRight size={12} />}
                      </React.Fragment>
                    ))}
                  </nav>
                  <div className="provider-status">
                    <button onClick={() => setSettings(true)}>
                      <span className={chatgptConnected ? 'green-dot' : 'neutral-dot'} />
                      {t('文字')} · {t(providerNames[state.config.models.text.provider])}
                    </button>
                    <button onClick={() => setSettings(true)}>
                      <span className={imageConnected ? 'green-dot' : 'neutral-dot'} />
                      {t('图片')} · {t(providerNames[state.config.models.image.provider])}
                    </button>
                    <button onClick={() => setSettings(true)}>
                      <span className={videoKeyReady ? 'green-dot' : 'neutral-dot'} />
                      {t('视频')} · {t(providerNames[state.config.models.video.provider])}
                      <ChevronDown size={12} />
                    </button>
                  </div>
                </div>
                {/* Keep the script session mounted while navigating between project tabs. */}
                <ScriptEditor
                  key={`script-${p.id}`}
                  p={p}
                  active={stage === 'script'}
                  episodeId={episodeId}
                  onEpisodeChange={changeEpisode}
                  beforeEpisodeChange={beforeEpisodeChange}
                />
                {stage === 'board' ? (
                  <div className={`director-body ${view === 'previs' ? 'previs-open' : ''}`}>
                    <div className="board-main">
                      <div className="board-heading">
                        <div>
                          <span className="eyebrow">DIRECTOR'S WORKSPACE</span>
                          <h1>{t('故事在这里，成为画面。')}</h1>
                          <p>
                            {shots.length} {t('个镜头')}
                            <span>·</span> {shots.reduce((n, s) => n + s.duration, 0)} {t('秒')}
                            <span>·</span> {p.aspect} <span>·</span>{' '}
                            {shots.filter((s) => s.videoMediaId).length} {t('个视频就绪')}
                          </p>
                        </div>
                        <div className="board-heading-actions">
                          <Button onClick={() => setScriptArchiveOpen(true)}>
                            <FolderArchive size={14} />
                            {t('剧本与视频存档')}
                          </Button>
                          <Button primary onClick={() => setGenerator({ kind: 'storyboard' })}>
                            <Sparkles size={14} />
                            {t('AI 拆解分镜')}
                          </Button>
                        </div>
                      </div>
                      <div className="canvas-toolbar">
                        <div className="segmented">
                          <button
                            className={view === 'canvas' ? 'active' : ''}
                            onClick={async () => { if (!beforeEpisodeChange.current || await beforeEpisodeChange.current()) setView('canvas') }}
                          >
                            <PanelsTopLeft size={14} />
                            {t('画布')}
                          </button>
                          <button
                            className={view === 'list' ? 'active' : ''}
                            onClick={async () => { if (!beforeEpisodeChange.current || await beforeEpisodeChange.current()) setView('list') }}
                          >
                            <List size={14} />
                            {t('列表')}
                          </button>
                          <button className={view === 'previs' ? 'active' : ''} disabled={!shots.length} onClick={() => setView('previs')}><Layers3 size={14} />{t('3D 预演')}</button>
                        </div>
                        <div className="search">
                          <Search size={13} />
                          <input
                            aria-label={t('搜索镜头')}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={t('搜索镜头…')}
                          />
                        </div>
                        <div className="toolbar-right">
                          <button className="text-button" onClick={() => setGroups(true)}>
                            <Layers3 size={14} />
                            {t('分组')}
                          </button>
                          <button
                            className="text-button"
                            onClick={async () => {
                              const s = blankShot(episodeId, state.config.locale)
                              const r = await run({ type: 'shot', projectId: p.id, shot: s })
                              if (r.ok) chooseShot(s.id)
                            }}
                          >
                            <Plus size={14} />
                            {t('镜头')}
                          </button>
                          <button
                            className="text-button"
                            disabled={!shots.length}
                            onClick={() => setBatch(shots.map((s) => s.id))}
                          >
                            <Play size={13} />
                            {t('批量')}
                          </button>
                          <button
                            className="icon-button"
                            aria-label={t('切换检查器')}
                            onClick={() => setInspector(!inspector)}
                          >
                            {inspector ? (
                              <PanelRightClose size={16} />
                            ) : (
                              <PanelRightOpen size={16} />
                            )}
                          </button>
                        </div>
                      </div>
                      <div className="canvas-area">
                        {view === 'previs' && shot ? <React.Suspense fallback={<div className="previs-loading"><Working /> {t('正在准备 3D 视窗…')}</div>}>
                          <Previs key={`${p.id}-${shot.id}`} p={p} shot={shot} shots={shots} onSelect={chooseShot} beforeLeave={beforeEpisodeChange} />
                        </React.Suspense> : filtered.length ? (
                          view === 'canvas' ? (
                            <Canvas
                              key={`${p.id}-${episodeId}`}
                              p={p}
                              shots={filtered}
                              jobs={jobs}
                              selected={shot?.id || ''}
                              onSelect={chooseShot}
                              onImage={image}
                              onVideo={video}
                              onLayout={layout}
                            />
                          ) : (
                            <div className="shot-list">
                              {filtered.map((s, i) => (
                                <article className={shot?.id === s.id ? 'selected' : ''} key={s.id}>
                                  <input
                                    aria-label={`${t('批量选择')} ${s.title}`}
                                    type="checkbox"
                                    checked={batch?.includes(s.id) || false}
                                    onChange={(e) =>
                                      setBatch(
                                        e.target.checked
                                          ? [...(batch || []), s.id]
                                          : (batch || []).filter((id) => id !== s.id),
                                      )
                                    }
                                  />
                                  <button
                                    className="shot-list-main"
                                    onClick={() => chooseShot(s.id)}
                                  >
                                    <span className="mono">{String(i + 1).padStart(2, '0')}</span>
                                    <div className="list-thumb">
                                      <Preview p={p} mediaId={s.firstMediaId} />
                                    </div>
                                    <div>
                                      <h3>{s.title}</h3>
                                      <p>{s.action}</p>
                                      <small>
                                        {s.size} · {s.camera} · {s.duration}s
                                      </small>
                                    </div>
                                  </button>
                                  <Button onClick={() => video(s)}>
                                    <Play size={13} />
                                    {t('生成')}
                                  </Button>
                                  <Button onClick={() => deleteShot(s)} title={t('删除镜头')}>
                                    <Trash2 size={13} />
                                    {t('删除镜头')}
                                  </Button>
                                </article>
                              ))}
                            </div>
                          )
                        ) : (
                          <Empty
                            icon={<Clapperboard size={34} />}
                            heading={query ? t('没有匹配的镜头') : t('把故事放上导演台')}
                            action={
                              !query && (
                                <Button
                                  primary
                                  onClick={() => setGenerator({ kind: 'storyboard' })}
                                >
                                  <Sparkles size={14} />
                                  {t('从剧本拆解分镜')}
                                </Button>
                              )
                            }
                          >
                            {query
                              ? t('试试其他标题、动作或场景关键词。')
                              : episode?.script
                                ? `${t('当前导演台使用新版剧本，请从剧本拆解分镜：')} ${episode.script.slice(0, 130)}${episode.script.length > 130 ? '…' : ''}`
                                : t('从剧本拆解，或手动新建镜头。脚本、画面与视频在同一张画布上连接。')}
                          </Empty>
                        )}
                        {view === 'canvas' && filtered.length > 0 && (
                          <div className="canvas-hint">
                            {t('拖动画布平移 · 滚轮缩放 · 点击卡片编辑')}
                          </div>
                        )}
                      </div>
                      <footer
                        className="queue-strip"
                        onClick={() => setTasks(true)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') setTasks(true)
                        }}
                      >
                        <div>
                          {activeJobs.length ? <Working /> : <span className="neutral-dot" />}
                          <span>
                            {activeJobs.length
                              ? `${activeJobs.length} ${t('个任务正在排队或生成')}`
                              : t('任务队列空闲')}
                          </span>
                          <span className="muted">
                            {t('所有改动保存在本机')}
                          </span>
                        </div>
                        <span>
                          {t('任务中心')}
                          <ChevronRight size={13} />
                        </span>
                      </footer>
                    </div>
                    {inspector && shot && view !== 'previs' && (
                      <Inspector
                        key={shot.id}
                        p={p}
                        shot={shot}
                        onGenerate={(s, slot) => setGenerator({ kind: 'image', shot: s, slot })}
                        onVideo={video}
                        onDelete={() => deleteShot(shot)}
                        onPrevis={() => setView('previs')}
                      />
                    )}
                  </div>
                ) : stage === 'assets' ? (
                  <AssetsView
                    key={p.id}
                    p={p}
                    onGenerate={(a: Asset) => setGenerator({ kind: 'image', assetId: a.id })}
                  />
                ) : stage === 'cut' ? (
                  <CutView
                    key={`${p.id}-${episodeId}`}
                    p={p}
                    episodeId={episodeId}
                    shots={shots}
                    onSelect={(id) => {
                      chooseShot(id)
                      setStage('board')
                    }}
                    onExport={() => setExporting(true)}
                  />
                ) : null}
              </>
            ) : (
              <div className="welcome">
                <div className="welcome-symbol">
                  <img src={brandMark} alt={t('幕织 Muweave Logo')} />
                </div>
                <span className="eyebrow">YOUR STORY, YOUR DIRECTOR'S DESK</span>
                <h1>{t('让一个想法，长成一部作品。')}</h1>
                <p>
                  {t('剧本、角色、分镜、生成与成片。')}
                  <br />
                  {t('一个安静的本地工作台，让创作留在你的掌握之中。')}
                </p>
                <div className="field-row">
                  <Button primary onClick={() => setCreate(true)}>
                    <Plus size={16} />
                    {t('开始第一个项目')}
                  </Button>
                  <Button
                    onClick={async () => {
                      const r = await run({
                        type: 'create',
                        title: '雨夜来信',
                        aspect: '16:9',
                        demo: true,
                      })
                      if (r.ok) setPid(r.state.projects[0].id)
                    }}
                  >
                    {t('探索示例项目')}
                    <ArrowUpRight size={14} />
                  </Button>
                </div>
                <div className="welcome-features">
                  <span>
                    <FolderArchive size={16} />
                    {t('本地资料库')}
                  </span>
                  <span>
                    <Sparkles size={16} />
                    {t('ChatGPT 创作')}
                  </span>
                  <span>
                    <Film size={16} />
                    {t('AI 视频')}
                  </span>
                </div>
              </div>
            )}
          </main>
        </div>
        {create && <CreateDialog onClose={() => setCreate(false)} onCreated={setPid} />}{' '}
        {settings && <SettingsDialog onClose={() => setSettings(false)} />}{' '}
        {p && exporting && (
          <ExportDialog p={p} episodeId={episodeId} onClose={() => setExporting(false)} />
        )}{' '}
        {tasks && <Tasks jobs={state.jobs} aiTasks={aiTasks} onClose={() => setTasks(false)} />}{' '}
        {p && generator && (generator.kind === 'storyboard' ? (
          <StoryboardDialog
            p={p}
            episodeId={episodeId}
            onSubmit={submitAI}
            onClose={() => setGenerator(null)}
          />
        ) : (
          <GenerationDialog
            p={p}
            episodeId={episodeId}
            kind={generator.kind}
            shot={generator.shot}
            assetId={generator.assetId}
            slot={generator.slot}
            onSubmit={submitAI}
            onClose={() => setGenerator(null)}
          />
        ))}
        {newEpisode && p && (
          <Modal title={t('添加分集')} onClose={() => setNewEpisode(false)}>
            <div className="modal-body">
              <Field label={t('集名称')}>
                <input value={episodeTitle} onChange={(e) => setEpisodeTitle(e.target.value)} />
              </Field>
            </div>
            <div className="modal-footer">
              <Button
                primary
                onClick={async () => {
                  if (beforeEpisodeChange.current && !(await beforeEpisodeChange.current())) return
                  const r = await run({
                    type: 'episode',
                    projectId: p.id,
                    title: episodeTitle,
                    script: '',
                  })
                  if (r.ok) {
                    setEpid(r.state.projects.find((o) => o.id === p.id)!.episodes.at(-1)!.id)
                    setNewEpisode(false)
                  }
                }}
              >
                {t('创建分集')}
              </Button>
            </div>
          </Modal>
        )}
        {batch && p && (
          <Modal
            title={t('生成视频 / 创建镜头分组')}
            subtitle={t(state.config.models.video.provider === 'runninghub' ? '仅允许使用 RH币生成；企业共享 Key 和可能扣钱包的节点会被阻止。' : '使用已配置的视频服务生成，费用按该服务商账户结算。')}
            onClose={() => setBatch(null)}
          >
            <div className="modal-body">
              <div className="row-between batch-selection-toolbar">
                <span>{t('选择需要运行的镜头')} · {batch.length} / {shots.length}</span>
                <div className="field-row">
                  <Button disabled={!shots.length || shots.every((shot) => batch.includes(shot.id))}
                    onClick={() => setBatch(shots.map((shot) => shot.id))}>{t('全选')}</Button>
                  <Button disabled={!batch.length} onClick={() => setBatch([])}>{t('清空选择')}</Button>
                </div>
              </div>
              <p className="small muted batch-duration-limit">
                {t('当前模型支持 {minimum}–{maximum} 秒；对白时长按正常语速估算。')
                  .replace('{minimum}', String(videoLimits.minimum)).replace('{maximum}', String(videoLimits.maximum))}
                {videoLimits.options && ` ${t('可选时长：')}${videoLimits.options.join(' / ')}s`}
              </p>
              {state.config.models.video.provider === 'runninghub' && <VideoResolutionField
                value={state.config.videoResolution} ready={state.videoResolutionReady} aspect={p.aspect}
                onChange={(videoResolution) => void run({ type: 'config', config: { ...state.config, videoResolution } })} />}
              <div className={`batch-shots${needsSplit.length ? ' has-timing-issues' : ''}`}>
                {shots.map((s) => {
                  const timing = shotTiming.get(s.id)!
                  const plan = planVideoContinuity(p, s, new Set(batch), state.jobs)
                  const before = p.shots.find((shot) => shot.id === plan.previous?.shotId)
                  const after = p.shots.find((shot) => shot.id === plan.next?.shotId)
                  return <label key={s.id} className={timing.issue || timing.duration > s.duration ? 'needs-timing' : ''}>
                    <input
                      type="checkbox"
                      checked={batch.includes(s.id)}
                      onChange={(e) =>
                        setBatch(
                          e.target.checked ? [...batch, s.id] : batch.filter((id) => id !== s.id),
                        )
                      }
                    />
                    <span className="batch-shot-detail">{s.title}
                      {batch.includes(s.id) && <span className="batch-shot-boundaries muted">
                        {t('首帧：')}{before ? `${before.title} · ${t(plan.previous?.videoMediaId ? '视频尾帧' : '等待新视频尾帧')}` : s.firstMediaId ? t('手动首帧') : t('无前镜视频')}
                        {' / '}{t('尾帧：')}{after ? `${after.title} · ${t('保留视频首帧')}` : s.lastMediaId ? t('手动尾帧') : t('无后镜视频')}
                      </span>}
                      {batch.includes(s.id) && s.usePrevis && <span className={`batch-shot-boundaries ${previsIssues.some((item) => item.shot.id === s.id) ? 'danger' : 'muted'}`}>
                        {t('白模预演参考：')}{isPrevisCurrent(p, s) ? `${t('当前版本')} · ${s.previsMediaId?.slice(0, 8)}` : t('需重新导出')}
                      </span>}
                    </span>
                    <small className={timing.issue ? 'danger' : ''}>
                      {s.duration}s{timing.issue ? ` · ${t('超限')}` : timing.duration > s.duration ? ` → ${timing.duration}s` : ''}
                    </small>
                  </label>
                })}
              </div>
              {batch.length > 100 && <p className="small danger" role="alert">{t('单批最多生成 100 个镜头，请减少选择。')}</p>}
              {!!previsIssues.length && <p className="small danger" role="alert">{t('已启用预演参考的镜头需要当前版本白模视频、相同生成时长及 RunningHub H3 Ref2VA。请调整后重新导出，或关闭该镜头的预演参考。')}</p>}
              {batchTiming.some(({ shot }) => shot.usePrevis) && <p className="small muted">{t('H3 参考视频合计最多 15 秒；同时引用前镜时，预演最长 13 秒，前镜按剩余额度取真实尾部并保留音轨。')}</p>}
              {!!autoFit.length && <p className="small batch-timing-note" role="status">
                {t('确认生成时会自动延长 {count} 个镜头，按对白估算或模型要求补足时长；时长增加可能提高生成费用。')
                  .replace('{count}', String(autoFit.length))}
              </p>}
              {!!needsSplit.length && <div className="batch-timing-alert" role="alert">
                <p className="small danger">{t('{count} 个镜头超过当前模型的 {maximum} 秒上限，请拆分后生成。')
                  .replace('{count}', String(needsSplit.length)).replace('{maximum}', String(videoLimits.maximum))}</p>
                <div className="batch-timing-issues">
                  {needsSplit.map(({ shot, required, issue }) => <div key={shot.id} className="batch-timing-issue">
                    <div><strong>{shot.title}</strong><span className="small muted">
                      {t(issue === 'dialogue' ? '对白估算约 {duration} 秒' : '镜头设置为 {duration} 秒')
                        .replace('{duration}', String(issue === 'dialogue' ? required : shot.duration))}
                    </span></div>
                    <Button onClick={() => { setSelected(shot.id); setInspector(true); setBatch(null) }}>{t('编辑这个镜头')}</Button>
                  </div>)}
                </div>
                <Button onClick={() => setBatch(batch.filter((id) => !needsSplit.some(({ shot }) => shot.id === id)))}>
                  {t('取消选择超限镜头')}
                </Button>
              </div>}
              {!!dialogueIssues.length && <p className="small danger" role="alert">
                {t('{count} 个镜头的台词设置需要修正，请展开核对。').replace('{count}', String(dialogueIssues.length))}
              </p>}
              <details className="dialogue-review" open={dialogueIssues.length ? true : undefined}>
                <summary>{t('台词与读音核对')} · {batch.length} {t('镜头')}</summary>
                <p className="small muted">{t('以下是提交给工作流的朗读清单；保留原文，不增删词。生成后仍需核对实际音轨。')}</p>
                {!state.dialogueRulesReady && <p className="small muted">{t('台词规范更新需在当前任务结束后重启开发版。')}</p>}
                <div className="batch-dialogue-list">
                  {batchTiming.map(({ shot }) => <section key={shot.id}>
                    <div className="row-between"><strong>{shot.title}</strong>
                      <Button onClick={() => { setSelected(shot.id); setInspector(true); setBatch(null) }}>{t('编辑这个镜头')}</Button>
                    </div>
                    <DialoguePreview p={p} shot={shot} />
                  </section>)}
                </div>
              </details>
              <label className="check-label">
                <input type="checkbox" checked={stop} onChange={(e) => setStop(e.target.checked)} />
                {t('一个镜头失败时暂停同组尚未提交的镜头')}
              </label>
              <Field label={t('保存为分组（可选）')}>
                <input
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder={t('例如：第一场 · 咖啡馆')}
                />
              </Field>
              <p className="small muted">
                {t(providerNames[state.config.models.video.provider])} · {state.config.models.video.provider === 'runninghub' ?
                  `${videoWorkflow.id} · ${state.config.instanceType === 'plus' ? 'Plus' : 'Standard'}` : state.config.models.video.model}{' '}
                {t('· 并发')} 1{' '}
                {t('· 当前选择')} {batch.length} {t('镜头')}
              </p>
              {state.config.models.video.provider === 'minimax' && <p className="small muted">
                {t('海螺输出无对白音轨，配音请导入镜头音频。')}{' '}
                {t('当前海螺接口不支持尾帧衔接；需要接回后镜头时请选择 RunningHub 或可灵。')}
              </p>}
              <details className="batch-generation-details">
                <summary>{t('生成与衔接说明')}</summary>
                <p className="small muted">
                  {t('局部重生成自动接回保留镜头：首帧取同场景前镜尾帧，尾帧取同场景后镜首帧；相邻镜头也在本批时按新视频串行衔接，不使用被替换的旧视频。缺少相邻视频的一侧不添加自动首尾帧。')}
                </p>
                <p className="small muted">
                  {t(state.config.models.video.provider === 'runninghub' ? '按导演台镜头顺序逐个生成；同场景使用上一镜尾帧和视频衔接，有音轨时参考音色与环境声。每镜最多使用 9 张人物、场景、道具参考图。' :
                    '按镜头顺序生成，同场景继承上一镜实际尾帧作为首帧。此接口不继承音轨或多参考图。')}
                </p>
                <p className="small muted">
                  {t('生成规范：人物与环境稳定、动作连续、音色一致、对白准确且声音清晰。生成后请逐镜检查。')}
                </p>
              </details>
              {!videoKeyReady && (
                <Button onClick={() => setSettings(true)}>{t('先配置视频模型 Key')}</Button>
              )}
            </div>
            <div className="modal-footer">
              <Button
                disabled={!groupName.trim() || !batch.length}
                onClick={async () => {
                  const r = await run({
                    type: 'group',
                    projectId: p.id,
                    title: groupName,
                    shotIds: batch,
                    stopOnFailure: stop,
                  })
                  if (r.ok) {
                    setBatch(null)
                    setGroupName('')
                  }
                }}
              >
                {t('仅保存分组')}
              </Button>
              <Button
                primary
                disabled={!batch.length || batch.length > 100 || !videoKeyReady || !!needsSplit.length || !!dialogueIssues.length || !!previsIssues.length}
                onClick={async () => {
                  setError('')
                  const r = await run({
                    type: 'queue',
                    projectId: p.id,
                    shotIds: batch,
                    stopOnFailure: stop,
                  })
                  if (r.ok) setBatch(null)
                }}
              >
                <Play size={14} />
                {t('确认生成')} {batch.length} {t('个视频')}
              </Button>
            </div>
          </Modal>
        )}
        {groups && p && (
          <Modal title={t('镜头分组')} onClose={() => setGroups(false)}>
            <div className="modal-body">
              {p.groups.map((g) => (
                <div className="group-row" key={g.id}>
                  <div>
                    <strong>{g.title}</strong>
                    <p className="small muted">
                      {g.shotIds.length} {t('镜头 ·')}{' '}
                      {g.stopOnFailure ? t('失败时暂停') : t('继续其他镜头')}
                    </p>
                  </div>
                  <Button
                    onClick={() => {
                      setBatch(g.shotIds)
                      setStop(g.stopOnFailure)
                      setGroups(false)
                    }}
                  >
                    <Play size={13} />
                    {t('运行')}
                  </Button>
                  <button
                    className="icon-button"
                    aria-label={`${t('删除分组')} ${g.title}`}
                    onClick={() =>
                      void run({ type: 'deleteGroup', projectId: p.id, groupId: g.id })
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {!p.groups.length && (
                <p className="muted">{t('还没有分组。点击“创建分组”，选择镜头并填写名称。')}</p>
              )}
            </div>
            <div className="modal-footer">
              <Button
                primary
                onClick={() => {
                  setGroups(false)
                  setBatch(shots.map((s) => s.id))
                }}
              >
                {t('创建分组')}
              </Button>
            </div>
          </Modal>
        )}
        {history && p && (
          <Modal
            title={t('项目历史')}
            subtitle={t('保留最近 100 次内容变更。恢复历史不会删除已下载的素材。')}
            onClose={() => setHistory(null)}
          >
            <div className="modal-body history-list">
              {history.map((h) => (
                <div key={h.revision}>
                  <span>
                    {t('版本')} {h.revision} <small>{new Date(h.created).toLocaleString()}</small>
                  </span>
                  <Button
                    onClick={() =>
                      setConfirm({
                        title: `${t('恢复到版本')} ${h.revision}?`,
                        text: t(
                          '当前剧本、资产设定与分镜将被历史内容替换；当前版本会继续保留在历史中。',
                        ),
                        run: async () => {
                          await run({ type: 'restore', projectId: p.id, revision: h.revision })
                          setHistory(null)
                        },
                      })
                    }
                  >
                    {t('恢复')}
                  </Button>
                </div>
              ))}
              {!history.length && <p>{t('还没有历史修改。')}</p>}
            </div>
          </Modal>
        )}
        {scriptArchiveOpen && p && (
          <Modal
            title={t('剧本与视频存档')}
            subtitle={t('保存每次剧本更新前的正文、分镜和视频；当前导演台只显示新版分镜。')}
            wide
            onClose={() => setScriptArchiveOpen(false)}
          >
            <div className="modal-body script-archive-layout">
              <div className="script-archive-list">
                {[...p.scriptArchives].reverse().map((archive) => (
                  <button
                    key={archive.id}
                    className={archive.id === selectedArchive?.id ? 'selected' : ''}
                    onClick={() => { setScriptArchiveId(archive.id); setArchiveShotId(''); setArchiveVideoId('') }}
                  >
                    <strong>{archive.title}</strong>
                    <small>{new Date(archive.createdAt).toLocaleString()}</small>
                    <span>{archive.shots.length} {t('个镜头')} · {archive.shots.filter((s) => s.videoMediaId).length} {t('个视频就绪')}</span>
                  </button>
                ))}
                {!p.scriptArchives.length && <p className="small muted">{t('还没有剧本存档。更新已有剧本后会自动保存旧版。')}</p>}
              </div>
              {selectedArchive && (
                <div className="script-archive-detail">
                  <h3>{selectedArchive.title}</h3>
                  <span className="small muted">{t('旧版剧本')}</span>
                  <pre className="script-archive-text">{selectedArchive.script || t('此版本没有剧本文字')}</pre>
                  {!!selectedArchive.shots.length && (
                    <>
                      <span className="small muted">{t('旧版分镜与视频')}</span>
                      <div className="script-archive-shot-list">
                        {selectedArchive.shots.map((item, i) => (
                          <button
                            key={item.id}
                            className={item.id === archivedShot?.id ? 'selected' : ''}
                            onClick={() => { setArchiveShotId(item.id); setArchiveVideoId('') }}
                          >
                            {String(i + 1).padStart(2, '0')} · {item.title}
                            {item.videoMediaId ? ` · ${t('有视频')}` : ''}
                          </button>
                        ))}
                      </div>
                      {archivedShot && (
                        <div className="script-archive-preview">
                          {archivedVideos.length > 1 && (
                            <div className="script-archive-versions">
                              {archivedVideos.map((video, index) => (
                                <button
                                  key={video.id}
                                  className={video.id === archivedVideo?.id ? 'selected' : ''}
                                  onClick={() => setArchiveVideoId(video.id)}
                                >
                                  v{index + 1}
                                </button>
                              ))}
                            </div>
                          )}
                          <Preview p={p} mediaId={archivedVideo?.id} slot="video" controls />
                          <p className="small muted">{archivedShot.action} {archivedShot.dialogue}</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </Modal>
        )}
        {confirm && (
          <Modal title={confirm.title} onClose={() => setConfirm(null)}>
            <div className="modal-body">
              <p>{confirm.text}</p>
            </div>
            <div className="modal-footer">
              <Button onClick={() => setConfirm(null)}>{t('返回')}</Button>
              <Button
                primary
                onClick={async () => {
                  await confirm.run()
                  setConfirm(null)
                }}
              >
                {t('确认')}
              </Button>
            </div>
          </Modal>
        )}
        {toast && (
          <div className="toast" role="status">
            <Check size={16} />
            <span>{t(toast)}</span>
            <button className="icon-button" aria-label={t('关闭提示')} onClick={() => setToast('')}>
              <X size={14} />
            </button>
          </div>
        )}
        {error && (
          <div className="error-toast" role="alert">
            <div>
              <strong>{t('操作未完成')}</strong>
              <p>{t(error)}</p>
            </div>
            <button className="icon-button" aria-label={t('关闭错误')} onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
      </Language.Provider>
    </Workspace.Provider>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
