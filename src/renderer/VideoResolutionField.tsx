import { type Project, type VideoResolution, videoResolutionSchema, videoSizes } from '../shared/schema'
import { useT } from './i18n'
import { Field } from './ui'

export function VideoResolutionField({ value, onChange, ready, disabled = false, aspect }: {
  value: VideoResolution
  onChange: (value: VideoResolution) => void
  ready: boolean
  disabled?: boolean
  aspect?: Project['aspect']
}) {
  const t = useT()
  return <Field label={t('视频清晰度')} hint={!ready
    ? t('当前开发进程尚不支持清晰度设置，请在现有任务结束后重启开发版。')
    : t('仅用于后续新建任务；高清增加计算量，可能延长生成时间并提高费用。')}>
    <select value={value} disabled={!ready || disabled}
      onChange={(event) => onChange(videoResolutionSchema.parse(event.target.value))}>
      {videoResolutionSchema.options.map((quality) => <option key={quality} value={quality}>
        {t(quality === '768p' ? '高清（768p 档）' : '标准（480p 档）')}
        {aspect && ` · ${videoSizes[quality][aspect].join('×')}`}
      </option>)}
    </select>
  </Field>
}
