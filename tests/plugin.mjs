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
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(base)
  await page.locator('.shot-list article').first().waitFor()
  await page.locator('.brand-mark img').evaluate((image) => image.decode())
  await page.screenshot({ path: join(evidence, 'plugin-01-studio.png') })
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
    const original = cp.spawn
    cp.spawn = (file, args, options) => {
      if (!String(file).endsWith('codex.exe')) return original(file, args, options)
      const child = Object.assign(new EventEmitter(), { stdout:new PassThrough(), stderr:new PassThrough(), exitCode:null })
      child.kill = () => { child.exitCode=0; child.emit('close',0); return true }
      child.stdin = new Writable({write(chunk, _encoding, done) {
        const r=JSON.parse(String(chunk))
        queueMicrotask(() => {
          if(!r.id)return
          const result = r.method==='modelProvider/capabilities/read' ? {imageGeneration:true} :
            r.method==='model/list' ? {data:[{model:'test-default-image-model',isDefault:true}]} :
            r.method==='thread/start' ? {thread:{id:'reference-image-test'}} : {}
          child.stdout.write(JSON.stringify({id:r.id,result})+'\n')
          if(r.method==='turn/start'){
            child.stdout.write(JSON.stringify({method:'item/completed',params:{threadId:'reference-image-test',
              item:{type:'imageGeneration',status:'completed',result:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='}}})+'\n')
            child.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'reference-image-test',turn:{items:[]}}})+'\n')
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
  assert((await referenceDialog.getByLabel('发送给 ChatGPT 的提示词').inputValue()).includes(referenceAsset.name))
  assert.equal(await referenceDialog.getByRole('button',{name:/复制|导入/}).count(),0)
  await referenceDialog.screenshot({path:join(evidence,'plugin-06-direct-reference-dialog.png')})
  await referenceDialog.getByRole('button',{name:'在软件中直接生成图片',exact:true}).click()
  await referenceDialog.waitFor({state:'hidden'})
  const generated=(await tool('read',{projectId:project.id})).project
  const firstReference=generated.assets.find(a=>a.id===referenceAsset.id).selectedMediaId
  assert(firstReference)
  assert.equal(generated.media.find(m=>m.id===firstReference).slot,'reference')
  await referenceCard.locator('.asset-visual img').evaluate(img=>img.decode())
  assert.equal(await referenceCard.locator('.asset-visual img').evaluate(img=>img.naturalWidth),1)
  await page.screenshot({path:join(evidence,'plugin-07-reference-saved.png')})
  const directImage=await tool('generate',{command:{type:'generateImage',projectId:project.id,ownerId:referenceAsset.id,slot:'reference'}})
  assert.match(directImage.text,/^media:\/\/asset\//)
  const regenerated=(await tool('read',{projectId:project.id})).project
  assert.notEqual(regenerated.assets.find(a=>a.id===referenceAsset.id).selectedMediaId,firstReference)
  assert.equal(regenerated.media.filter(m=>m.ownerId===referenceAsset.id&&m.slot==='reference').length,2)
  assert(regenerated.media.find(m=>m.id===regenerated.assets.find(a=>a.id===referenceAsset.id).selectedMediaId).prompt.includes(referenceAsset.name))

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
  assert.deepEqual(errors, [])
  console.log('PASS: authenticated runtime, MCP stdio, native service, direct reference generation with automatic selection/versioning, imports, exports, script archive, responsive Studio and MCP Apps UI. No paid jobs submitted.')
} finally {
  sidecar?.kill()
  await browser?.close()
  await app.close()
}
