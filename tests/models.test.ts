import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import {
  ModelAPI,
  ModelRejectedRequest,
  approvedModelMedia,
  imageBytes,
  klingToken,
} from '../src/main/models'
import { credentialId, defaultModel, defaultModels, modelsSchema } from '../src/shared/models'
import { configSchema, defaultConfig, type Job } from '../src/shared/schema'
import { Store, createProject } from '../src/main/store'
import { importMedia } from '../src/main/media'
import { Queue, RunningHub } from '../src/main/runninghub'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const schema = {
  type: 'object',
  properties: { script: { type: 'string' } },
  required: ['script'],
  additionalProperties: false,
}
afterEach(() => vi.restoreAllMocks())

describe('independent model channels', () => {
  it.each(['kimi', 'glm', 'doubao', 'minimax', 'xai', 'mistral', 'hunyuan', 'ernie', 'stepfun'] as const)(
    'routes %s through its official text endpoint without leaking reasoning or keys', async (provider) => {
      const transport = vi.fn<typeof fetch>(async () => json({
        choices: [{ finish_reason: 'stop', message: { content: '{"script":"ok"}', reasoning_content: 'hidden' } }],
      }))
      const api = new ModelAPI(() => ({ key: 'fixture-secret' }), transport)
      expect(await api.text(defaultModel('text', provider), 'JSON screenplay', schema)).toBe('{"script":"ok"}')
      const [url, init] = transport.mock.calls[0]
      expect(String(url)).toBe({
        kimi: 'https://api.moonshot.cn/v1/chat/completions',
        glm: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        doubao: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
        minimax: 'https://api.minimaxi.com/v1/chat/completions',
        xai: 'https://api.x.ai/v1/chat/completions',
        mistral: 'https://api.mistral.ai/v1/chat/completions',
        hunyuan: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
        ernie: 'https://qianfan.baidubce.com/v2/chat/completions',
        stepfun: 'https://api.stepfun.com/v1/chat/completions',
      }[provider])
      const body = JSON.parse(String(init?.body))
      expect(String(init?.body)).not.toContain('fixture-secret')
      if (['kimi', 'xai', 'mistral', 'minimax'].includes(provider) || provider === 'glm')
        expect(body.thinking).toBeUndefined()
      if (provider === 'minimax') expect(body.reasoning_split).toBe(true)
    },
  )
  it('isolates StepFun regions and rejects unsupported image inputs before submission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'muweave-vision-'))
    const file = join(directory, 'input.png')
    await writeFile(file, Buffer.from(png, 'base64'))
    try {
    const transport = vi.fn<typeof fetch>(async () => json({ choices: [
      { finish_reason: 'stop', message: { content: 'ok' } },
    ] }))
    const credentials = vi.fn(() => ({ key: 'global-key' }))
    const api = new ModelAPI(credentials, transport)
    const selection = { ...defaultModel('text', 'stepfun'), region: 'global' as const }
    await api.text(selection, 'describe', undefined, [file])
    expect(transport.mock.calls[0][0]).toBe('https://api.stepfun.ai/v1/chat/completions')
    expect(credentials).toHaveBeenCalledWith('text', selection)
    transport.mockClear()
    for (const provider of ['hunyuan', 'ernie', 'stepfun'] as const) {
      const selected = defaultModel('text', provider)
      if (provider === 'stepfun') selected.model = 'step-3.5-flash'
      await expect(api.text(selected, 'describe', undefined, [file]))
        .rejects.toThrow('只支持文字')
    }
    expect(transport).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it.each(['glm-image', 'cogview-4-250304'])(
    'downloads %s output without forwarding the API key', async (model) => {
      const transport = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST'
        ? json({ data: [{ url: 'https://sfile.chatglm.cn/result.png' }] })
        : new Response(Buffer.from(png, 'base64')))
      const api = new ModelAPI(() => ({ key: 'fixture-secret' }), transport)
      expect(await api.image({ ...defaultModel('image', 'glm'), model }, 'portrait', '9:16'))
        .toEqual(Buffer.from(png, 'base64'))
      expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).size)
        .toBe(model === 'glm-image' ? '960x1728' : '768x1344')
      expect(transport.mock.calls[1][1]?.headers).toBeUndefined()
      expect(approvedModelMedia(new URL('https://chatglm.cn.attacker.example/result.png'), 'glm')).toBe(false)
    },
  )
  it.each(['doubao', 'xai'] as const)('generates %s images using its own size parameters', async (provider) => {
    const transport = vi.fn<typeof fetch>(async () => json({ data: [{ b64_json: png }] }))
    const api = new ModelAPI(() => ({ key: 'fixture' }), transport)
    expect(await api.image(defaultModel('image', provider), 'portrait', '9:16')).toEqual(Buffer.from(png, 'base64'))
    const body = JSON.parse(String(transport.mock.calls[0][1]?.body))
    expect(body.response_format).toBe('b64_json')
    expect(body).toMatchObject(provider === 'doubao' ? { size: '1440x2560' } : { aspect_ratio: '9:16' })
    expect(body.quality).toBeUndefined()
  })
  it('downloads MiniMax image output without forwarding credentials', async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST'
      ? json({ base_resp: { status_code: 0 }, data: { image_urls: ['https://cdn.minimax.io/image.png'] } })
      : new Response(Buffer.from(png, 'base64')))
    expect(await new ModelAPI(() => ({ key: 'fixture' }), transport).image(defaultModel('image', 'minimax'), 'portrait', '1:1'))
      .toEqual(Buffer.from(png, 'base64'))
    expect(transport.mock.calls[1][1]?.headers).toBeUndefined()
  })
  it('persists and resumes FLUX cluster polling without submitting a second paid task', async () => {
    const query = 'https://api.us1.bfl.ai/v1/get_result?id=flux-task'
    const transport = vi.fn<typeof fetch>(async (url, init) => init?.method === 'POST'
      ? json({ id: 'flux-task', polling_url: query })
      : String(url) === query
        ? json({ status: 'Ready', result: { sample: 'https://delivery.us1.bfl.ai/image.png' } })
        : new Response(Buffer.from(png, 'base64')))
    const save = vi.fn(), api = new ModelAPI(() => ({ key: 'fixture' }), transport)
    await api.image(defaultModel('image', 'bfl'), 'portrait', '9:16', undefined, save)
    expect(save).toHaveBeenCalledWith('flux-task', query)
    await api.image(defaultModel('image', 'bfl'), 'portrait', '9:16', 'flux-task', save, query)
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(new Headers(transport.mock.calls[1][1]?.headers).get('x-key')).toBe('fixture')
    expect(transport.mock.calls[2][1]?.headers).toBeUndefined()
    const before = transport.mock.calls.length
    await expect(api.image(defaultModel('image', 'bfl'), 'portrait', '1:1', 'flux-task', save,
      'https://api.bfl.ai.attacker.test/v1/get_result?id=flux-task')).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(before)
  })
  it.each(['doubao', 'xai'] as const)('submits and queries %s with actual boundary image data', async (provider) => {
    const root = await mkdtemp(join(tmpdir(), 'muweave-boundary-model-'))
    try {
      const file = join(root, 'frame.png')
      await (await import('node:fs/promises')).writeFile(file, Buffer.from(png, 'base64'))
      const transport = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST'
        ? json(provider === 'doubao' ? { id: 'video-task' } : { request_id: 'video-task' })
        : json(provider === 'doubao' ? { status: 'succeeded', content: { video_url: 'https://ark.tos-cn-beijing.volces.com/result.mp4' } }
          : { status: 'done', video: { url: 'https://vidgen.x.ai/result.mp4', respect_moderation: true } }))
      const api = new ModelAPI(() => ({ key: 'fixture' }), transport)
      const job = { model: defaultModel('video', provider), snapshot: { duration: 8 }, aspect: '9:16' } as Job
      job.taskId = await api.startVideo(job, '逐字对白', file, file)
      expect(job.taskId).toBe('video-task')
      const body = JSON.parse(String(transport.mock.calls[0][1]?.body))
      if (provider === 'doubao') {
        expect(body.content.map((part: { role?: string }) => part.role)).toEqual([undefined, 'first_frame', 'last_frame'])
        expect(body.generate_audio).toBe(true)
      } else {
        expect(body.image.url).toBe(`data:image/png;base64,${png}`)
        expect(body.last_frame.url).toBe(`data:image/png;base64,${png}`)
      }
      expect(await api.videoResult(job)).toMatchObject({ status: 'SUCCESS' })
      expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
      if (provider === 'doubao') {
        await expect(api.startVideo(job, '逐字对白', undefined, file)).rejects.toBeInstanceOf(ModelRejectedRequest)
        expect(transport).toHaveBeenCalledTimes(2)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('migrates old configuration and rejects wrong capability/provider combinations', () => {
    const { models: _models, ...old } = defaultConfig
    expect(configSchema.parse(old).models).toEqual(defaultModels)
    expect(
      modelsSchema.safeParse({ ...defaultModels, image: defaultModel('text', 'deepseek') }).success,
    ).toBe(false)
    expect(credentialId('text', defaultModel('text', 'openai'))).not.toBe(
      credentialId('image', defaultModel('image', 'openai')),
    )
  })
  it('uses separate text and image keys even when both choose OpenAI', async () => {
    const calls: RequestInit[] = []
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      calls.push(init!)
      return JSON.parse(String(init?.body)).prompt
        ? json({ data: [{ b64_json: png }] })
        : json({
            status: 'completed',
            output: [
              { type: 'message', content: [{ type: 'output_text', text: '{"script":"ok"}' }] },
            ],
          })
    })
    const api = new ModelAPI((channel) => ({ key: `${channel}-fixture-key` }), transport)
    expect(await api.text(defaultModel('text', 'openai'), 'screenplay', schema)).toBe(
      '{"script":"ok"}',
    )
    expect(await api.image(defaultModel('image', 'openai'), 'portrait', '9:16')).toEqual(
      Buffer.from(png, 'base64'),
    )
    expect(calls.map((init) => new Headers(init.headers).get('Authorization'))).toEqual([
      'Bearer text-fixture-key',
      'Bearer image-fixture-key',
    ])
    expect(JSON.parse(String(calls[0].body))).toMatchObject({
      store: false,
      text: { format: { type: 'json_schema' } },
    })
    expect(JSON.parse(String(calls[1].body))).toMatchObject({ size: '864x1536' })
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain('fixture-key')
  })
  it.each(['deepseek', 'qwen', 'claude', 'gemini'] as const)(
    'routes %s text through its official protocol',
    async (provider) => {
      const transport = vi.fn<typeof fetch>(async () =>
        provider === 'claude'
          ? json({ content: [{ type: 'text', text: '{"script":"ok"}' }], stop_reason: 'end_turn' })
          : provider === 'gemini'
            ? json({
                status: 'completed',
                steps: [
                  { type: 'model_thought', content: [{ type: 'text', text: 'hidden' }] },
                  { type: 'model_output', content: [{ type: 'text', text: '{"script":"ok"}' }] },
                ],
              })
            : json({
                choices: [{ finish_reason: 'stop', message: { content: '{"script":"ok"}' } }],
              }),
      )
      const api = new ModelAPI(() => ({ key: 'fixture-secret' }), transport)
      expect(await api.text(defaultModel('text', provider), 'JSON screenplay', schema)).toBe(
        '{"script":"ok"}',
      )
      const [url, init] = transport.mock.calls[0]
      expect(String(url)).toContain(
        {
          deepseek: 'api.deepseek.com',
          qwen: 'dashscope.aliyuncs.com',
          claude: 'api.anthropic.com',
          gemini: 'generativelanguage.googleapis.com',
        }[provider],
      )
      expect(init?.redirect).toBe('error')
      expect(transport).toHaveBeenCalledTimes(1)
    },
  )
  it('does not expose provider error bodies or automatically retry paid requests', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      json({ error: { message: 'fixture-secret https://bad.example/?token=secret' } }, 401),
    )
    const api = new ModelAPI(() => ({ key: 'fixture-secret' }), transport)
    await expect(api.image(defaultModel('image', 'openai'), 'image', '16:9')).rejects.toThrow(
      ModelRejectedRequest,
    )
    await expect(api.text(defaultModel('text', 'openai'), 'text')).rejects.not.toThrow(
      'fixture-secret',
    )
    expect(transport).toHaveBeenCalledTimes(2)
    transport.mockRejectedValue(new Error('network error with fixture-secret'))
    await expect(api.image(defaultModel('image', 'openai'), 'image', '1:1')).rejects.toThrow(
      '提交结果未知',
    )
    expect(transport).toHaveBeenCalledTimes(3)
  })
  it('rejects invalid raster results and media hosts, including deceptive suffixes', () => {
    expect(() => imageBytes(Buffer.from('<svg><script/></svg>').toString('base64'))).toThrow('不是')
    expect(approvedModelMedia(new URL('https://filecdn.minimax.io/result.mp4'), 'minimax')).toBe(
      true,
    )
    expect(
      approvedModelMedia(new URL('https://minimax.io.attacker.example/result.mp4'), 'minimax'),
    ).toBe(false)
    expect(approvedModelMedia(new URL('http://127.0.0.1/result.mp4'), 'kling')).toBe(false)
  })
  it('downloads a completed Wan image with no credentials on CDN requests and resumes by original task ID', async () => {
    const transport = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('/tasks/')
        ? json({
            output: {
              task_id: 'wan-id',
              task_status: 'SUCCEEDED',
              results: [{ url: 'https://output.oss-cn-beijing.aliyuncs.com/image.png' }],
            },
          })
        : String(url).includes('image-synthesis')
          ? json({ output: { task_id: 'wan-id', task_status: 'PENDING' } })
          : new Response(Buffer.from(png, 'base64')),
    )
    const api = new ModelAPI(() => ({ key: 'fixture-secret' }), transport),
      save = vi.fn()
    expect(
      await api.image(defaultModel('image', 'qwen'), 'portrait', '16:9', undefined, save),
    ).toEqual(Buffer.from(png, 'base64'))
    expect(save).toHaveBeenCalledWith('wan-id')
    expect(new Headers(transport.mock.calls[2][1]?.headers).has('Authorization')).toBe(false)
    transport.mockClear()
    await api.image(defaultModel('image', 'qwen'), 'portrait', '16:9', 'wan-id', save)
    expect(transport.mock.calls.every(([, init]) => !init?.body)).toBe(true)
  })
  it('reads Gemini final image output and ignores thought images', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      json({
        status: 'completed',
        steps: [
          { type: 'model_thought', content: [{ type: 'image', data: 'invalid' }] },
          { type: 'model_output', content: [{ type: 'image', data: png, mime_type: 'image/png' }] },
        ],
      }),
    )
    const api = new ModelAPI(() => ({ key: 'fixture' }), transport)
    expect(await api.image(defaultModel('image', 'gemini'), 'image', '9:16')).toEqual(
      Buffer.from(png, 'base64'),
    )
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toMatchObject({
      store: false,
      response_format: { aspect_ratio: '9:16' },
    })
  })
  it('signs legacy Kling credentials locally and also accepts current API keys', () => {
    const token = klingToken({ key: 'access', secret: 'secret' }, 100),
      [head, payload, signature] = token.split('.')
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      iss: 'access',
      exp: 1900,
      nbf: 95,
    })
    expect(signature).toBe(
      createHmac('sha256', 'secret').update(`${head}.${payload}`).digest('base64url'),
    )
    expect(klingToken({ key: 'current-key' })).toBe('current-key')
  })
  it('submits and queries Kling and MiniMax using durable task IDs', async () => {
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('klingai'))
        return json({
          code: 0,
          data: init?.body
            ? { task_id: 'kling-task' }
            : {
                task_status: 'succeed',
                task_result: { videos: [{ url: 'https://v2.klingai.com/result.mp4' }] },
              },
        })
      if (init?.body) return json({ task_id: 'minimax-task', base_resp: { status_code: 0 } })
      if (String(url).includes('files/retrieve'))
        return json({
          file: { download_url: 'https://video-product.cdn.minimax.io/result.mp4' },
          base_resp: { status_code: 0 },
        })
      return json({ status: 'Success', file_id: 'file-id', base_resp: { status_code: 0 } })
    })
    const api = new ModelAPI(() => ({ key: 'fixture' }), transport)
    for (const provider of ['kling', 'minimax'] as const) {
      const job = {
        id: 'local-job',
        snapshot: { duration: 6 },
        aspect: '9:16',
        remoteKind: 'text2video',
        model: defaultModel('video', provider),
      } as Job
      job.taskId = await api.startVideo(job, 'exact dialogue')
      expect(job.taskId).toBe(`${provider}-task`)
      expect(await api.videoResult(job)).toMatchObject({
        status: 'SUCCESS',
        urls: [expect.stringContaining('https://')],
      })
    }
    expect(transport.mock.calls.filter(([, init]) => init?.body)).toHaveLength(2)
    expect(transport.mock.calls.filter(([url]) => String(url).includes('klingai'))[0][0]).toBe(
      'https://api-beijing.klingai.com/v1/videos/text2video',
    )
  })
})

describe('model selection persisted with queued work', () => {
  it.each(['qwen', 'bfl'] as const)('preserves %s selection and resumes existing asynchronous image queries after restart', async (provider) => {
    const root = await mkdtemp(join(tmpdir(), 'muweave-model-queue-')),
      store = new Store(root)
    const queue = new Queue(store, new RunningHub(() => ''), () => {})
    try {
      const p = store.save(createProject('models', '16:9', true))
      const config = {
        ...store.config(),
        models: { ...defaultModels, image: defaultModel('image', provider) },
        paused: true,
      }
      store.set('config', config)
      const id = queue.enqueueAI(
        { type: 'generateImage', projectId: p.id, ownerId: p.assets[0].id, slot: 'reference' },
        'image',
      )
      const task = store.aiTask(id)
      task.status = 'running'
      task.remoteTaskId = 'saved-remote-id'
      if (provider === 'bfl') task.remoteQueryUrl = 'https://api.us1.bfl.ai/v1/get_result?id=saved-remote-id'
      store.saveJob(task)
      store.set('config', { ...config, models: defaultModels })
      queue.start()
      expect(store.aiTask(id)).toMatchObject({
        status: 'queued',
        remoteTaskId: 'saved-remote-id',
        model: { provider },
      })
      if (provider === 'bfl') expect(store.aiTask(id).remoteQueryUrl).toBe(task.remoteQueryUrl)
    } finally {
      queue.stop()
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('prepares the actual predecessor last frame for a new video provider without reordering or resubmission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muweave-provider-video-')),
      store = new Store(root)
    const api = new ModelAPI(() => ({ key: 'fixture' }))
    const submit = vi.spyOn(api, 'startVideo').mockImplementation(async (job, prompt, first) => {
      expect(job.model?.provider).toBe('minimax')
      expect(job.remoteKind).toBe('image2video')
      expect(prompt).toContain('上一镜头实际尾帧')
      expect((await readFile(first!)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      throw new Error('提交结果未知')
    })
    const queue = new Queue(store, new RunningHub(() => ''), () => {}, undefined, api)
    try {
      const p = store.save(createProject('continuity', '9:16', true)),
        first = p.shots[0],
        next = p.shots[1]
      next.scene = first.scene
      store.save(p)
      const file = join(root, 'prior.mp4')
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'color=c=green:s=320x180:r=24',
          '-t',
          '0.3',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          file,
        ],
        { windowsHide: true },
      )
      await importMedia(store, p.id, first.id, 'video', file)
      store.set('config', {
        ...store.config(),
        models: { ...defaultModels, video: defaultModel('video', 'minimax') },
      })
      queue.enqueue(p.id, [next.id], false)
      store.set('config', { ...store.config(), models: defaultModels })
      await vi.waitFor(() => expect(store.jobs()[0].status).toBe('uncertain'), { timeout: 15000 })
      expect(store.jobs()[0]).toMatchObject({
        previousShotId: first.id,
        model: { provider: 'minimax' },
      })
      expect(submit).toHaveBeenCalledTimes(1)
      await expect(queue.action(store.jobs()[0].id, 'retry')).rejects.toThrow('待确认任务')
    } finally {
      queue.stop()
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 20000)
})
