import { useT } from './i18n'
import { useEffect, useState } from 'react'
import {
  Plus,
  Trash2,
  Copy,
  ArrowUpRight,
  KeyRound,
  ShieldCheck,
  FolderArchive,
  FileText,
  Film,
  Braces,
  CheckCircle2,
} from 'lucide-react'
import { type Config, type Project, type Shot, type Mapping } from '../shared/schema'
import { buildPrompt, parseDirector } from '../shared/director'
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
  kind: 'script' | 'assets' | 'storyboard' | 'image'
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
          ? t('使用你自己的浏览器登录会话；本应用不索取 ChatGPT 密码。')
          : t('连接 ChatGPT 账号后，文字结果可直接返回软件。')
      }
      onClose={onClose}
      wide
    >
      <div className="flow-steps">
        <button className={step === 'prompt' ? 'active' : ''} onClick={() => setStep('prompt')}>
          {t('1 编辑提示词')}
        </button>
        <span>→</span>
        <button className={step === 'result' ? 'active' : ''} onClick={() => setStep('result')}>
          {t('2 导入生成结果')}
        </button>
      </div>
      <div className="modal-body">
        {step === 'prompt' ? (
          <>
            <div className="notice">
              <ShieldCheck size={18} />
              <div>
                {kind === 'image' ? t('浏览器辅助模式') : t('直接生成文字')}
                <p>
                  {kind === 'image'
                    ? t(
                        '提示词会复制到剪贴板，并打开独立 ChatGPT 窗口。请粘贴后发送；遇到验证时由你手动完成。不是官方第三方 OAuth / API 授权。',
                      )
                    : t('点击“在软件中直接生成”即可获得回复；浏览器辅助仍可作为备选方式。')}
                </p>
              </div>
            </div>
            <Field label={t('发送给 ChatGPT 的提示词')}>
              <textarea
                className="prompt-editor"
                rows={14}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </Field>
            {kind === 'image' && (
              <p className="small muted">
                {t(
                  '如需保持人物一致，请在 ChatGPT 同一对话中附加已确认的角色参考图。下载的图片会提示归入当前资产；也可在“素材与版本”中手动导入。',
                )}
              </p>
            )}
          </>
        ) : kind === 'image' ? (
          <div className="notice">
            <FolderArchive size={24} />
            <div>
              {t('下载图片后归档')}
              <p>
                {t(
                  '在 ChatGPT 中下载生成图片，确认归属后会自动建立一个素材版本。若自动下载归档没有触发，请点击下方“导入图片”。',
                )}
              </p>
              <Button
                onClick={() =>
                  void run({
                    type: 'importMedia',
                    projectId: p.id,
                    ownerId: assetId || shot!.id,
                    slot: assetId ? 'reference' : slot,
                  })
                }
              >
                {t('导入图片')}
              </Button>
            </div>
          </div>
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
            <Button
              disabled={generating}
              onClick={async () => {
                const r = await run({
                  type: 'chatgpt',
                  projectId: p.id,
                  ownerId: assetId || shot?.id || episodeId,
                  kind,
                  prompt,
                  slot: assetId ? 'reference' : slot,
                })
                if (r.ok) setStep('result')
              }}
            >
              {t('复制并打开 ChatGPT')}
              <ArrowUpRight size={15} />
            </Button>
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
  const mapping = (index: number, value: Partial<Mapping>) =>
    patch({ mappings: c.mappings.map((m, i) => (i === index ? { ...m, ...value } : m)) })
  async function save() {
    const r = await run({ type: 'config', config: c, ...(key.trim() ? { key } : {}) })
    if (r.ok) setKey('')
    return r.ok
  }
  async function test(type: 'workflow' | 'testConnection') {
    setBusy(true)
    try {
      if (await save()) {
        const r = await run({ type })
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
            <KeyRound size={17} /> {t('ChatGPT 账号 · 文字生成')}
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
                {t('使用 ChatGPT 账号的 Codex 授权，文字对话会直接返回软件。')}
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
            <ArrowUpRight size={17} /> {t('ChatGPT 浏览器 · 图片辅助')}
          </h3>
          <div className="row-between">
            <div>
              <strong>{t('由你本人登录')}</strong>
              <p className="small muted">
                {t('登录状态保存在隔离浏览器中，不读取 Cookie 或账号密码。')}
              </p>
            </div>
            <Button onClick={() => void run({ type: 'openChatGPT' })}>{t('打开 / 登录')}</Button>
          </div>
          <button className="text-button danger" onClick={() => void run({ type: 'clearChatGPT' })}>
            {t('退出并清除本应用登录记录')}
          </button>
        </section>
        <section>
          <h3>
            <KeyRound size={17} /> {t('RunningHub 工作流')}
          </h3>
          <div className="field-row">
            <Field label={t('站点')}>
              <select
                value={c.site}
                onChange={(e) => patch({ site: e.target.value as Config['site'] })}
              >
                <option value="https://www.runninghub.ai">Global · runninghub.ai</option>
                <option value="https://www.runninghub.cn">{t('中国 · runninghub.cn')}</option>
              </select>
            </Field>
            <Field label="Workflow ID">
              <input
                value={c.workflowId}
                onChange={(e) => patch({ workflowId: e.target.value.replace(/\D/g, '') })}
                placeholder={t('复制工作流的数字 ID')}
              />
            </Field>
          </div>
          <Field
            label={`API Key ${state.hasKey ? t('· 已安全保存') : ''}`}
            hint={t('留空保留原 Key。Key 不回传到界面，不进入 ZIP 存档。')}
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
            <Button disabled={busy} onClick={() => void test('testConnection')}>
              {t('测试连接')}
            </Button>
            <Button disabled={busy || !c.workflowId} onClick={() => void test('workflow')}>
              {t('读取工作流节点')}
            </Button>
            {state.hasKey && (
              <Button onClick={() => void run({ type: 'clearKey' })}>{t('解绑 Key')}</Button>
            )}
          </div>
          <div className="section-label">
            <span>{t('参数映射')}</span>
            <Button
              onClick={() =>
                patch({
                  mappings: [
                    ...c.mappings,
                    { nodeId: '', fieldName: '', source: 'prompt', value: '' },
                  ],
                })
              }
            >
              <Plus size={13} />
              {t('添加字段')}
            </Button>
          </div>
          <p className="small muted">
            {t(
              '填入工作流真实的节点 ID 与字段名。例如：提示词 → text，首帧 → image。不会猜测你的节点编号。',
            )}
          </p>
          <div className="mapping-header">
            <span>{t('节点 ID')}</span>
            <span>{t('字段名')}</span>
            <span>{t('镜头数据来源')}</span>
            <span />
          </div>
          {c.mappings.map((m, i) => (
            <div className="mapping-row" key={i}>
              <input
                aria-label={`${t('节点 ID')} ${i + 1}`}
                value={m.nodeId}
                onChange={(e) => mapping(i, { nodeId: e.target.value.replace(/\D/g, '') })}
                placeholder="12"
              />
              <input
                aria-label={`${t('字段名')} ${i + 1}`}
                value={m.fieldName}
                onChange={(e) => mapping(i, { fieldName: e.target.value })}
                placeholder="text"
              />
              <select
                aria-label={`${t('映射来源')} ${i + 1}`}
                value={m.source}
                onChange={(e) => mapping(i, { source: e.target.value as Mapping['source'] })}
              >
                {Object.entries({
                  prompt: t('视频提示词'),
                  first: t('首帧图片'),
                  last: t('尾帧图片'),
                  seed: t('随机种子'),
                  duration: t('时长（秒）'),
                  fixed: t('固定值'),
                }).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                className="icon-button"
                aria-label={`${t('删除映射')} ${i + 1}`}
                onClick={() => patch({ mappings: c.mappings.filter((_, n) => n !== i) })}
              >
                <Trash2 size={14} />
              </button>
              {m.source === 'fixed' && (
                <input
                  className="fixed-value"
                  aria-label={`${t('固定值')} ${i + 1}`}
                  value={m.value}
                  onChange={(e) => mapping(i, { value: e.target.value })}
                  placeholder={t('固定值（按工作流字段格式填写）')}
                />
              )}
            </div>
          ))}
          {output && <pre className="api-output">{output}</pre>}
          <Field label={t('同时运行的视频任务')}>
            <select
              value={c.concurrency}
              onChange={(e) => patch({ concurrency: Number(e.target.value) })}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} {t('个')}
                </option>
              ))}
            </select>
          </Field>
        </section>
        <section>
          <h3>
            <Film size={17} /> {t('导出与外观')}
          </h3>
          <Field
            label={t('FFmpeg 可执行文件')}
            hint={t('若已加入 PATH，填写 ffmpeg 即可。ffprobe 应位于同一目录。')}
          >
            <input value={c.ffmpeg} onChange={(e) => patch({ ffmpeg: e.target.value })} />
          </Field>
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
