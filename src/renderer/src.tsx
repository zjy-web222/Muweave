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
} from 'lucide-react'
import {
  blankShot,
  type Asset,
  type Command,
  type Project,
  type Reply,
  type Shot,
  type Snapshot,
} from '../shared/schema'
import { Button, Empty, Modal, Field, Preview, Workspace, Working } from './ui'
import Canvas from './Canvas'
import Inspector from './Inspector'
import { CreateDialog, GenerationDialog, SettingsDialog, ExportDialog } from './Dialogs'
import { AssetsView, CutView, ScriptEditor, Tasks } from './Production'
import './styles.css'
import { Language, translate } from './i18n'

type Stage = 'script' | 'assets' | 'board' | 'cut'
type Generator = {
  kind: 'script' | 'assets' | 'storyboard' | 'image'
  shot?: Shot
  assetId?: string
  slot?: 'first' | 'last'
}
function App() {
  const [state, setState] = useState<Snapshot | null>(null),
    [pid, setPid] = useState(''),
    [epid, setEpid] = useState(''),
    [selected, setSelected] = useState(''),
    [stage, setStage] = useState<Stage>('board'),
    [view, setView] = useState<'canvas' | 'list'>('canvas'),
    [inspector, setInspector] = useState(true),
    [query, setQuery] = useState(''),
    [toast, setToast] = useState(''),
    [error, setError] = useState(''),
    [create, setCreate] = useState(false),
    [settings, setSettings] = useState(false),
    [exporting, setExporting] = useState(false),
    [tasks, setTasks] = useState(false),
    [generator, setGenerator] = useState<Generator | null>(null),
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
    [newEpisode, setNewEpisode] = useState(false),
    [episodeTitle, setEpisodeTitle] = useState('第二集')
  const t = (text: string) => translate(state?.config.locale || 'zh', text)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const notice = useCallback((s: string) => {
    setToast(s)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 6500)
  }, [])
  const run = useCallback(
    async (c: Command): Promise<Reply> => {
      try {
        const r = await window.director.command(c)
        if (r.ok) {
          setState(r.state)
          if (r.message) notice(r.message)
        } else setError(r.error)
        return r
      } catch (e) {
        const error = e instanceof Error ? e.message : t('桌面连接失败')
        setError(error)
        return { ok: false, error }
      }
    },
    [notice],
  )
  useEffect(() => {
    void run({ type: 'snapshot' })
    return window.director.onChange(() => {
      void run({ type: 'snapshot' })
    })
  }, [run])
  const p = state?.projects.find((p) => p.id === pid) || state?.projects[0],
    episodeId = p?.episodes.find((e) => e.id === epid)?.id || p?.episodes[0]?.id || '',
    episode = p?.episodes.find((e) => e.id === episodeId)
  const shots = p?.shots.filter((s) => s.episodeId === episodeId) || [],
    filtered = shots.filter((s) =>
      `${s.title} ${s.action} ${s.scene}`.toLowerCase().includes(query.toLowerCase()),
    ),
    shot = shots.find((s) => s.id === selected) || shots[0],
    jobs = state?.jobs.filter((j) => j.projectId === p?.id) || [],
    activeJobs =
      state?.jobs.filter((j) =>
        ['queued', 'running', 'submitting', 'downloading'].includes(j.status),
      ) || []
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
          <aside className="sidebar">
            <div className="brand">
              <div className="brand-mark">
                <img src={brandMark} alt="" />
              </div>
              <div>
                Muweave <span className="brand-cn">{t('幕织')}</span>
                <small>WEAVE YOUR STORY</small>
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
                <button
                  key={project.id}
                  className={p?.id === project.id ? 'active' : ''}
                  onClick={() => {
                    setPid(project.id)
                    setEpid('')
                  }}
                >
                  <FolderOpen size={16} />
                  <span>{project.title}</span>
                  {p?.id === project.id && <span className="active-dot" />}
                </button>
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
                    <button
                      className={ep.id === episodeId ? 'active' : ''}
                      key={ep.id}
                      onClick={() => setEpid(ep.id)}
                    >
                      <span className="mono">{String(i + 1).padStart(2, '0')}</span>
                      <span>{ep.title}</span>
                    </button>
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
                    <Button onClick={() => setExporting(true)}>
                      <Download size={14} />
                      {t('导出 / 存档')}
                    </Button>
                  </>
                )}
              </div>
            </header>
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
                          onClick={() => setStage(s.id)}
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
                      <span className={state.chatgptOpen ? 'green-dot' : 'neutral-dot'} />
                      ChatGPT
                    </button>
                    <button onClick={() => setSettings(true)}>
                      <span className={state.hasKey ? 'green-dot' : 'neutral-dot'} />
                      RunningHub
                      <ChevronDown size={12} />
                    </button>
                  </div>
                </div>
                {stage === 'board' ? (
                  <div className="director-body">
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
                        <Button primary onClick={() => setGenerator({ kind: 'storyboard' })}>
                          <Sparkles size={14} />
                          {t('AI 拆解分镜')}
                        </Button>
                      </div>
                      <div className="canvas-toolbar">
                        <div className="segmented">
                          <button
                            className={view === 'canvas' ? 'active' : ''}
                            onClick={() => setView('canvas')}
                          >
                            <PanelsTopLeft size={14} />
                            {t('画布')}
                          </button>
                          <button
                            className={view === 'list' ? 'active' : ''}
                            onClick={() => setView('list')}
                          >
                            <List size={14} />
                            {t('列表')}
                          </button>
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
                        {filtered.length ? (
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
                              : t(
                                  '从剧本拆解，或手动新建镜头。脚本、画面与视频在同一张画布上连接。',
                                )}
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
                            {state.config.paused ? t('新提交已暂停') : t('所有改动保存在本机')}
                          </span>
                        </div>
                        <span>
                          {t('任务中心')}
                          <ChevronRight size={13} />
                        </span>
                      </footer>
                    </div>
                    {inspector && shot && (
                      <Inspector
                        key={shot.id}
                        p={p}
                        shot={shot}
                        onGenerate={(s, slot) => setGenerator({ kind: 'image', shot: s, slot })}
                        onVideo={video}
                        onDelete={() =>
                          setConfirm({
                            title: t('移除这个镜头？'),
                            text: t('镜头将从分镜列表移除，素材文件和历史版本会保留。'),
                            run: () =>
                              run({ type: 'deleteShot', projectId: p.id, shotId: shot.id }),
                          })
                        }
                      />
                    )}
                  </div>
                ) : stage === 'script' ? (
                  <ScriptEditor
                    key={`${p.id}-${episodeId}`}
                    p={p}
                    episodeId={episodeId}
                    onGenerate={(kind) => setGenerator({ kind })}
                  />
                ) : stage === 'assets' ? (
                  <AssetsView
                    key={p.id}
                    p={p}
                    onGenerate={(a: Asset) => setGenerator({ kind: 'image', assetId: a.id })}
                  />
                ) : (
                  <CutView
                    key={`${p.id}-${episodeId}`}
                    p={p}
                    shots={shots}
                    onSelect={(id) => {
                      chooseShot(id)
                      setStage('board')
                    }}
                    onExport={() => setExporting(true)}
                  />
                )}
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
                    {t('RunningHub 视频')}
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
        {tasks && <Tasks jobs={state.jobs} onClose={() => setTasks(false)} />}{' '}
        {p && generator && (
          <GenerationDialog
            p={p}
            episodeId={episodeId}
            {...generator}
            onClose={() => setGenerator(null)}
          />
        )}
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
            subtitle={t('调用你绑定的 RunningHub 工作流；生成可能产生远端费用。')}
            onClose={() => setBatch(null)}
          >
            <div className="modal-body">
              <p>{t('选择需要运行的镜头')}</p>
              <div className="batch-shots">
                {shots.map((s) => (
                  <label key={s.id}>
                    <input
                      type="checkbox"
                      checked={batch.includes(s.id)}
                      onChange={(e) =>
                        setBatch(
                          e.target.checked ? [...batch, s.id] : batch.filter((id) => id !== s.id),
                        )
                      }
                    />
                    <span>{s.title}</span>
                    <small>{s.duration}s</small>
                  </label>
                ))}
              </div>
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
                {t('工作流：')}
                {state.config.workflowId || t('尚未设置')} {t('· 并发')} {state.config.concurrency}{' '}
                {t('· 当前选择')} {batch.length} {t('镜头')}
              </p>
              {!state.hasKey && (
                <Button onClick={() => setSettings(true)}>{t('先绑定 RunningHub Key')}</Button>
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
                disabled={!batch.length || !state.hasKey}
                onClick={async () => {
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
