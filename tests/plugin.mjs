import { _electron as electron, chromium } from 'playwright'
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { request as httpRequest } from 'node:http'
import assert from 'node:assert/strict'

const data = await mkdtemp(join(tmpdir(), 'muweave-plugin-'))
const evidence = resolve('test-results')
await mkdir(evidence, { recursive: true })
const env = { ...process.env, DIRECTOR_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.', '--plugin-server'], cwd: process.cwd(), env })
let browser, sidecar
const errors = []
try {
  let connection
  for (let i = 0; i < 100 && !connection; i++) {
    try { connection = JSON.parse(await readFile(join(data, 'studio-connection.json'), 'utf8')) }
    catch { await new Promise((done) => setTimeout(done, 100)) }
  }
  assert(connection, 'Plugin runtime did not start')
  assert.equal((await app.windows()).length, 0, 'Headless plugin must not open a desktop window')
  const base = connection.base
  const post = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() }
  }
  const rpc = async (method, params = {}) => {
    const { status, body } = await post('rpc', { message: { jsonrpc: '2.0', id: 1, method, params }, workspaceRoot: data })
    assert.equal(status, 200)
    return body
  }
  const tool = async (name, args) => {
    const reply = await rpc('tools/call', { name: `muweave_${name}`, arguments: args })
    assert(!reply.error, reply.error?.message)
    assert(!reply.result.isError, reply.result.content?.[0]?.text)
    return reply.result.structuredContent
  }
  assert.equal((await fetch(base.replace(/\/s\/.+\/$/, '/s/wrong/health'))).status, 401)
  const wrongHost = await new Promise((done, reject) => {
    const request = httpRequest(base + 'health', { headers: { Host: 'evil.example' } }, (response) => {
      response.resume(); done(response.statusCode)
    })
    request.on('error', reject); request.end()
  })
  assert.equal(wrongHost, 403)
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18' })).result.protocolVersion, '2025-06-18')
  const catalog = (await rpc('tools/list')).result.tools
  assert.equal(catalog.length, 6)
  assert.equal(catalog.find((t) => t.name === 'muweave_studio_info')._meta.ui.resourceUri, 'ui://muweave/studio')
  assert(!(await rpc('tools/call', { name: 'muweave_edit', arguments: { command: { type: 'clearKey' } } })).result)

  await tool('edit', { command: { type: 'create', title: '插件验证 · 连续场景', aspect: '16:9', demo: true } })
  const project = (await tool('read', {})).projects[0]
  let full = (await tool('read', { projectId: project.id })).project
  const episodeId = full.episodes[0].id, shotId = full.shots[0].id
  const refused = await rpc('tools/call', { name: 'muweave_generate', arguments: {
    command: { type: 'queue', projectId: project.id, shotIds: [shotId] },
  } })
  assert.match(refused.error.message, /confirmed:true/)
  assert.equal((await tool('read', {})).jobs.length, 0)
  const stopRefused = await rpc('tools/call', { name: 'muweave_generate', arguments: { command: { type: 'terminateTasks' } } })
  assert.match(stopRefused.error.message, /confirmed:true/)
  await tool('edit', { command: { type: 'batchShots', projectId: project.id, episodeId,
    shotIds: full.shots.slice(1).map((shot) => shot.id), patch: { lighting: '插件批量光线' } } })
  full = (await tool('read', { projectId: project.id })).project
  assert(full.shots.slice(1).every((shot) => shot.lighting === '插件批量光线'))

  process.env.DIRECTOR_DATA_DIR = data
  const serviceModule = await import('../src/plugin/service/muweave.mjs')
  const service = await serviceModule.default({ workspace: { root: data } })
  assert.equal((await service.actions.read({})).projects[0].id, project.id)
  await assert.rejects(service.actions.import({ command: { type: 'importSource', projectId: project.id, episodeId }, paths: ['../outside.txt'] }), /路径|越界|relative|relative path/i)
  await assert.rejects(service.actions.import({ command: { type: 'importSource', projectId: project.id, episodeId }, paths: [resolve('README.md')] }), /相对路径/)
  // Feed actual local media through the same import/export pipeline as the desktop.
  const video = join(data, 'sample.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=24',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { windowsHide: true })
  await service.actions.import({ command: { type: 'importMedia', projectId: project.id, ownerId: shotId, slot: 'video' }, paths: ['sample.mp4'] })
  full = (await tool('read', { projectId: project.id })).project
  const mediaId = full.media.find((m) => m.ownerId === shotId && m.slot === 'video').id
  const media = await fetch(`${base}media/asset/${project.id}/${mediaId}`, { headers: { Range: 'bytes=0-100' } })
  assert.equal(media.status, 206)
  assert.equal((await media.arrayBuffer()).byteLength, 101)
  const exported = await tool('export', { command: { type: 'exportArchive', projectId: project.id } })
  assert.equal((await fetch(exported.download)).status, 200)
  assert((await stat(join(data, 'library', 'projects', project.id, 'exports'))).isDirectory())

  sidecar = spawn(process.execPath, ['src/plugin/service/muweave.mjs'], { cwd: process.cwd(), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: sidecar.stdout })
  const pending = new Map()
  lines.on('line', (line) => { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id) })
  const stdioCall = (id, method, params) => new Promise((resolveReply, reject) => {
    const timer = setTimeout(() => reject(new Error(`stdio timeout: ${method}`)), 10000)
    pending.set(id, (reply) => { clearTimeout(timer); resolveReply(reply) })
    sidecar.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  assert.equal((await stdioCall(2, 'initialize', { protocolVersion: '2025-11-25' })).result.serverInfo.name, 'muweave')
  assert.equal((await stdioCall(3, 'tools/list', {})).result.tools.length, 6)
  assert.equal((await stdioCall(4, 'tools/call', { name: 'muweave_read', arguments: {} })).result.structuredContent.projects[0].id, project.id)

  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const page = await context.newPage()
  const failedRequests = []
  page.on('response', response => {
    if (response.status() >= 400) failedRequests.push({ status: response.status(),
      path: new URL(response.url()).pathname.replace(/\/s\/[^/]+/, '/s/[session]') })
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(base)
  await page.locator('.shot-list article').first().waitFor()
  await page.locator('.brand-mark img').evaluate((image) => image.decode())
  await page.screenshot({ path: join(evidence, 'plugin-01-studio.png') })
  await page.getByRole('button', { name: '3D 预演', exact: true }).click()
  const previs = page.getByRole('region', { name: '3D 预演台', exact: true })
  await previs.locator('canvas').waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.previs button')].some((button) => button.textContent.includes('导出构图图') && !button.disabled))
  await previs.getByRole('button', { name: '导出构图图', exact: true }).click()
  await page.getByText('构图图已保存到镜头素材', { exact: true }).waitFor()
  await page.screenshot({ path: join(evidence, 'plugin-01-previs.png') })
  await page.setViewportSize({ width: 640, height: 900 })
  await page.screenshot({ path: join(evidence, 'plugin-01-previs-640.png') })
  assert(await previs.evaluate((element) => element.scrollWidth <= element.clientWidth))
  await page.setViewportSize({ width: 1440, height: 950 })
  await page.getByRole('button', { name: '列表', exact: true }).click()
  await page.getByRole('button', { name: /^剧本(?: 01)?$/ }).click()
  await page.getByLabel('剧本正文').fill('插件测试：人物从河岸连续走到桥下。')
  await page.getByRole('button', { name: '保存剧本', exact: true }).click()
  await page.getByRole('button', { name: '已保存', exact: true }).waitFor()
  const saved = (await tool('read', { projectId: project.id })).project
  assert.match(saved.episodes[0].script, /插件测试/)
  assert(saved.scriptArchives.length > 0, 'Old script and video-linked shots must be archived')
  await page.getByRole('button', { name: '资产库 02' }).click()
  const filePicker = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传资产图片', exact: true }).click()
  await page.getByRole('button', { name: '选择图片上传', exact: true }).click()
  await (await filePicker).setFiles(resolve('src/renderer/assets/muweave-mark.png'))
  await page.getByText('资产图片已上传', { exact: true }).waitFor()
  assert((await tool('read', { projectId: project.id })).project.assets.some((a) => a.selectedMediaId))

  // Replace only the external Codex process: the actual Studio, command handler,
  // image decoder, SQLite import and media route remain under test.
  await app.evaluate(() => {
    const cp = process.getBuiltinModule('child_process')
    const { syncBuiltinESMExports } = process.getBuiltinModule('module')
    const { EventEmitter } = process.getBuiltinModule('events')
    const { PassThrough, Writable } = process.getBuiltinModule('stream')
    const generation = { deferred: true, starts: 0, kills: 0, finish: null, events: [], prompts: [], emptyPolish: false }
    globalThis.imageGenerationTest = generation
    const original = cp.spawn
    cp.spawn = (file, args, options) => {
      if (!String(file).endsWith('codex.exe')) return original(file, args, options)
      const child = Object.assign(new EventEmitter(), { stdout:new PassThrough(), stderr:new PassThrough(), exitCode:null })
      child.kill = () => {
        if (args[0] === 'app-server') generation.kills++
        child.exitCode=0; child.emit('close',0); return true
      }
      if (args[0] === 'exec') {
        let prompt = ''
        child.stdin = new Writable({
          write(chunk, _encoding, done) { prompt += String(chunk); done() },
          final(done) {
            const schemaPath = args[args.indexOf('--output-schema') + 1]
            const schema = JSON.parse(process.getBuiltinModule('fs').readFileSync(schemaPath, 'utf8'))
            const chat = !!schema.properties.reply
            const polish = chat && prompt.includes('本轮是用户选择的剧本润色')
            generation.starts++
            generation.events.push(chat ? 'chat' : 'storyboard')
            generation.prompts.push(prompt)
            const finish = (succeeded = true) => {
              generation.finish = null
              const result = chat
                ? { reply: polish ? '润色编剧回复' : '队列编剧回复', analysis: '保留人物与场景的创作摘要。',
                    script: polish ? (generation.emptyPolish ? '' : '润色后的候选剧本。') : '队列候选剧本。',
                    polishDirections: [
                      { title: '让河岸冲突更紧凑', instruction: '保留父女关系和河岸场景，压缩铺垫，让冲突推进更紧凑。' },
                      { title: '让父女对白更自然', instruction: '保留结局，让父女对白更有潜台词，用动作表达情绪。' },
                    ] }
                : { shots: [{ title: '队列生成镜头', scene: '河岸', action: '人物沿河继续行走', duration: 4, characters: [] }] }
              child.stdout.write(JSON.stringify(succeeded
                ? { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } }
                : { type: 'turn.failed', error: { message: '模拟文字生成失败，请手动重试。' } }) + '\n')
              child.exitCode = succeeded ? 0 : 1
              child.emit('close', child.exitCode)
            }
            if (generation.deferred) generation.finish = finish
            else finish()
            done()
          },
        })
        return child
      }
      child.stdin = new Writable({write(chunk, _encoding, done) {
        const r=JSON.parse(String(chunk))
        queueMicrotask(() => {
          if(!r.id)return
          const result = r.method==='modelProvider/capabilities/read' ? {imageGeneration:true} :
            r.method==='model/list' ? {data:[{model:'test-default-image-model',isDefault:true}]} :
            r.method==='thread/start' ? {thread:{id:'reference-image-test'}} : {}
          child.stdout.write(JSON.stringify({id:r.id,result})+'\n')
          if(r.method==='turn/start'){
            generation.starts++
            generation.events.push('image')
            const finish = (succeeded = true) => {
              generation.finish = null
              const item = succeeded
                ? {type:'imageGeneration',status:'completed',result:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='}
                : {type:'imageGeneration',status:'failed',failure:{type:'usageLimitExceeded'}}
              child.stdout.write(JSON.stringify({method:'item/completed',params:{threadId:'reference-image-test',item}})+'\n')
              child.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'reference-image-test',turn:{items:[]}}})+'\n')
            }
            if (generation.deferred) generation.finish = finish
            else finish()
          }
        })
        done()
      }})
      if(args[0]==='login')queueMicrotask(()=>{child.stderr.write('Logged in using ChatGPT');child.exitCode=0;child.emit('close',0)})
      return child
    }
    syncBuiltinESMExports()
  })
  const referenceAsset = (await tool('read',{projectId:project.id})).project.assets[0]
  const referenceCard = page.locator('.asset-card').filter({has:page.getByRole('heading',{name:referenceAsset.name,exact:true})})
  await referenceCard.getByRole('button',{name:'生成参考图',exact:true}).click()
  const referenceDialog=page.getByRole('dialog',{name:/AI 生成参考图/})
  assert.equal(await referenceDialog.getByLabel('发送给模型的提示词').inputValue(), referenceAsset.prompt)
  assert.equal(await referenceDialog.getByRole('button',{name:/复制|导入/}).count(),0)
  await referenceDialog.screenshot({path:join(evidence,'plugin-06-direct-reference-dialog.png')})
  const submittedPrompt = '生成爸爸的人物参考图，保留衣着和面部特征。'
  await referenceDialog.getByLabel('发送给模型的提示词').fill(submittedPrompt)
  await referenceDialog.getByRole('button',{name:'在软件中直接生成图片',exact:true}).click()
  await referenceDialog.getByText('正在生成图片，可关闭此窗口，完成后自动保存。', { exact: false }).waitFor()
  assert(await referenceDialog.getByRole('button', { name: '完成 / 关闭' }).isEnabled())
  await referenceDialog.getByRole('button', { name: '完成 / 关闭' }).click()
  await referenceDialog.waitFor({state:'hidden'})
  const background = page.getByLabel('AI 任务队列')
  await background.waitFor()
  await page.getByRole('button', { name: '剧本 01' }).click()
  await background.waitFor()
  await tool('edit', { command: { type: 'create', title: '后台生图隔离验证', aspect: '1:1' } })
  await page.locator('.project-nav').getByRole('button', { name: '后台生图隔离验证', exact: true }).click()
  await background.getByText(project.title, { exact: false }).waitFor()
  await page.waitForTimeout(1200)
  await background.getByRole('button', { name: '查看生成' }).click()
  await referenceDialog.waitFor()
  assert.equal(await referenceDialog.getByLabel('发送给模型的提示词').inputValue(), submittedPrompt)
  assert(await referenceDialog.getByRole('button', { name: '正在生成图片…' }).isDisabled())
  const progressText = await referenceDialog.getByRole('status').innerText()
  assert.match(progressText, /\d+:\d{2}$/)
  assert(!progressText.endsWith('0:00'), 'Reopening the image dialog reset its elapsed time')
  assert.equal(await app.evaluate(() => globalThis.imageGenerationTest.starts), 1)
  assert.equal(await app.evaluate(() => globalThis.imageGenerationTest.kills), 0)
  await page.keyboard.press('Escape')
  await referenceDialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '资产库 02' }).click()
  await page.screenshot({ path: join(evidence, 'plugin-06-image-background.png') })

  // A result belongs to its submitted asset, even while another dialog is open.
  const secondAsset = (await tool('read', { projectId: project.id })).project.assets[1]
  const secondCard = page.locator('.asset-card').filter({ has: page.getByRole('heading', { name: secondAsset.name, exact: true }) })
  await secondCard.getByRole('button', { name: '生成参考图', exact: true }).click()
  const otherDialog = page.getByRole('dialog', { name: `AI 生成参考图 · ${secondAsset.name}` })
  assert(await otherDialog.getByRole('button', { name: '加入 AI 队列' }).isEnabled())
  await app.evaluate(() => { globalThis.imageGenerationTest.finish() })
  await background.waitFor({ state: 'hidden' })
  assert(await otherDialog.isVisible(), 'Completing the old generation closed a newer dialog')
  await otherDialog.getByRole('button', { name: '完成 / 关闭' }).click()
  const generated=(await tool('read',{projectId:project.id})).project
  const firstReference=generated.assets.find(a=>a.id===referenceAsset.id).selectedMediaId
  assert(firstReference)
  assert.equal(generated.media.find(m=>m.id===firstReference).slot,'reference')
  assert.equal(generated.media.find(m=>m.id===firstReference).prompt, submittedPrompt)
  assert.equal(generated.assets.find(a=>a.id===secondAsset.id).selectedMediaId, secondAsset.selectedMediaId)
  await referenceCard.locator('.asset-visual img').evaluate(img=>img.decode())
  assert.equal(await referenceCard.locator('.asset-visual img').evaluate(img=>img.naturalWidth),1)
  await page.screenshot({path:join(evidence,'plugin-07-reference-saved.png')})

  // New image dialogs start from asset properties; submitted task prompts stay
  // in queue records and can be retried explicitly from the task center.
  await referenceCard.getByRole('button', { name: '生成参考图', exact: true }).click()
  assert.equal(await referenceDialog.getByLabel('发送给模型的提示词').inputValue(), referenceAsset.prompt,
    'A new generation reused an old completed prompt instead of the current asset settings')
  await referenceDialog.getByRole('button', { name: '完成 / 关闭' }).click()
  await referenceCard.getByRole('button', { name: `编辑资产 ${referenceAsset.name}`, exact: true }).click()
  const editAsset = page.getByRole('dialog', { name: referenceAsset.name, exact: true })
  const revisedReferencePrompt = '人物参考图：短黑发、米色风衣，正面全身，柔和自然光。\n服装和面部特征保持一致。'
  await editAsset.getByLabel('参考图提示词').fill(revisedReferencePrompt)
  await editAsset.getByRole('button', { name: '保存资产', exact: true }).click()
  await editAsset.waitFor({ state: 'hidden' })
  await referenceCard.getByRole('button', { name: '生成参考图', exact: true }).click()
  assert.equal(await referenceDialog.getByLabel('发送给模型的提示词').inputValue(), revisedReferencePrompt)
  await referenceDialog.screenshot({ path: join(evidence, 'plugin-06-reference-asset-prompt.png') })
  await referenceDialog.getByLabel('发送给模型的提示词').fill('失败后保留这条生图要求。')
  await referenceDialog.getByRole('button', { name: '在软件中直接生成图片', exact: true }).click()
  await referenceDialog.getByText('正在生成图片，可关闭此窗口，完成后自动保存。', { exact: false }).waitFor()
  await referenceDialog.getByRole('button', { name: '关闭对话框' }).click()
  await referenceDialog.waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 640, height: 900 })
  await page.getByRole('button', { name: '项目导航', exact: true }).click()
  await page.getByRole('button', { name: '深色 · Graphite' }).click()
  await page.getByRole('button', { name: 'EN', exact: true }).click()
  await page.getByRole('button', { name: 'Close project navigation', exact: true }).click()
  await page.getByLabel('AI task queue').waitFor()
  await page.screenshot({ path: join(evidence, 'plugin-06-image-background-dark-640.png') })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await app.evaluate(() => { globalThis.imageGenerationTest.finish(false) })
  await page.getByLabel('AI task queue').waitFor({ state: 'hidden' })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Project navigation', exact: true }).click()
  await page.getByRole('button', { name: '中文', exact: true }).click()
  await page.getByRole('button', { name: '浅色 · Warm paper' }).click()
  await page.getByRole('button', { name: '关闭项目导航', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await referenceCard.getByRole('button', { name: '生成参考图', exact: true }).click()
  await referenceDialog.getByRole('alert').getByText('ChatGPT 图片额度已用完，请等待额度重置。').waitFor()
  assert.equal(await referenceDialog.getByLabel('发送给模型的提示词').inputValue(), revisedReferencePrompt)
  assert.equal((await tool('read', { projectId: project.id })).aiTasks.find(task => task.status === 'failed').request.prompt,
    '失败后保留这条生图要求。')
  assert(await referenceDialog.getByRole('button', { name: '在软件中直接生成图片', exact: true }).isEnabled())
  assert.equal(await app.evaluate(() => globalThis.imageGenerationTest.starts), 2)
  assert.equal((await tool('read', { projectId: project.id })).project.assets.find(a=>a.id===referenceAsset.id).selectedMediaId, firstReference)
  await referenceDialog.getByRole('button', { name: '完成 / 关闭' }).click()
  await app.evaluate(() => { globalThis.imageGenerationTest.deferred = false })
  const directImage=await tool('generate',{command:{type:'generateImage',projectId:project.id,ownerId:referenceAsset.id,slot:'reference'}})
  assert.match(directImage.text,/^media:\/\/asset\//)
  const regenerated=(await tool('read',{projectId:project.id})).project
  assert.notEqual(regenerated.assets.find(a=>a.id===referenceAsset.id).selectedMediaId,firstReference)
  assert.equal(regenerated.media.filter(m=>m.ownerId===referenceAsset.id&&m.slot==='reference').length,2)
  assert.equal(regenerated.media.find(m=>m.id===regenerated.assets.find(a=>a.id===referenceAsset.id).selectedMediaId).prompt, revisedReferencePrompt)

  // Exercise the shared FIFO lane through the actual UI, SQLite, Codex decoder
  // and project import handlers. Only the external model process is simulated.
  const baseline = await app.evaluate(() => {
    globalThis.imageGenerationTest.deferred = true
    globalThis.imageGenerationTest.events = []
    globalThis.imageGenerationTest.prompts = []
    return globalThis.imageGenerationTest.starts
  })
  const waitStarts = async (count) => {
    const ready = await app.evaluate(async (_electron, target) => {
      for (let i = 0; i < 200; i++) {
        if (globalThis.imageGenerationTest.starts === target && globalThis.imageGenerationTest.finish) return true
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return false
    }, baseline + count)
    if (!ready) {
      await page.screenshot({ path: join(evidence, 'plugin-error-ai-queue.png') })
      console.error('Queue test state:', await app.evaluate(() => ({ starts: globalThis.imageGenerationTest.starts,
        hasFinish: !!globalThis.imageGenerationTest.finish, events: globalThis.imageGenerationTest.events })),
        (await tool('read', { projectId: project.id })).aiTasks)
    }
    assert(ready, `Expected ${count} sequential AI starts`)
  }
  await referenceCard.getByRole('button', { name: '生成参考图', exact: true }).click()
  await referenceDialog.getByLabel('发送给模型的提示词').fill('队列图一：爸爸的人物参考。')
  await referenceDialog.getByRole('button', { name: '在软件中直接生成图片', exact: true }).click()
  await waitStarts(1)
  await referenceDialog.getByRole('button', { name: '完成 / 关闭' }).click()
  await page.getByRole('button', { name: '剧本 01' }).click()
  const chatFile = join(data, 'queued-story.txt')
  await writeFile(chatFile, '队列附件内容：角色穿蓝色外套，场景始终在河岸。')
  const chatPicker = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '添加文件', exact: true }).click()
  await (await chatPicker).setFiles(chatFile)
  await page.locator('.script-chat-files.pending').getByText('queued-story.txt').waitFor()
  await page.getByLabel('发送到当前集').fill('队列剧本：结合附件继续写。')
  await page.getByRole('button', { name: '发送给 AI 编剧', exact: true }).click()
  const waitingChat = page.locator('.script-chat-turn').filter({ hasText: '队列剧本：结合附件继续写。' })
  await waitingChat.getByRole('status').getByText('排队中 · 前面还有 1 个任务', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('发送到当前集').inputValue(), '')
  await page.getByLabel('发送到当前集').fill('取消这个等待请求。')
  await page.getByRole('button', { name: '发送给 AI 编剧', exact: true }).click()
  const cancelledChat = page.locator('.script-chat-turn').filter({ hasText: '取消这个等待请求。' })
  await cancelledChat.getByRole('button', { name: '取消排队' }).click()
  await cancelledChat.getByText('已取消', { exact: true }).waitFor()
  for (const tab of ['资产库 02', '导演台 03', '成片 04']) {
    await page.getByRole('button', { name: tab }).click()
    await page.getByRole('button', { name: '剧本 01' }).click()
    await waitingChat.getByRole('status').getByText('排队中 · 前面还有 1 个任务', { exact: true }).waitFor()
  }
  await page.screenshot({ path: join(evidence, 'plugin-08-script-queued-after-tabs.png') })
  await page.getByRole('button', { name: '导演台 03' }).click()
  await page.getByRole('button', { name: 'AI 拆解分镜', exact: true }).click()
  const storyboardDialog = page.getByRole('dialog', { name: 'AI 生成分镜', exact: true })
  await storyboardDialog.getByLabel('补充创作要求（可选）').fill('队列分镜：角色从河岸继续走。')
  assert(await storyboardDialog.getByRole('button', { name: '加入 AI 队列' }).isEnabled())
  await storyboardDialog.getByRole('button', { name: '加入 AI 队列' }).click()
  await storyboardDialog.getByRole('status').getByText('排队中 · 前面还有 2 个任务', { exact: true }).waitFor()
  await storyboardDialog.screenshot({ path: join(evidence, 'plugin-09-storyboard-queued.png') })
  await storyboardDialog.getByRole('button', { name: '关闭对话框' }).click()
  await page.getByRole('button', { name: '资产库 02' }).click()
  await secondCard.getByRole('button', { name: '生成参考图', exact: true }).click()
  await otherDialog.getByLabel('发送给模型的提示词').fill('队列图二：保持场景稳定。')
  await otherDialog.getByRole('button', { name: '加入 AI 队列' }).click()
  await otherDialog.getByRole('status').getByText('排队中 · 前面还有 3 个任务', { exact: true }).waitFor()
  await otherDialog.getByRole('button', { name: '完成 / 关闭' }).click()
  await background.getByRole('button', { name: '任务中心', exact: true }).click()
  const taskCenter = page.getByRole('dialog', { name: '任务中心', exact: true })
  assert.equal(await taskCenter.getByRole('button', { name: '取消排队', exact: true }).count(), 3)
  await taskCenter.screenshot({ path: join(evidence, 'plugin-10-mixed-ai-queue.png') })
  await taskCenter.getByRole('button', { name: '关闭对话框' }).click()
  assert.equal(await app.evaluate(() => globalThis.imageGenerationTest.starts), baseline + 1)

  await app.evaluate(() => globalThis.imageGenerationTest.finish())
  await waitStarts(2)
  const queuedChatTask = (await tool('read', { projectId: project.id })).aiTasks.find(task =>
    task.request.type === 'scriptChatGenerate' && task.request.request.startsWith('队列剧本'))
  assert.equal(queuedChatTask.status, 'running')
  assert.equal(queuedChatTask.attachments[0].name, 'queued-story.txt')
  assert.match(await readFile(join(data, 'library', 'projects', project.id, queuedChatTask.attachments[0].file), 'utf8'), /角色穿蓝色外套/)
  assert.match(await app.evaluate(() => globalThis.imageGenerationTest.prompts[0]), /角色穿蓝色外套/)
  await app.evaluate(() => globalThis.imageGenerationTest.finish())
  await waitStarts(3)
  await page.getByRole('button', { name: '导演台 03' }).click()
  await page.getByRole('button', { name: 'AI 拆解分镜', exact: true }).click()
  await storyboardDialog.getByText('正在生成分镜，可关闭窗口继续处理。', { exact: false }).waitFor()
  assert(await storyboardDialog.getByRole('button', { name: '关闭', exact: true }).isEnabled())
  assert.equal(await storyboardDialog.getByLabel('补充创作要求（可选）').inputValue(), '队列分镜：角色从河岸继续走。')
  await storyboardDialog.screenshot({ path: join(evidence, 'plugin-09-storyboard-running-closable.png') })
  await storyboardDialog.getByRole('button', { name: '关闭', exact: true }).click()
  await storyboardDialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'AI 拆解分镜', exact: true }).click()
  await storyboardDialog.getByText('正在生成分镜，可关闭窗口继续处理。', { exact: false }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.imageGenerationTest.starts), baseline + 3)
  await page.keyboard.press('Escape')
  await storyboardDialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '剧本 01' }).click()
  await page.getByLabel('对话记录').getByText('队列编剧回复', { exact: true }).waitFor()
  assert(await page.locator('.script-chat-turn').filter({ hasText: '队列编剧回复' }).getByRole('button', { name: '应用到剧本' }).isEnabled())
  await page.screenshot({ path: join(evidence, 'plugin-11-chat-completed-while-storyboard-runs.png') })
  await app.evaluate(() => globalThis.imageGenerationTest.finish())
  await waitStarts(4)
  const queuedResult = (await tool('read', { projectId: project.id })).project
  assert.equal(queuedResult.shots.filter(shot => shot.title === '队列生成镜头').length, 1)
  assert.equal(queuedResult.shots[0].episodeId, episodeId)
  await page.getByRole('button', { name: '导演台 03' }).click()
  await page.getByText('队列生成镜头', { exact: true }).first().waitFor()
  await app.evaluate(() => globalThis.imageGenerationTest.finish())
  await background.waitFor({ state: 'hidden' })
  assert.deepEqual(await app.evaluate(() => globalThis.imageGenerationTest.events), ['image', 'chat', 'storyboard', 'image'])
  const completed = await tool('read', { projectId: project.id })
  assert.equal(completed.aiTasks.filter(task => ['queued', 'running'].includes(task.status)).length, 0)
  assert.equal(completed.aiTasks.find(task => task.request.request === '取消这个等待请求。').status, 'cancelled')
  assert.notEqual(completed.project.assets.find(asset => asset.id === secondAsset.id).selectedMediaId, secondAsset.selectedMediaId)
  assert.equal((await tool('read', {})).jobs.length, 0)

  // A script edited during generation must not receive shots from its old version.
  const staleStoryboard = await tool('generate', { command: { type: 'aiEnqueue', request: {
    type: 'generateStoryboard', projectId: project.id, episodeId, request: '检查剧本更新时的分镜归属。',
  } } })
  await waitStarts(5)
  await tool('edit', { command: { type: 'episode', projectId: project.id, episodeId,
    title: completed.project.episodes[0].title, script: '新版剧本：人物已离开河岸。' } })
  await app.evaluate(() => globalThis.imageGenerationTest.finish())
  await background.waitFor({ state: 'hidden' })
  const revised = await tool('read', { projectId: project.id })
  const staleTask = revised.aiTasks.find(task => task.id === staleStoryboard.text)
  assert.equal(staleTask.status, 'failed')
  assert.match(staleTask.error, /剧本已变更/)
  assert.match(staleTask.resultText, /队列生成镜头/)
  assert.equal(revised.project.shots.length, 0)
  assert.equal(await app.evaluate(() => globalThis.imageGenerationTest.starts), baseline + 5)
  await page.getByRole('button', { name: '任务中心', exact: true }).first().click()
  const staleRow = taskCenter.locator('.job').filter({ hasText: staleTask.error })
  await staleRow.getByText('查看生成结果', { exact: true }).click()
  assert.match(await staleRow.locator('pre').innerText(), /队列生成镜头/)
  assert(await taskCenter.locator('.modal-body').evaluate(element => element.scrollWidth <= element.clientWidth))
  await taskCenter.screenshot({ path: join(evidence, 'plugin-12-stale-result-review.png') })
  await taskCenter.getByRole('button', { name: '关闭对话框' }).click()

  // Polish the chosen AI response, even when the editor has another version.
  // The real UI, command, persistent queue, prompt and result import are used.
  await page.getByRole('button', { name: '剧本 01' }).click()
  const originalDraft = page.locator('.script-chat-turn').filter({ has: page.getByText('队列编剧回复', { exact: true }) })
  const originalOptions = originalDraft.getByRole('region', { name: 'AI 润色选项' })
  assert.equal(await originalOptions.locator('.script-polish-direction').count(), 2)
  await originalOptions.getByRole('button', { name: '润色方向 1：让河岸冲突更紧凑', exact: true }).click()
  await waitStarts(6)
  assert(await originalOptions.locator('.script-polish-direction').first().isDisabled())
  const polishTask = (await tool('read', { projectId: project.id })).aiTasks.find(task =>
    task.request.type === 'scriptChatGenerate' && task.request.polishTurnId)
  const originalTurn = revised.project.episodes[0].scriptChat.find(turn => turn.text === '队列编剧回复')
  assert.equal(polishTask.request.polishTurnId, originalTurn.id)
  assert.equal(polishTask.polishSource.script, '队列候选剧本。')
  const polishPrompt = await app.evaluate(() => globalThis.imageGenerationTest.prompts.at(-1))
  assert.match(polishPrompt, /队列候选剧本。/)
  assert.match(polishPrompt, /压缩铺垫/)
  assert(!polishPrompt.includes('新版剧本：人物已离开河岸。'))
  await page.getByRole('button', { name: '资产库 02' }).click()
  await page.getByRole('button', { name: '剧本 01' }).click()
  await originalOptions.getByRole('status').waitFor()
  await app.evaluate(() => globalThis.imageGenerationTest.finish())
  const polishedDraft = page.locator('.script-chat-turn').filter({ has: page.getByText('润色编剧回复', { exact: true }) })
  await polishedDraft.waitFor()
  await polishedDraft.getByRole('region', { name: 'AI 润色选项' }).waitFor()
  assert.equal(await page.getByLabel('剧本正文').inputValue(), '新版剧本：人物已离开河岸。')
  const polishedState = await tool('read', { projectId: project.id })
  const polishedTurn = polishedState.project.episodes[0].scriptChat.at(-1)
  assert.equal(polishedTurn.polishSourceTurnId, originalTurn.id)
  assert.equal(polishedTurn.script, '润色后的候选剧本。')
  assert.equal(polishedTurn.polishDirections.length, 2)
  await polishedDraft.screenshot({ path: join(evidence, 'plugin-13-polished-script-options.png') })

  // Empty model output must fail without adding a false successful reply;
  // a custom direction can be retried only through a user action.
  const customOptions = polishedDraft.getByRole('region', { name: 'AI 润色选项' })
  const customDirection = '只调整父女对白，保留桥下的停顿和结局。'
  await customOptions.getByLabel('自定义润色方向').fill(customDirection)
  await app.evaluate(() => { globalThis.imageGenerationTest.emptyPolish = true })
  await customOptions.getByRole('button', { name: '按自定义方向润色', exact: true }).click()
  await waitStarts(7)
  const customPrompt = await app.evaluate(() => globalThis.imageGenerationTest.prompts.at(-1))
  assert.match(customPrompt, /润色后的候选剧本。/)
  assert(customPrompt.includes(customDirection))
  await app.evaluate(() => globalThis.imageGenerationTest.finish())
  const failedPolish = page.locator('.script-chat-turn.user').filter({ hasText: customDirection })
  await failedPolish.getByText('AI 未返回润色后的剧本，请手动重试', { exact: true }).waitFor()
  const failedState = await tool('read', { projectId: project.id })
  assert.equal(failedState.project.episodes[0].scriptChat.length, polishedState.project.episodes[0].scriptChat.length)
  assert.equal(await app.evaluate(() => globalThis.imageGenerationTest.starts), baseline + 7)
  await app.evaluate(() => { globalThis.imageGenerationTest.emptyPolish = false })
  await failedPolish.getByRole('button', { name: '手动重试', exact: true }).click()
  await waitStarts(8)
  await app.evaluate(() => globalThis.imageGenerationTest.finish())
  await background.waitFor({ state: 'hidden' })
  assert.equal(await polishedDraft.count(), 2)
  const finalDraft = polishedDraft.last()
  await finalDraft.getByRole('region', { name: 'AI 润色选项' }).getByRole('button', { name: '不润色', exact: true }).click()
  await finalDraft.getByText('已选择不润色，保留此版', { exact: true }).waitFor()
  const finalState = await tool('read', { projectId: project.id })
  assert.equal(finalState.project.episodes[0].scriptChat.at(-1).polishSkipped, true)
  assert.equal(finalState.project.episodes[0].script, '新版剧本：人物已离开河岸。')
  assert.equal(await app.evaluate(() => globalThis.imageGenerationTest.starts), baseline + 8)
  assert.equal(finalState.jobs.length, 0)
  await finalDraft.getByRole('button', { name: '重新选择', exact: true }).click()
  await page.screenshot({ path: join(evidence, 'plugin-14-script-polish-desktop.png') })

  await page.setViewportSize({ width: 900, height: 900 })
  await page.getByRole('button', { name: /^剧本(?: 01)?$/ }).click()
  assert(await page.getByRole('button', { name: '项目导航', exact: true }).isVisible())
  await page.getByRole('button', { name: '项目导航', exact: true }).click()
  await page.getByRole('button', { name: '关闭项目导航' }).click()
  await page.screenshot({ path: join(evidence, 'plugin-02-script-900.png') })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.setViewportSize({ width: 640, height: 900 })
  await page.screenshot({ path: join(evidence, 'plugin-03-script-640.png') })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.getByRole('button', { name: '项目导航', exact: true }).click()
  await page.getByRole('button', { name: '深色 · Graphite' }).click()
  await page.getByRole('button', { name: '关闭项目导航' }).click()
  await finalDraft.getByLabel('自定义润色方向').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(evidence, 'plugin-15-dark-polish-640.png') })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(evidence, 'plugin-04-dark-640.png') })

  // A real resource is embedded through the standard MCP Apps handshake.
  const html = (await rpc('resources/read', { uri: 'ui://muweave/studio' })).result.contents[0].text
  assert(Buffer.byteLength(html) < 5 * 1024 * 1024)
  const host = await context.newPage()
  host.on('pageerror', (error) => errors.push(error.message))
  await host.exposeFunction('hostTool', async (params) => (await rpc('tools/call', params)).result)
  await host.setContent('<iframe title="Muweave Studio" style="border:0;width:100%;height:900px"></iframe>')
  await host.evaluate((resource) => {
    addEventListener('message', async (event) => {
      const message = event.data
      if (message.method === 'ui/initialize') event.source.postMessage({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-21', hostCapabilities: { serverTools: {} } } }, '*')
      if (message.method === 'tools/call') event.source.postMessage({ jsonrpc: '2.0', id: message.id, result: await window.hostTool(message.params) }, '*')
    })
    document.querySelector('iframe').srcdoc = resource
  }, html)
  const studio = host.frameLocator('iframe')
  try { await studio.getByRole('heading', { name: '故事在这里，成为画面。' }).waitFor() }
  catch (error) {
    await host.screenshot({ path: join(evidence, 'plugin-error-mcp-app.png') })
    console.error('MCP App errors:', errors, await studio.locator('body').innerText())
    throw error
  }
  await host.screenshot({ path: join(evidence, 'plugin-05-mcp-app.png') })
  await studio.getByRole('button', { name: '镜头', exact: true }).click()
  try { await studio.locator('.shot-list article').first().waitFor() }
  catch (error) { console.error('MCP previs errors:', errors, await studio.locator('body').innerText()); await host.screenshot({ path: join(evidence, 'plugin-error-mcp-previs.png') }); throw error }
  await studio.getByRole('button', { name: '3D 预演', exact: true }).click()
  await studio.locator('.previs canvas').waitFor()
  await studio.getByRole('button', { name: '导出构图图', exact: true }).click()
  await studio.getByText('构图图已保存到镜头素材', { exact: true }).waitFor()
  await host.screenshot({ path: join(evidence, 'plugin-05-mcp-previs.png') })
  await studio.getByRole('button', { name: 'EN', exact: true }).click()
  await studio.getByRole('region', { name: '3D previs studio', exact: true }).waitFor()
  await host.screenshot({ path: join(evidence, 'plugin-05-mcp-previs-en.png') })
  assert.deepEqual(failedRequests, [])
  assert.deepEqual(errors, [])
  console.log('PASS: authenticated runtime, MCP stdio, shared AI FIFO queue, queued cancellation, chat tab persistence, background storyboard import, saved attachments, stale script protection, preset/custom script polishing, empty polish failure/manual retry, skip persistence, reference image versioning, imports, exports, responsive Studio and MCP Apps UI. No paid jobs submitted.')
} finally {
  sidecar?.kill()
  await browser?.close()
  await app.close()
}
