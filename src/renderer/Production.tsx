import { useT } from './i18n'
import { useEffect, useState } from 'react'
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
} from 'lucide-react'
import { type Asset, type Job, type Project, type Shot } from '../shared/schema'
import { Button, Empty, Field, Modal, Preview, statusNames, useWorkspace, Versions } from './ui'

export function ScriptEditor({
  p,
  episodeId,
  onGenerate,
}: {
  p: Project
  episodeId: string
  onGenerate: (kind: 'script' | 'assets' | 'storyboard') => void
}) {
  const t = useT()
  const { run } = useWorkspace(),
    ep = p.episodes.find((e) => e.id === episodeId)!,
    [script, setScript] = useState(ep.script),
    [title, setTitle] = useState(ep.title),
    [style, setStyle] = useState(p.style),
    [dirty, setDirty] = useState(false),
    [chatRequest, setChatRequest] = useState(''),
    [chatBusy, setChatBusy] = useState(false),
    [accountConnected, setAccountConnected] = useState<boolean | null>(null)
  useEffect(() => {
    setScript(ep.script)
    setTitle(ep.title)
    setDirty(false)
  }, [ep.id, ep.script, ep.title])
  useEffect(() => {
    const refresh = () => {
      void run({ type: 'codexStatus' }).then((r) => {
        if (r.ok) setAccountConnected(r.text === 'connected')
      })
    }
    refresh()
    window.addEventListener('director:codex-login', refresh)
    return () => window.removeEventListener('director:codex-login', refresh)
  }, [p.id, run])
  async function save() {
    const r = await run({ type: 'episode', projectId: p.id, episodeId, title, script })
    if (r.ok) setDirty(false)
    await run({ type: 'project', projectId: p.id, patch: { style } })
    return r.ok
  }
  async function sendChatRequest() {
    const request = chatRequest.trim()
    if (!request || chatBusy) return
    setChatBusy(true)
    try {
      if (dirty && !(await save())) return
      const generated = await run({
        type: 'scriptChatGenerate',
        projectId: p.id,
        episodeId,
        request,
      })
      if (generated.ok) setChatRequest('')
    } finally {
      setChatBusy(false)
    }
  }
  async function applyChatScript(next: string) {
    if (chatBusy) return
    setChatBusy(true)
    try {
      if (dirty && !(await save())) return
      const applied = await run({
        type: 'episode',
        projectId: p.id,
        episodeId,
        title,
        script: next,
      })
      if (applied.ok) {
        setScript(next)
        setDirty(false)
      }
    } finally {
      setChatBusy(false)
    }
  }
  useEffect(() => {
    const handler = () => {
      void save()
    }
    window.addEventListener('director:save', handler)
    return () => window.removeEventListener('director:save', handler)
  }, [script, title, style])
  return (
    <div className="script-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">STORY DEVELOPMENT</span>
          <h1>{t('每个镜头，始于一个好故事。')}</h1>
          <p>{t('导入故事，让 ChatGPT 帮你构建剧本、资产和分镜。')}</p>
        </div>
        <Button onClick={() => void run({ type: 'importSource', projectId: p.id, episodeId })}>
          <Upload size={14} />
          {t('导入 TXT / MD / DOCX')}
        </Button>
      </div>
      <div className="script-grid">
        <section className="script-paper">
          <div className="row-between">
            <input
              className="episode-title"
              aria-label={t('集标题')}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                setDirty(true)
              }}
            />
            <Button onClick={() => void save()}>
              <Check size={14} />
              {dirty ? t('保存剧本') : t('已保存')}
            </Button>
          </div>
          <textarea
            className="script-text"
            aria-label={t('剧本正文')}
            value={script}
            onChange={(e) => {
              setScript(e.target.value)
              setDirty(true)
            }}
            placeholder={t(
              '写下你的故事，或导入小说 / 剧本。&#10;&#10;人物想要什么？什么阻碍了他们？这一集的最后，什么发生了变化？',
            )}
          />
          <div className="paper-footer">
            <span>
              {script.length.toLocaleString()} {t('字')}
            </span>
            <span>{t('纯文本剧本 · 手动保存')}</span>
          </div>
        </section>
        <aside className="script-tools">
          <section className="script-chat" aria-label={t('AI 编剧对话')}>
            <div className="note-heading">
              <MessageSquareText size={17} />
              <h3>{t('AI 编剧对话')}</h3>
            </div>
            <p className="small muted">
              {t('在这里输入要求，AI 会直接回复。生成的候选剧本由你决定何时应用。')}
            </p>
            <div className="script-chat-account">
              <span className={accountConnected ? 'green-dot' : 'neutral-dot'} />
              <span>
                {accountConnected === null
                  ? t('正在检查账号…')
                  : accountConnected
                    ? t('ChatGPT 账号已连接')
                    : t('需要连接 ChatGPT 账号')}
              </span>
              {accountConnected === false && (
                <Button
                  disabled={chatBusy}
                  onClick={async () => {
                    setChatBusy(true)
                    try {
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
            <div className="script-chat-history" aria-label={t('对话记录')}>
              {ep.scriptChat.length === 0 ? (
                <p className="small muted">{t('还没有对话。可以从人物、冲突或下一场戏开始。')}</p>
              ) : (
                ep.scriptChat.map((turn) => (
                  <article className={`script-chat-turn ${turn.role}`} key={turn.id}>
                    <strong>{turn.role === 'user' ? t('你') : t('AI 编剧')}</strong>
                    <p>{turn.text}</p>
                    {turn.script !== undefined && (
                      <div className="script-chat-draft">
                        <details>
                          <summary>
                            {t('查看候选剧本')} · {turn.script.length.toLocaleString()} {t('字')}
                          </summary>
                          <pre>{turn.script}</pre>
                        </details>
                        <Button
                          disabled={chatBusy || turn.script === ep.script}
                          onClick={() => void applyChatScript(turn.script!)}
                        >
                          {turn.script === ep.script ? t('已应用') : t('应用到剧本')}
                        </Button>
                      </div>
                    )}
                  </article>
                ))
              )}
            </div>
            <Field label={t('本轮创作要求')}>
              <textarea
                rows={3}
                maxLength={2000}
                value={chatRequest}
                onChange={(e) => setChatRequest(e.target.value)}
                placeholder={t('例如：让主角在第二场发现一个秘密，并强化结尾悬念。')}
              />
            </Field>
            <Button
              primary
              disabled={chatBusy || !chatRequest.trim() || accountConnected !== true}
              onClick={() => void sendChatRequest()}
            >
              <WandSparkles size={14} />
              {chatBusy ? t('正在生成回复…') : t('发送给 AI 编剧')}
            </Button>
          </section>
          <div className="note-heading">
            <WandSparkles size={17} />
            <h3>{t('创作路线')}</h3>
          </div>
          {[
            {
              n: '01',
              kind: 'script' as const,
              title: t('剧本改编'),
              text: t('故事冲突、对白、节奏与分集。'),
            },
            {
              n: '02',
              kind: 'assets' as const,
              title: t('提取视觉资产'),
              text: t('角色、场景和道具，共用一份设定。'),
            },
            {
              n: '03',
              kind: 'storyboard' as const,
              title: t('拆解镜头'),
              text: t('从剧本进入可编辑的导演画布。'),
            },
          ].map((s) => (
            <button
              className="creation-step"
              key={s.kind}
              onClick={async () => {
                if (await save()) onGenerate(s.kind)
              }}
            >
              <span className="mono">{s.n}</span>
              <div>
                <strong>{s.title}</strong>
                <p>{s.text}</p>
              </div>
              <WandSparkles size={14} />
            </button>
          ))}
          <Field label={t('全片视觉风格')}>
            <textarea
              rows={3}
              value={style}
              onChange={(e) => {
                setStyle(e.target.value)
                setDirty(true)
              }}
            />
          </Field>
          <p className="small muted">
            {t('视觉风格会加入每次生成提示词。角色参考图请在 ChatGPT 中附加，以增强一致性。')}
          </p>
        </aside>
      </div>
    </div>
  )
}
export function AssetsView({ p, onGenerate }: { p: Project; onGenerate: (a: Asset) => void }) {
  const t = useT()
  const { run } = useWorkspace(),
    [kind, setKind] = useState<'all' | Asset['kind']>('all'),
    [draft, setDraft] = useState<Asset | null>(null)
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
          {t('手动新建资产，或在剧本页用 ChatGPT 提取人物与场景。')}
        </Empty>
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
  shots,
  onSelect,
  onExport,
}: {
  p: Project
  shots: Shot[]
  onSelect: (id: string) => void
  onExport: () => void
}) {
  const t = useT()
  const { run } = useWorkspace(),
    [current, setCurrent] = useState(shots[0]?.id || '')
  const shot = shots.find((s) => s.id === current) || shots[0]
  return (
    <div className="cut-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">ASSEMBLY & DELIVERY</span>
          <h1>{t('从镜头，走向一个完整的故事。')}</h1>
          <p>{t('选择镜头预览；镜头时长和对白来自检查器，音轨可以单独导入。')}</p>
        </div>
        <Button primary onClick={onExport}>
          <FolderOpen size={15} />
          {t('导出整集')}
        </Button>
      </div>
      {shot ? (
        <>
          <div className="review-player">
            <Preview p={p} mediaId={shot.videoMediaId || shot.firstMediaId} slot="video" controls />
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
                onClick={() => setCurrent(s.id)}
              >
                <Preview p={p} mediaId={s.firstMediaId} />
                <span>
                  {String(i + 1).padStart(2, '0')} · {s.title}
                </span>
                <small>
                  {s.duration}s {s.videoMediaId ? t('· 有视频') : t('· 待生成')}
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
export function Tasks({ jobs, onClose }: { jobs: Job[]; onClose: () => void }) {
  const t = useT()
  const { run, state } = useWorkspace(),
    [attach, setAttach] = useState<Job | null>(null),
    [taskId, setTaskId] = useState(''),
    [confirm, setConfirm] = useState<{ job: Job; action: 'retry' | 'cancel' } | null>(null)
  return (
    <Modal
      title={t('任务中心')}
      subtitle={t('暂停只停止新提交。远端已生成的任务可在应用重启后继续查询。')}
      wide
      onClose={onClose}
    >
      <div className="modal-body">
        <div className="row-between">
          <span className="muted">
            {jobs.length} {t('条本地记录')}
          </span>
          <Button onClick={() => void run({ type: 'pause', paused: !state.config.paused })}>
            {state.config.paused ? <Play size={14} /> : <Pause size={14} />}{' '}
            {state.config.paused ? t('继续队列') : t('暂停队列')}
          </Button>
        </div>
        {!jobs.length ? (
          <Empty heading={t('队列很安静')}>{t('在导演画布生成一个视频，任务会出现在这里。')}</Empty>
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
          subtitle={t('在 RunningHub 任务记录中核实镜头、时间和工作流，再粘贴对应 ID。')}
          onClose={() => setAttach(null)}
        >
          <div className="modal-body">
            <Field label="Task ID">
              <input
                value={taskId}
                onChange={(e) => setTaskId(e.target.value.replace(/\D/g, ''))}
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
                    '这会发起新的 RunningHub 任务，可能再次计费。确认原任务已结束，或确实需要重新生成。',
                  )
                : confirm.job.status === 'uncertain'
                  ? t(
                      '原提交结果不确定。必须先在 RunningHub 核实并处理可能存在的任务；此操作仅关闭本地待核实记录，不保证远端取消。',
                    )
                  : t('已产生的远端计算费用以 RunningHub 为准。提交中的任务需要先等待返回 ID。')}
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
