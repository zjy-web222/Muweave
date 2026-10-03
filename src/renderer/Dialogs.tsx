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
import { type Config, type Project, type Shot, videoWorkflow } from '../shared/schema'
import { buildPrompt, parseDirector, storyboardImport } from '../shared/director'
import { Button, Field, Modal, useWorkspace } from './ui'

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
  onClose,
}: {
  p: Project
  episodeId: string
  kind: 'script' | 'assets' | 'image'
  shot?: Shot
  assetId?: string
  slot?: 'first' | 'last'
  onClose: () => void
}) {
  const t = useT()
  const { run, notice } = useWorkspace(),
    [prompt, setPrompt] = useState(buildPrompt(p, episodeId, kind, shot, assetId)),
    [raw, setRaw] = useState(''),
    [step, setStep] = useState<'prompt' | 'result'>('prompt'),
    [generating, setGenerating] = useState(false)
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
          ? `${t('ChatGPT 生图 ·')} ${assetId ? p.assets.find((a) => a.id === assetId)?.name : slot === 'last' ? t('尾帧') : t('首帧')}`
          : t('ChatGPT 创作助手')
      }
      subtitle={
        kind === 'image'
          ? t('使用已连接的 ChatGPT 账号，在软件中直接生成并保存图片。')
          : t('连接 ChatGPT 账号后，文字结果可直接返回软件。')
      }
      onClose={() => !generating && onClose()}
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
                {kind === 'image' ? t('直接生成图片') : t('直接生成文字')}
                <p>
                  {kind === 'image'
                    ? t('使用与文字生成相同的 ChatGPT 授权；完成后自动保存为当前镜头或资产的图片素材。')
                    : t('点击生成后，文字结果会直接返回软件。')}
                </p>
              </div>
            </div>
            <Field label={t('发送给 ChatGPT 的提示词')}>
              <textarea
                className="prompt-editor"
                rows={14}
                maxLength={kind === 'image' ? 12000 : undefined}
                value={prompt}
                disabled={generating}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </Field>
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
        <Button disabled={generating} onClick={onClose}>{t('完成 / 关闭')}</Button>
        {step === 'prompt' ? (
          <>
            {kind !== 'image' && (
              <Button
                primary
                disabled={generating}
                onClick={async () => {
                  setGenerating(true)
                  try {
                    const r = await run({
                      type: 'generateText',
                      projectId: p.id,
                      episodeId,
                      kind,
                      prompt,
                    })
                    if (r.ok) {
                      setRaw(r.text || '')
                      setStep('result')
                    }
                  } finally {
                    setGenerating(false)
                  }
                }}
              >
                {generating ? t('正在生成回复…') : t('在软件中直接生成')}
              </Button>
            )}
            {kind === 'image' && (
              <Button
                primary
                disabled={generating || !prompt.trim()}
                onClick={async () => {
                  setGenerating(true)
                  try {
                    const r = await run({
                      type: 'generateImage',
                      projectId: p.id,
                      ownerId: assetId || shot!.id,
                      prompt: prompt.trim(),
                      slot: assetId ? 'reference' : slot,
                    })
                    if (r.ok) {
                      notice(t('图片已生成并保存到当前项目素材。'))
                      onClose()
                    }
                  } finally {
                    setGenerating(false)
                  }
                }}
              >
                {generating ? t('正在生成图片…') : t('在软件中直接生成图片')}
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
  onClose,
}: {
  p: Project
  episodeId: string
  onClose: () => void
}) {
  const t = useT()
  const { run, notice } = useWorkspace()
  const [request, setRequest] = useState('')
  const [generating, setGenerating] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const episode = p.episodes.find((item) => item.id === episodeId)
  useEffect(() => {
    if (!generating) return
    const start = Date.now()
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    )
    return () => window.clearInterval(timer)
  }, [generating])
  return (
    <Modal
      title={t('AI 生成分镜')}
      subtitle={t('使用已连接的 ChatGPT 账号生成可编辑的分镜镜头。')}
      onClose={() => !generating && onClose()}
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
        {generating && (
          <p className="small muted" role="status">
            {t('正在连接并生成分镜，请保持窗口打开。')} {Math.floor(elapsed / 60)}:
            {String(elapsed % 60).padStart(2, '0')}
          </p>
        )}
        {error && (
          <p className="danger small" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="modal-footer">
        <Button disabled={generating} onClick={onClose}>
          {t('取消')}
        </Button>
        <Button
          primary
          disabled={generating}
          onClick={async () => {
            setElapsed(0)
            setGenerating(true)
            setError('')
            try {
              const prompt = buildPrompt(p, episodeId, 'storyboard')
              const generated = await run({
                type: 'generateText',
                projectId: p.id,
                episodeId,
                kind: 'storyboard',
                prompt: request.trim() ? `${prompt}\n\n用户补充要求：${request.trim()}` : prompt,
              })
              if (!generated.ok) return
              const raw = storyboardImport(generated.text || '')
              const imported = await run({ type: 'parse', projectId: p.id, episodeId, raw })
              if (imported.ok) {
                notice(t('分镜已追加到当前集'))
                onClose()
              }
            } catch (cause) {
              setError(
                cause instanceof Error && cause.message === 'AI 未返回分镜镜头，请修改要求后重试。'
                  ? t(cause.message)
                  : t('AI 返回的分镜格式无效，请修改要求后重试。'),
              )
            } finally {
              setGenerating(false)
            }
          }}
        >
          {generating ? t('正在生成分镜…') : t('生成分镜')}
        </Button>
      </div>
    </Modal>
  )
}
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const { state, run } = useWorkspace(),
    [c, setC] = useState<Config>(structuredClone(state.config)),
    [key, setKey] = useState(''),
    [output, setOutput] = useState(''),
    [busy, setBusy] = useState(false),
    [accountConnected, setAccountConnected] = useState<boolean | null>(null)
  useEffect(() => {
    void run({ type: 'codexStatus' }).then((r) => {
      if (r.ok) setAccountConnected(r.text === 'connected')
    })
  }, [run])
  const patch = (v: Partial<Config>) => setC((o) => ({ ...o, ...v }))
  async function save() {
    const r = await run({ type: 'config', config: c, ...(key.trim() ? { key } : {}) })
    if (r.ok) setKey('')
    return r.ok
  }
  async function test() {
    setBusy(true)
    try {
      if (await save()) {
        const r = await run({ type: 'testConnection' })
        setOutput(r.ok ? r.text || r.message || t('完成') : r.error)
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={t('连接与偏好设置')}
      subtitle={t('第一版只接入 ChatGPT 与 RunningHub。所有密钥仅保存在本机。')}
      wide
      onClose={onClose}
    >
      <div className="modal-body settings-body">
        <section>
          <h3>
            <KeyRound size={17} /> {t('ChatGPT 账号 · 文字与图片')}
          </h3>
          <div className="row-between">
            <div>
              <strong>
                {accountConnected === null
                  ? t('正在检查账号…')
                  : accountConnected
                    ? t('ChatGPT 账号已连接')
                    : t('需要连接 ChatGPT 账号')}
              </strong>
              <p className="small muted">
                {t('授权一次后，文字回复和生成图片都会直接保存到软件。')}
              </p>
            </div>
            <Button
              disabled={busy || accountConnected !== false}
              onClick={async () => {
                setBusy(true)
                try {
                  const r = await run({ type: 'codexLogin' })
                  if (r.ok) {
                    setAccountConnected(true)
                    window.dispatchEvent(new Event('director:codex-login'))
                  }
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? t('等待账号授权…') : accountConnected ? t('已连接') : t('连接账号')}
            </Button>
          </div>
        </section>
        <section>
          <h3>
            <KeyRound size={17} /> {t('RunningHub 工作流')}
          </h3>
          <p className="small muted">{t('已内置指定工作流，使用 RunningHub 中国站。只接受消耗 RH币的消费级会员 Key，不使用钱包余额。')}</p>
          <p className="small muted break">{t('工作流：')}{videoWorkflow.id}</p>
          <Field label={t('视频生成模式')}>
            <select
              value={c.instanceType}
              onChange={(e) => patch({ instanceType: e.target.value as Config['instanceType'] })}
            >
              <option value="plus">{t('Plus（48 GB 显存）')}</option>
              <option value="default">{t('Standard（24 GB 显存）')}</option>
            </select>
          </Field>
          <Field
            label={`API Key ${state.hasKey ? t('· 已安全保存') : ''}`}
            hint={t('请填写消费级会员 Key。留空保留原 Key；Key 不回传到界面，不进入 ZIP 存档。')}
          >
            <input
              type="password"
              autoComplete="new-password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                state.hasKey ? t('已绑定；输入新 Key 可替换') : t('粘贴你自己的 RunningHub API Key')
              }
            />
          </Field>
          <div className="field-row">
            <Button disabled={busy} onClick={() => void test()}>
              {t('测试连接')}
            </Button>
            {state.hasKey && (
              <Button onClick={() => void run({ type: 'clearKey' })}>{t('解绑 Key')}</Button>
            )}
          </div>
          {output && <pre className="api-output">{output}</pre>}
          <Field label={t('同时运行的视频任务')}>
            <p className="small muted">{t('RH币模式一次运行 1 个视频任务，后续镜头依次提交。')}</p>
          </Field>
        </section>
        <section>
          <h3>
            <Film size={17} /> {t('导出与外观')}
          </h3>
          <Field label={t('界面主题')}>
            <select
              value={c.theme}
              onChange={(e) => patch({ theme: e.target.value as Config['theme'] })}
            >
              <option value="light">{t('浅色 · Warm paper')}</option>
              <option value="dark">{t('深色 · Graphite')}</option>
            </select>
          </Field>
          <Field label={t('界面语言')}>
            <select
              value={c.locale}
              onChange={(e) => patch({ locale: e.target.value as Config['locale'] })}
            >
              <option value="zh">简体中文</option>
              <option value="en">English</option>
            </select>
          </Field>
          <p className="small muted break">
            {t('本地资料库：')}
            {state.dataPath}
          </p>
        </section>
      </div>
      <div className="modal-footer">
        <Button onClick={onClose}>{t('关闭')}</Button>
        <Button
          primary
          onClick={async () => {
            if (await save()) onClose()
          }}
        >
          {t('保存设置')}
        </Button>
      </div>
    </Modal>
  )
}
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
