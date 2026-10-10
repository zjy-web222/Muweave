import { useEffect, useState } from 'react'
import { Film, KeyRound } from 'lucide-react'
import { type Command, type Config, videoWorkflow } from '../shared/schema'
import {
  credentialId,
  defaultModel,
  modelPresets,
  modelProviders,
  providerNames,
  type ModelChannel,
  type ModelSelection,
} from '../shared/models'
import { Button, Field, Modal, useWorkspace } from './ui'
import { useT } from './i18n'

const labels = { text: '文字模型', image: '图片模型', video: '视频模型' } as const
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useT(),
    { state, run } = useWorkspace()
  const [config, setConfig] = useState<Config>(() => structuredClone(state.config))
  const [channel, setChannel] = useState<ModelChannel>('text')
  const [draftKeys, setDraftKeys] = useState<
    Record<
      string,
      { channel: ModelChannel; selection: ModelSelection; key: string; secret?: string }
    >
  >({})
  const [runninghubKey, setRunninghubKey] = useState('')
  const [output, setOutput] = useState('')
  const [busy, setBusy] = useState(false)
  const [accountConnected, setAccountConnected] = useState<boolean | null>(null)
  const selected = config.models[channel],
    selectedId = credentialId(channel, selected)
  const saved = selected.provider === 'runninghub' ? state.hasKey : !!state.credentials[selectedId]
  const draft = draftKeys[selectedId]
  const patch = (value: Partial<Config>) => setConfig((c) => ({ ...c, ...value }))
  const select = (value: ModelSelection) => {
    setConfig((c) => ({ ...c, models: { ...c.models, [channel]: value } }))
    setOutput('')
  }
  const patchKey = (value: { key?: string; secret?: string }) =>
    setDraftKeys((keys) => ({
      ...keys,
      [selectedId]: {
        ...keys[selectedId],
        channel,
        selection: structuredClone(selected),
        key: keys[selectedId]?.key || '',
        ...value,
      },
    }))
  useEffect(() => {
    void run({ type: 'codexStatus' }).then((r) => {
      if (r.ok) setAccountConnected(r.text === 'connected')
    })
  }, [run])
  async function save() {
    if (!state.modelServicesReady) {
      setOutput(t('新版模型服务需要重启开发版。请等待当前生成任务完成后重启。'))
      return false
    }
    const credentials = Object.values(draftKeys).filter((item) => item.key.trim())
    if (Object.values(draftKeys).some((item) => item.secret?.trim() && !item.key.trim())) {
      setOutput(t('替换可灵凭据时请同时填写 Access Key 和 Secret Key。'))
      return false
    }
    const r = await run({
      type: 'config',
      config,
      credentials,
      ...(runninghubKey.trim() ? { key: runninghubKey } : {}),
    })
    if (r.ok) {
      setDraftKeys({})
      setRunninghubKey('')
      window.dispatchEvent(new Event('director:codex-login'))
    }
    return r.ok
  }
  async function test() {
    setBusy(true)
    try {
      if (await save()) {
        const command: Command =
          selected.provider === 'runninghub'
            ? { type: 'testConnection' }
            : { type: 'testModelConnection', channel }
        const r = await run(command)
        setOutput(r.ok ? r.text || r.message || t('完成') : r.error)
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={t('连接与偏好设置')}
      subtitle={t('文字、图片、视频独立选择服务与授权。密钥仅加密保存在本机。')}
      wide
      onClose={onClose}
    >
      <div className="modal-body settings-body">
        <div className="model-tabs" role="tablist" aria-label={t('生成服务')}>
          {(['text', 'image', 'video'] as const).map((item) => (
            <button
              key={item}
              role="tab"
              aria-selected={channel === item}
              aria-controls="model-settings-panel"
              onClick={() => {
                setChannel(item)
                setOutput('')
              }}
            >
              {t(labels[item])}
            </button>
          ))}
        </div>
        <section id="model-settings-panel" role="tabpanel" aria-label={t(labels[channel])}>
          {!state.modelServicesReady && (
            <p className="notice" role="status">
              {t('新版模型服务需要重启开发版。请等待当前生成任务完成后重启。')}
            </p>
          )}
          <h3>
            <KeyRound size={17} />
            {t(labels[channel])}
            <span className="small muted">{t('独立授权')}</span>
          </h3>
          <Field label={t('服务商')}>
            <select
              value={selected.provider}
              disabled={busy}
              onChange={(e) =>
                select(defaultModel(channel, e.target.value as ModelSelection['provider']))
              }
            >
              {modelProviders[channel].map((provider) => (
                <option key={provider} value={provider}>
                  {t(providerNames[provider])}
                  {provider === 'chatgpt' ? t(' · 账号登录') : ''}
                </option>
              ))}
            </select>
          </Field>
          {selected.provider === 'chatgpt' ? (
            <>
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
                    {t(
                      '此通道使用 ChatGPT 账号。文字与图片可以分别选择不同服务，API Key 不会互相复用。',
                    )}
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
            </>
          ) : (
            <>
              {selected.provider === 'runninghub' ? (
                <>
                  <p className="small muted">
                    {t(
                      '已内置指定工作流，使用 RunningHub 中国站。只接受消耗 RH币的消费级会员 Key，不使用钱包余额。',
                    )}
                  </p>
                  <p className="small muted">
                    {t('工作流：')}
                    {videoWorkflow.id}
                  </p>
                  <Field label={t('视频生成模式')}>
                    <select
                      value={config.instanceType}
                      onChange={(e) =>
                        patch({ instanceType: e.target.value as Config['instanceType'] })
                      }
                    >
                      <option value="plus">{t('Plus（48 GB 显存）')}</option>
                      <option value="default">{t('Standard（24 GB 显存）')}</option>
                    </select>
                  </Field>
                </>
              ) : (
                <>
                  <Field
                    label={t('模型 ID')}
                    hint={t('可选择常用模型；文字与图片也可输入同接口支持的模型 ID。')}
                  >
                    {channel === 'video' ||
                    (channel === 'image' && ['qwen', 'bfl', 'glm'].includes(selected.provider)) ? (
                      <select
                        value={selected.model}
                        onChange={(e) => select({ ...selected, model: e.target.value })}
                      >
                        {(modelPresets[channel][selected.provider] || []).map((model) => (
                          <option key={model}>{model}</option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <input
                          value={selected.model}
                          list="model-presets"
                          maxLength={150}
                          onChange={(e) => select({ ...selected, model: e.target.value })}
                        />
                        <datalist id="model-presets">
                          {(modelPresets[channel][selected.provider] || []).map((model) => (
                            <option key={model} value={model} />
                          ))}
                        </datalist>
                      </>
                    )}
                  </Field>
                  {['qwen', 'minimax', 'kling', 'kimi', 'glm', 'stepfun'].includes(selected.provider) && (
                    <Field
                      label={t('服务区域')}
                      hint={t('区域对应独立的官方接口和 Key，切换区域后请填写对应凭据。')}
                    >
                      <select
                        value={selected.region}
                        onChange={(e) =>
                          select({
                            ...selected,
                            region: e.target.value as ModelSelection['region'],
                          })
                        }
                      >
                        <option value="cn">{t('中国大陆')}</option>
                        <option value="global">{t('海外 / 国际')}</option>
                      </select>
                    </Field>
                  )}
                  <p className="small muted">
                    {t('API 按服务商账户计费；ChatGPT 订阅不等于 OpenAI API 额度。')}
                  </p>
                </>
              )}
              <Field
                label={`${selected.provider === 'kling' ? 'API Key / Access Key' : 'API Key'} ${saved ? t('· 已安全保存') : ''}`}
                hint={t('留空保留已保存的 Key；密钥不回传界面、不进入项目 ZIP。')}
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  value={selected.provider === 'runninghub' ? runninghubKey : draft?.key || ''}
                  onChange={(e) =>
                    selected.provider === 'runninghub'
                      ? setRunninghubKey(e.target.value)
                      : patchKey({ key: e.target.value })
                  }
                  placeholder={saved ? t('已绑定；输入新 Key 可替换') : t('填写此通道的 API Key')}
                />
              </Field>
              {selected.provider === 'kling' && (
                <Field
                  label="Secret Key"
                  hint={t('使用新版 API Key 时留空；使用旧版 Access Key 时同时填写 Secret Key。')}
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={draft?.secret || ''}
                    onChange={(e) => patchKey({ secret: e.target.value })}
                  />
                </Field>
              )}
              <div className="field-row">
                <Button disabled={busy} onClick={() => void test()}>
                  {busy ? t('正在检查…') : t('检查连接')}
                </Button>
                {saved && (
                  <Button
                    disabled={busy}
                    onClick={async () => {
                      const reply = await run(
                        selected.provider === 'runninghub'
                          ? { type: 'clearKey' }
                          : { type: 'clearModelKey', channel, selection: selected },
                      )
                      if (reply.ok) {
                        setRunninghubKey('')
                        setDraftKeys((keys) => {
                          const next = { ...keys }
                          delete next[selectedId]
                          return next
                        })
                        setOutput('')
                      }
                    }}
                  >
                    {t('解绑 Key')}
                  </Button>
                )}
              </div>
            </>
          )}
          {channel === 'video' && (
            <div className="model-capabilities small muted">
              <p>{t('所有视频任务按分集与镜头顺序串行提交，同场景继承上一镜头实际尾帧。')}</p>
              <p>
                {t(
                  selected.provider === 'runninghub'
                    ? 'RunningHub：多参考图和上一镜头音视频参考，适合人物、环境与音色连续。'
                    : selected.provider === 'kling'
                      ? '可灵：首尾帧控制，2.6 支持原生声音；此接入不继承上一镜头音轨或多参考图。'
                      : selected.provider === 'doubao'
                        ? 'Seedance：首尾帧控制与原生声音，当前接入支持 4–15 秒；尾帧需要同时提供首帧。此接入不继承上一镜头音轨或多参考图。'
                      : selected.provider === 'xai'
                        ? 'Grok Imagine：首尾帧或独立尾帧控制，当前接入支持 4–15 秒。此接入不继承上一镜头音轨或多参考图。'
                      : '海螺：首帧控制，6 / 10 秒，输出无对白音轨；配音请导入镜头音频。此接入不支持多参考图、尾帧或音色继承。',
                )}
              </p>
            </div>
          )}
          {output && (
            <pre className="api-output" role="status">
              {t(output)}
            </pre>
          )}
        </section>
        <section>
          <h3>
            <Film size={17} />
            {t('导出与外观')}
          </h3>
          <div className="model-appearance">
            <Field label={t('界面主题')}>
              <select
                value={config.theme}
                onChange={(e) => patch({ theme: e.target.value as Config['theme'] })}
              >
                <option value="light">{t('浅色 · Warm paper')}</option>
                <option value="dark">{t('深色 · Graphite')}</option>
              </select>
            </Field>
            <Field label={t('界面语言')}>
              <select
                value={config.locale}
                onChange={(e) => patch({ locale: e.target.value as Config['locale'] })}
              >
                <option value="zh">简体中文</option>
                <option value="en">English</option>
              </select>
            </Field>
          </div>
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
          disabled={busy || !state.modelServicesReady}
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
