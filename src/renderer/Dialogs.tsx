import { useT } from './i18n'
import { useEffect, useState } from 'react'
import {
  Plus,
  Copy,
  KeyRound,
  ShieldCheck,
  FolderArchive,
  FileText,
  Film,
  Braces,
  CheckCircle2,
} from 'lucide-react'
import { type AiRequest, type Reply, type Project, type Shot } from '../shared/schema'
import { buildPrompt, parseDirector } from '../shared/director'
import { AITaskProgress, Button, Field, Modal, useWorkspace } from './ui'

export function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const t = useT()
  const { run } = useWorkspace(),
    [title, setTitle] = useState(() => t('我的第一部短剧')),
    [aspect, setAspect] = useState<Project['aspect']>('16:9'),
    [demo, setDemo] = useState(false)
  return (
    <Modal
      title={t('新建导演项目')}
      subtitle={t('从一个故事开始。内容和素材保存在这台电脑。')}
      onClose={onClose}
    >
      <div className="modal-body">
        <Field label={t('项目名称')}>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
        </Field>
        <Field label={t('画面比例')}>
          <div className="aspect-options">
            {(['16:9', '9:16', '1:1'] as const).map((a) => (
              <button
                key={a}
                className={a === aspect ? 'selected' : ''}
                onClick={() => setAspect(a)}
              >
                <span
                  style={{
                    aspectRatio: a.replace(':', '/'),
                    height: 30,
                    border: '1.5px solid currentColor',
                    borderRadius: 3,
                  }}
                />
                {a}
                <small>
                  {a === '16:9' ? t('电影横屏') : a === '9:16' ? t('移动短剧') : t('方形画幅')}
                </small>
              </button>
            ))}
          </div>
        </Field>
        <label className="check-label">
          <input
            type="checkbox"
            checked={demo}
            onChange={(e) => {
              setDemo(e.target.checked)
              if (e.target.checked) setTitle('雨夜来信')
            }}
          />
          {t('载入「雨夜来信」示例剧本和 6 个镜头')}
        </label>
        <p className="muted small">{t('示例只有可编辑文字，不包含假冒的 AI 生成结果。')}</p>
      </div>
      <div className="modal-footer">
        <Button onClick={onClose}>{t('取消')}</Button>
        <Button
          primary
          disabled={!title.trim()}
          onClick={async () => {
            const r = await run({ type: 'create', title: title.trim(), aspect, demo })
            if (r.ok) {
              onCreated(r.state.projects[0].id)
              onClose()
            }
          }}
        >
          <Plus size={15} />
          {t('创建项目')}
        </Button>
      </div>
    </Modal>
  )
}
export function GenerationDialog({
  p,
  episodeId,
  kind,
  shot,
  assetId,
  slot = 'first',
  onSubmit,
  onClose,
}: {
  p: Project
  episodeId: string
  kind: 'script' | 'assets' | 'image'
  shot?: Shot
  assetId?: string
  slot?: 'first' | 'last'
  onSubmit: (request: AiRequest) => Promise<Reply>
  onClose: () => void
}) {
  const t = useT()
  const ownerId = assetId || shot?.id
  const imageSlot = assetId ? 'reference' : slot
  const { run, notice, state } = useWorkspace()
  const currentTask = state.aiTasks.find((task) => {
    const request = task.request
    return request.projectId === p.id && (kind === 'image'
      ? request.type === 'generateImage' && request.ownerId === ownerId && request.slot === imageSlot
      : request.type === 'generateText' && request.episodeId === episodeId && request.kind === kind)
  })
  const savedPrompt = currentTask && ['queued', 'running'].includes(currentTask.status) && 'prompt' in currentTask.request
    ? currentTask.request.prompt : undefined
  const [prompt, setPrompt] = useState(savedPrompt || buildPrompt(p, episodeId, kind, shot, assetId)),
    [raw, setRaw] = useState(''),
    [step, setStep] = useState<'prompt' | 'result'>('prompt'),
    [submitting, setGenerating] = useState(false)
  const generating = submitting || currentTask?.status === 'running' || currentTask?.status === 'queued'
  const queueBusy = state.aiTasks.some((task) => ['queued', 'running'].includes(task.status))
  useEffect(() => {
    if (kind !== 'image' && currentTask?.status === 'succeeded' && currentTask.resultText) {
      setRaw(currentTask.resultText)
      setStep('result')
    }
  }, [kind, currentTask?.status, currentTask?.resultText])
  let valid = false,
    summary = t('等待生成结果或粘贴 JSON 后预览')
  if (raw.trim())
    try {
      const r = parseDirector(raw)
      valid = true
      summary = `${r.shots?.length || 0} ${t('个镜头 ·')} ${r.assets?.length || 0} ${t('个资产')}${r.script !== undefined ? t(' · 包含剧本') : ''}`
    } catch {
      summary = t('JSON 尚不完整，或字段格式不符合要求')
    }
  return (
    <Modal
      title={
        kind === 'image'
          ? `${t(assetId ? 'AI 生成参考图 ·' : 'AI 生图 ·')} ${assetId ? p.assets.find((a) => a.id === assetId)?.name : slot === 'last' ? t('尾帧') : t('首帧')}`
          : t('AI 创作助手')
      }
      subtitle={
        kind === 'image'
          ? t('使用设置中选择的图片模型，直接生成并保存图片。')
          : t('使用设置中选择的文字模型，生成结果直接返回软件。')
      }
      onClose={onClose}
      wide
    >
      {kind !== 'image' && <div className="flow-steps">
        <button className={step === 'prompt' ? 'active' : ''} onClick={() => setStep('prompt')}>
          {t('1 编辑提示词')}
        </button>
        <span>→</span>
        <button className={step === 'result' ? 'active' : ''} onClick={() => setStep('result')}>
          {t('2 导入生成结果')}
        </button>
      </div>}
      <div className="modal-body">
        {step === 'prompt' ? (
          <>
            <div className="notice">
              <ShieldCheck size={18} />
              <div>
                {kind === 'image' ? t(assetId ? '生成后自动设为当前参考图' : '直接生成图片') : t('直接生成文字')}
                <p>
                  {kind === 'image'
                    ? t('使用独立配置的图片服务；完成后自动保存为当前镜头或资产的图片素材。')
                    : t('点击生成后，文字结果会直接返回软件。')}
                </p>
              </div>
            </div>
            <Field label={t('发送给模型的提示词')}>
              <textarea
                className="prompt-editor"
                rows={14}
                maxLength={kind === 'image' ? 12000 : undefined}
                value={prompt}
                disabled={generating}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </Field>
            {currentTask && <AITaskProgress task={currentTask} runningLabel={kind === 'image'
              ? '正在生成图片，可关闭此窗口，完成后自动保存。' : undefined} />}
            {kind === 'image' && currentTask?.status === 'succeeded' && (
              <p className="small" role="status">{t('图片已生成并保存到当前项目素材。')}</p>
            )}
            {currentTask?.error && <p className="danger small" role="alert">{t(currentTask.error)}</p>}
          </>
        ) : (
          <>
            <div className="row-between">
              <span>{t('结构化生成结果')}</span>
              <Button
                onClick={async () => {
                  const r = await run({ type: 'clipboard' })
                  if (r.ok) setRaw(r.text || '')
                }}
              >
                <Copy size={14} />
                {t('读取剪贴板')}
              </Button>
            </div>
            <textarea
              className="prompt-editor mono"
              rows={15}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={'{"script": "…", "assets": […], "shots": […]}'}
            />
            <div className={`parse-status ${valid ? 'success' : ''}`}>
              {valid && <CheckCircle2 size={14} />} {summary}
            </div>
            <p className="small muted">
              {t('同名资产合并；分镜追加到当前集，不覆盖你已有的镜头。可通过项目历史恢复。')}
            </p>
          </>
        )}
      </div>
      <div className="modal-footer">
        <Button onClick={onClose}>{t('完成 / 关闭')}</Button>
        {step === 'prompt' ? (
          <>
            {kind !== 'image' && (
              <Button
                primary
                disabled={generating}
                onClick={async () => {
                  setGenerating(true)
                  try {
                    await onSubmit({
                      type: 'generateText',
                      projectId: p.id,
                      episodeId,
                      kind,
                      prompt,
                    })
                  } finally {
                    setGenerating(false)
                  }
                }}
              >
                {generating ? t(currentTask?.status === 'queued' ? '排队中' : '正在生成回复…') : t(queueBusy ? '加入 AI 队列' : '在软件中直接生成')}
              </Button>
            )}
            {kind === 'image' && (
              <Button
                primary
                disabled={generating || !prompt.trim() || !ownerId}
                onClick={async () => {
                  if (!ownerId) return
                  setGenerating(true)
                  try {
                    await onSubmit({ type: 'generateImage', projectId: p.id, ownerId,
                      prompt: prompt.trim(), slot: imageSlot })
                  } finally { setGenerating(false) }
                }}
              >
                {generating ? t(currentTask?.status === 'queued' ? '排队中' : '正在生成图片…') : t(queueBusy ? '加入 AI 队列' : '在软件中直接生成图片')}
              </Button>
            )}
          </>
        ) : kind !== 'image' ? (
          <Button
            primary
            disabled={!valid}
            onClick={async () => {
              const r = await run({ type: 'parse', projectId: p.id, episodeId, raw })
              if (r.ok) onClose()
              else notice(r.error)
            }}
          >
            <Braces size={15} />
            {t('确认导入项目')}
          </Button>
        ) : (
          <Button onClick={() => setStep('prompt')}>{t('返回提示词')}</Button>
        )}
      </div>
    </Modal>
  )
}
export function StoryboardDialog({
  p,
  episodeId,
  onSubmit,
  onClose,
}: {
  p: Project
  episodeId: string
  onSubmit: (request: AiRequest) => Promise<Reply>
  onClose: () => void
}) {
  const t = useT()
  const { state } = useWorkspace()
  const task = state.aiTasks.find((task) => task.request.type === 'generateStoryboard' &&
    task.projectId === p.id && task.request.episodeId === episodeId)
  const [request, setRequest] = useState(task?.request.type === 'generateStoryboard' && task.status !== 'succeeded' ? task.request.request : '')
  const [submitting, setGenerating] = useState(false)
  const generating = submitting || task?.status === 'queued' || task?.status === 'running'
  const queueBusy = state.aiTasks.some((task) => ['queued', 'running'].includes(task.status))
  const episode = p.episodes.find((item) => item.id === episodeId)
  return (
    <Modal
      title={t('AI 生成分镜')}
      subtitle={t('使用设置中选择的文字模型生成可编辑的分镜镜头。')}
      onClose={onClose}
    >
      <div className="modal-body">
        <div className="notice">
          <ShieldCheck size={18} />
          <div>
            {episode?.title || t('当前集')}
            <p>{t('会参考当前剧本和项目资产；新分镜将追加到当前集，已有镜头保留。')}</p>
          </div>
        </div>
        <Field label={t('补充创作要求（可选）')}>
          <textarea
            rows={5}
            maxLength={2000}
            value={request}
            disabled={generating}
            onChange={(event) => setRequest(event.target.value)}
            placeholder={t('例如：用 8 个镜头突出主角发现线索的悬念。')}
          />
        </Field>
        {task && <AITaskProgress task={task} runningLabel="正在生成分镜，可关闭窗口继续处理。" />}
        {task?.error && (
          <p className="danger small" role="alert">
            {t(task.error)}
          </p>
        )}
      </div>
      <div className="modal-footer">
        <Button onClick={onClose}>
          {t('关闭')}
        </Button>
        <Button
          primary
          disabled={generating}
          onClick={async () => {
            setGenerating(true)
            try {
              await onSubmit({ type: 'generateStoryboard', projectId: p.id, episodeId, request: request.trim() })
            } finally {
              setGenerating(false)
            }
          }}
        >
          {generating ? t(task?.status === 'queued' ? '排队中' : '正在生成分镜…') : t(queueBusy ? '加入 AI 队列' : '生成分镜')}
        </Button>
      </div>
    </Modal>
  )
}
export { SettingsDialog } from './Settings'
export function ExportDialog({
  p,
  episodeId,
  onClose,
}: {
  p: Project
  episodeId: string
  onClose: () => void
}) {
  const t = useT()
  const { state, run } = useWorkspace(),
    shots = p.shots.filter((s) => s.episodeId === episodeId),
    ready = shots.filter((s) => s.videoMediaId).length
  return (
    <Modal
      title={t('导出与存档')}
      subtitle={`${p.title} · ${p.episodes.find((e) => e.id === episodeId)?.title}`}
      onClose={onClose}
    >
      <div className="modal-body">
        <div className="export-summary">
          <strong>
            {ready}
            <span> / {shots.length}</span>
          </strong>
          <p>
            {t('镜头视频已就绪 ·')} {shots.reduce((n, s) => n + s.duration, 0)} {t('秒 ·')}{' '}
            {p.aspect}
          </p>
        </div>
        <div className="export-options">
          <Button
            disabled={state.exporting || !shots.length || ready !== shots.length}
            onClick={() =>
              void run({ type: 'exportEpisode', projectId: p.id, episodeId, format: 'mp4' })
            }
          >
            <Film size={20} />
            <span>
              <strong>{t('导出整集 MP4 + SRT')}</strong>
              <small>{t('按镜头顺序统一画幅、时长与音频')}</small>
              <small>{t('右下角添加幕织品牌水印')}</small>
            </span>
          </Button>
          <Button
            disabled={state.exporting || !shots.length}
            onClick={() =>
              void run({ type: 'exportEpisode', projectId: p.id, episodeId, format: 'srt' })
            }
          >
            <FileText size={20} />
            <span>
              <strong>{t('字幕文件 SRT')}</strong>
              <small>{t('根据镜头时长生成对白时间码')}</small>
            </span>
          </Button>
          <Button
            disabled={state.exporting || !shots.length}
            onClick={() =>
              void run({ type: 'exportEpisode', projectId: p.id, episodeId, format: 'html' })
            }
          >
            <Braces size={20} />
            <span>
              <strong>{t('可打印分镜表 HTML')}</strong>
              <small>{t('包含首帧、导演参数与对白')}</small>
            </span>
          </Button>
          <Button onClick={() => void run({ type: 'exportArchive', projectId: p.id })}>
            <FolderArchive size={20} />
            <span>
              <strong>{t('完整项目 ZIP 存档')}</strong>
              <small>{t('剧本、画布、资产和全部素材版本；不含 Key')}</small>
            </span>
          </Button>
        </div>
        <p className="small muted">
          {t(
            '导出以当前选择的视频和音频版本为准。无配音导入时保留原视频音轨；短素材以尾帧/静音补齐。SRT 为独立字幕，不烧录进画面。ZIP 素材总量上限 512 MB。',
          )}
        </p>
        {state.exporting && (
          <div className="notice">
            {t('正在本机处理视频，你可以继续编辑。')}
            <Button onClick={() => void run({ type: 'cancelExport' })}>{t('取消导出')}</Button>
          </div>
        )}
      </div>
    </Modal>
  )
}
