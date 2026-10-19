import { _electron as electron } from 'playwright'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

const data = await mkdtemp(join(tmpdir(), 'director-desktop-'))
const evidence = resolve('test-results')
await mkdir(evidence, { recursive: true })
const env = { ...process.env, DIRECTOR_DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE
const launch = () =>
  electron.launch({
    ...(process.env.DIRECTOR_EXECUTABLE
      ? { executablePath: resolve(process.env.DIRECTOR_EXECUTABLE), args: [] }
      : { args: ['.'] }),
    cwd: process.cwd(),
    env,
  })
let app = await launch(),
  page = await app.firstWindow()
const errors = []
try {
  page.on('pageerror', (e) => errors.push(e.message))
  await page.getByRole('button', { name: '探索示例项目' }).waitFor()
  assert.equal(await page.title(), 'Muweave 幕织 · AI 导演台')
  await page.locator('.brand-mark img').evaluate((image) => image.decode())
  await page.locator('.welcome-symbol img').evaluate((image) => image.decode())
  assert(await page.locator('.brand-mark img').evaluate((image) => image.naturalWidth >= 256))
  await page.screenshot({ path: join(evidence, '01-welcome.png') })
  await page.getByRole('button', { name: '探索示例项目' }).click()
  await page.getByRole('heading', { name: '故事在这里，成为画面。' }).waitFor()
  await page.locator('.shot-list article').first().waitFor()
  assert.match(await page.getByRole('button', { name: '列表', exact: true }).getAttribute('class'), /active/)
  await page.screenshot({ path: join(evidence, '02-director-list.png') })
  await page.getByRole('button', { name: '画布', exact: true }).click()
  await page.locator('.canvas-card').first().waitFor()
  await page.getByRole('button', { name: '列表', exact: true }).click()
  const title = page.getByLabel('镜头标题')
  await title.fill('桌面测试 · 已保存的镜头')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('已保存到本机', { exact: true }).waitFor()
  let snapshot = await page.evaluate(
    async () => await window.director.command({ type: 'snapshot' }),
  )
  assert(snapshot.ok)
  const project = snapshot.state.projects[0],
    shot = project.shots[0]
  assert.equal(shot.title, '桌面测试 · 已保存的镜头')
  // Exercise the actual 3D editor and local encoder; no paid generation is submitted.
  await page.getByRole('button', { name: '3D 预演', exact: true }).click()
  const previs = page.getByRole('region', { name: '3D 预演台', exact: true })
  await previs.locator('canvas[aria-label="3D 预演视窗"]').waitFor()
  await previs.getByRole('button', { name: '导出构图图', exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => [...document.querySelectorAll('.previs button')].some((button) => button.textContent.includes('导出白模视频') && !button.disabled))
  assert((await previs.locator('canvas').evaluate((canvas) => canvas.toDataURL())).length > 10000)
  await previs.locator('.previs-object > button:first-child').first().click()
  await previs.getByLabel('预演时间', { exact: true }).focus()
  await previs.getByLabel('预演时间', { exact: true }).press('End')
  await previs.getByLabel('位置 X', { exact: true }).fill('2')
  await previs.getByRole('button', { name: '摄影机', exact: true }).first().click()
  await previs.getByRole('button', { name: '推近', exact: true }).click()
  if (await previs.getByRole('button', { name: '保存预演', exact: true }).isEnabled())
    await previs.getByRole('button', { name: '保存预演', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.previs-title [role="status"]')?.textContent === '已保存到本机')
  await page.screenshot({ path: join(evidence, '02-previs-editor.png') })
  await previs.getByRole('button', { name: '导出构图图', exact: true }).click()
  await page.getByText('构图图已保存到镜头素材', { exact: true }).waitFor()
  await previs.getByRole('button', { name: '导出白模视频', exact: true }).click()
  await page.getByText('白模预演视频已保存到镜头素材', { exact: true }).waitFor({ timeout: 120000 })
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  const previsProject = snapshot.state.projects[0], previsShot = previsProject.shots.find((item) => item.id === shot.id)
  assert(previsShot.previsMediaId)
  assert.equal(previsShot.videoMediaId, undefined)
  assert.equal(previsShot.previs.camera.length, 2)
  const previsMedia = previsProject.media.find((media) => media.id === previsShot.previsMediaId)
  assert.equal(previsMedia.slot, 'previs')
  assert.equal(previsMedia.previsSource.duration, shot.duration)
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json',
    join(data, 'library', 'projects', project.id, previsMedia.file)], { encoding: 'utf8', windowsHide: true }))
  assert.equal(probe.streams.length, 1)
  assert.equal(Number(probe.streams[0].nb_frames), Math.ceil(shot.duration * 24))
  await page.screenshot({ path: join(evidence, '02-previs-exported.png') })
  await previs.getByRole('button', { name: '导出白模视频', exact: true }).click()
  await previs.getByRole('button', { name: '取消导出', exact: true }).click()
  await previs.locator('.previs-export').waitFor({ state: 'hidden' })
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  assert.equal(snapshot.state.projects[0].media.filter((m) => m.slot === 'previs').length, 1)
  const cancelledNotice = previs.getByRole('button', { name: '关闭提示', exact: true })
  if (await cancelledNotice.count()) await cancelledNotice.click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
  await page.screenshot({ path: join(evidence, '02-previs-compact.png') })
  assert(await previs.evaluate((element) => element.scrollWidth <= element.clientWidth), JSON.stringify(await previs.evaluate((element) => [...element.querySelectorAll('*')].filter((child) => child.scrollWidth > child.clientWidth + 2).slice(0, 15).map((child) => ({ class: child.className, width: child.clientWidth, scroll: child.scrollWidth })))) )
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1540, 990))
  await page.getByRole('button', { name: '列表', exact: true }).click()
  const extraAsset = project.assets.find((asset) => !shot.assetIds.includes(asset.id))
  assert(extraAsset)
  await page.locator('.inspector .asset-checks label').filter({ hasText: extraAsset.name }).getByRole('checkbox').check()
  await page.getByText('是否将其他镜头也绑定此资产？', { exact: false }).waitFor()
  await page.getByRole('button', { name: '选择镜头并应用', exact: true }).click()
  const bulkDialog = page.getByRole('dialog', { name: '批量应用镜头设置' })
  await bulkDialog.getByLabel('应用范围').selectOption('episode')
  await bulkDialog.screenshot({ path: join(evidence, '02-bulk-asset-linking.png') })
  await bulkDialog.getByRole('button', { name: '确认批量应用', exact: true }).click()
  await bulkDialog.waitFor({ state: 'hidden' })
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  assert(snapshot.state.projects[0].shots.every((item) => item.assetIds.includes(extraAsset.id)))
  for (const oldShot of project.shots) {
    const current = snapshot.state.projects[0].shots.find((item) => item.id === oldShot.id)
    assert(oldShot.assetIds.every((id) => current.assetIds.includes(id)))
    assert.equal(current.action, oldShot.action)
    assert.equal(current.dialogue, oldShot.dialogue)
  }
  await page.getByLabel('光线', { exact: true }).fill('桌面批量验证光线')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '批量应用到其他镜头', exact: true }).click()
  await bulkDialog.locator('.batch-edit-field').filter({ hasText: '关联资产' }).getByRole('checkbox').uncheck()
  await bulkDialog.locator('.batch-edit-field').filter({ hasText: '光线' }).getByRole('checkbox').check()
  await bulkDialog.getByLabel('应用范围').selectOption('episode')
  await bulkDialog.getByRole('button', { name: '清空选择', exact: true }).click()
  assert.equal(await bulkDialog.locator('.batch-edit-shot-list input:checked').count(), 0)
  await bulkDialog.getByRole('button', { name: '全选', exact: true }).click()
  assert.equal(await bulkDialog.locator('.batch-edit-shot-list input:checked').count(), project.shots.length - 1)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
  await bulkDialog.screenshot({ path: join(evidence, '02-bulk-settings-compact.png') })
  assert(await bulkDialog.evaluate((element) => element.scrollWidth <= element.clientWidth))
  await bulkDialog.getByRole('button', { name: '确认批量应用', exact: true }).click()
  await bulkDialog.waitFor({ state: 'hidden' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1540, 990))
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  assert(snapshot.state.projects[0].shots.every((item) => item.lighting === '桌面批量验证光线'))

  // Seed only the isolated test library. Pausing prevents these fixtures from submitting work.
  const previousConfig = snapshot.state.config
  assert((await page.evaluate((config) => window.director.command({ type: 'config', config }), { ...previousConfig, paused: true })).ok)
  const taskDates = ['2026-10-10T00:00:00.000Z', '2026-10-11T01:00:00.000Z', '2026-10-11T02:00:00.000Z', '2026-10-11T03:00:00.000Z']
  const fixtureTask = (id, status, index) => ({ kind: 'ai', id, projectId: project.id, title: `AI 编剧 · ${id}`,
    request: { type: 'scriptChatGenerate', projectId: project.id, episodeId: project.episodes[0].id, request: id, attachmentIds: [] },
    attachments: [], status, createdAt: taskDates[index], updatedAt: taskDates[index] })
  const fixtureTasks = [fixtureTask('desktop-running', 'running', 0), fixtureTask('desktop-old-queued', 'queued', 1),
    { id: 'desktop-video-queued', projectId: project.id, shotId: shot.id, snapshot: shot, status: 'queued',
      instanceType: 'plus', aspect: '16:9', videoResolution: '768p',
      site: previousConfig.site, workflowId: '123', mappings: [], stopOnFailure: false, pollErrors: 0, outputs: [],
      createdAt: taskDates[2], updatedAt: taskDates[2] }, fixtureTask('desktop-finished', 'succeeded', 3)]
  const fixtureDb = new DatabaseSync(join(data, 'library', 'director.sqlite'))
  try { for (const task of fixtureTasks) fixtureDb.prepare('INSERT INTO jobs VALUES(?,?)').run(task.id, JSON.stringify(task)) }
  finally { fixtureDb.close() }
  await page.evaluate(() => window.director.command({ type: 'pause', paused: true }))
  await page.getByRole('button', { name: '任务中心', exact: true }).first().click()
  const taskDialog = page.getByRole('dialog', { name: '任务中心', exact: true })
  assert.equal(await taskDialog.getByRole('button', { name: /暂停队列|继续队列/ }).count(), 0)
  assert.deepEqual(await taskDialog.locator('.job').evaluateAll((rows) => rows.map((row) => row.dataset.taskId)),
    ['desktop-running', 'desktop-finished', 'desktop-video-queued', 'desktop-old-queued'])
  assert.match(await taskDialog.locator('[data-task-id="desktop-video-queued"]').innerText(), /1344×768/)
  await taskDialog.screenshot({ path: join(evidence, '02-task-order-and-actions.png') })
  await taskDialog.locator('[data-task-id="desktop-finished"]').getByRole('button', { name: '删除记录', exact: true }).click()
  await page.getByRole('button', { name: '确认删除记录', exact: true }).click()
  await taskDialog.locator('[data-task-id="desktop-finished"]').waitFor({ state: 'hidden' })
  await taskDialog.getByRole('button', { name: '全部终止任务', exact: true }).click()
  await page.getByRole('button', { name: '确认全部终止', exact: true }).click()
  await page.getByRole('dialog', { name: '终止全部任务？', exact: true }).waitFor({ state: 'hidden' })
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  assert.equal(snapshot.state.config.paused, false)
  assert(snapshot.state.aiTasks.every((task) => task.status === 'cancelled'))
  assert(snapshot.state.jobs.every((task) => task.status === 'cancelled'))
  await taskDialog.screenshot({ path: join(evidence, '02-tasks-terminated.png') })
  for (const task of fixtureTasks.filter((task) => task.id !== 'desktop-finished')) {
    assert((await page.evaluate((taskId) => window.director.command({ type: 'deleteTask', taskId }), task.id)).ok)
  }
  await taskDialog.getByText('队列很安静', { exact: true }).waitFor()
  await taskDialog.getByRole('button', { name: '关闭对话框', exact: true }).click()
  assert((await page.evaluate((config) => window.director.command({ type: 'config', config }), previousConfig)).ok)
  await page.getByLabel('时长 / 秒').fill('3')
  await page.getByLabel('对白 / 字幕').fill('今天我们一起去看看那封信吧')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '批量', exact: true }).click()
  const batchDialog = page.getByRole('dialog', { name: '生成视频 / 创建镜头分组' })
  const resolution = batchDialog.getByRole('combobox', { name: '视频清晰度' })
  assert.equal(await resolution.inputValue(), '480p')
  await resolution.selectOption('768p')
  await page.waitForFunction(() => window.director.command({ type: 'snapshot' }).then((reply) => reply.state.config.videoResolution === '768p'))
  assert.match(await resolution.locator('option:checked').innerText(), /1344×768/)
  await batchDialog.screenshot({ path: join(evidence, '02-video-hd-resolution.png') })
  await resolution.selectOption('480p')
  await page.waitForFunction(() => window.director.command({ type: 'snapshot' }).then((reply) => reply.state.config.videoResolution === '480p'))
  await batchDialog.getByRole('button', { name: '清空选择', exact: true }).click()
  assert.equal(await batchDialog.locator('.batch-shots input:checked').count(), 0)
  await batchDialog.getByRole('button', { name: '全选', exact: true }).click()
  assert.equal(await batchDialog.locator('.batch-shots input:checked').count(), project.shots.length)
  await batchDialog.getByText('确认生成时会自动延长 1 个镜头').waitFor()
  assert.match(await batchDialog.locator('.batch-shots label').first().innerText(), /3s → \d+s/)
  assert.match(await batchDialog.locator('.batch-shots label').first().innerText(), /无前镜视频/)
  await batchDialog.screenshot({ path: join(evidence, '02-dialogue-timing-preview.png') })
  await batchDialog.getByRole('button', { name: '关闭对话框' }).click()
  // Duration preview fixtures remain local: never click Generate or submit to a provider.
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  const timingOriginals = snapshot.state.projects[0].shots.slice(0, 3)
  const timingConfig = snapshot.state.config
  // Exercise pronunciation editing and preflight without submitting a paid task.
  assert((await page.evaluate((config) => window.director.command({ type: 'config', config, key: 'local-test-only-not-a-real-key' }), timingConfig)).ok)
  await page.getByLabel('对白 / 字幕').fill('2026 年去重庆，聊聊 ADHD。')
  await page.getByLabel('说话角色').fill('旁白')
  await page.getByLabel('读音备注（不朗读）').fill('重庆=chóng qìng\n2026=二零二六')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  const pronunciationShot = snapshot.state.projects[0].shots[0]
  assert.equal(pronunciationShot.pronunciationNotes, '重庆=chóng qìng\n2026=二零二六')
  await page.locator('.inspector summary').filter({ hasText: '实际朗读台词预览' }).click()
  assert.equal(await page.locator('.inspector .dialogue-preview-line p').innerText(), '2026 年去重庆，聊聊 ADHD。')
  await page.getByRole('button', { name: '批量', exact: true }).click()
  await batchDialog.locator('summary').filter({ hasText: '台词与读音核对' }).click()
  assert.equal(await batchDialog.locator('.batch-dialogue-list .dialogue-preview-line p').first().innerText(), '2026 年去重庆，聊聊 ADHD。')
  await batchDialog.getByText('读音指导（不朗读）：重庆 → chóng qìng；2026 → 二零二六', { exact: true }).waitFor()
  assert(await batchDialog.getByRole('button', { name: /^确认生成/ }).isEnabled())
  await batchDialog.locator('.batch-dialogue-list section').first().scrollIntoViewIfNeeded()
  await batchDialog.screenshot({ path: join(evidence, '02-dialogue-script-review.png') })
  assert((await page.evaluate(({ projectId, shot }) => window.director.command({ type: 'shot', projectId, shot }),
    { projectId: project.id, shot: { ...pronunciationShot, pronunciationNotes: '无关词语=读音' } })).ok)
  await batchDialog.getByText('1 个镜头的台词设置需要修正，请展开核对。', { exact: true }).waitFor()
  assert(await batchDialog.getByRole('button', { name: /^确认生成/ }).isDisabled())
  await batchDialog.getByRole('button', { name: '关闭对话框' }).click()
  const fitShot = { ...timingOriginals[0], duration: 10, dialogue: '字'.repeat(33) }
  assert((await page.evaluate(({ projectId, shot }) => window.director.command({ type: 'shot', projectId, shot }),
    { projectId: project.id, shot: fitShot })).ok)
  assert((await page.evaluate((config) => window.director.command({ type: 'config', config, key: 'local-test-only-not-a-real-key' }), timingConfig)).ok)
  await page.getByRole('button', { name: '批量', exact: true }).click()
  await batchDialog.getByText('当前模型支持 4–15 秒；对白时长按正常语速估算。').waitFor()
  assert.match(await batchDialog.locator('.batch-shots label').first().innerText(), /10s → 11s/)
  assert.equal(await batchDialog.locator('.batch-timing-alert').count(), 0)
  assert(await batchDialog.getByRole('button', { name: /^确认生成/ }).isEnabled())
  if (await page.getByRole('button', { name: '关闭提示', exact: true }).count())
    await page.getByRole('button', { name: '关闭提示', exact: true }).click()
  await batchDialog.getByText('生成与衔接说明', { exact: true }).click()
  assert(await batchDialog.locator('.batch-generation-details').getAttribute('open') !== null)
  await batchDialog.getByText('生成与衔接说明', { exact: true }).click()
  await batchDialog.screenshot({ path: join(evidence, '02-dialogue-11s-fit.png') })
  for (const changed of [
    { ...timingOriginals[1], duration: 10, dialogue: '字'.repeat(50) },
    { ...timingOriginals[2], duration: 16, dialogue: '' },
  ]) {
    assert((await page.evaluate(({ projectId, shot }) => window.director.command({ type: 'shot', projectId, shot }),
      { projectId: project.id, shot: changed })).ok)
  }
  await batchDialog.getByText('2 个镜头超过当前模型的 15 秒上限，请拆分后生成。').waitFor()
  assert.equal(await batchDialog.locator('.batch-timing-issue').count(), 2)
  assert(await batchDialog.getByRole('button', { name: /^确认生成/ }).isDisabled())
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
  await batchDialog.getByRole('button', { name: '取消选择超限镜头', exact: true }).scrollIntoViewIfNeeded()
  await batchDialog.screenshot({ path: join(evidence, '02-dialogue-over-limit.png') })
  assert(await batchDialog.evaluate((element) => element.scrollWidth <= element.clientWidth))
  await batchDialog.getByRole('button', { name: '取消选择超限镜头', exact: true }).click()
  assert.equal(await batchDialog.locator('.batch-shots input:checked').count(), project.shots.length - 2)
  assert.equal(await batchDialog.locator('.batch-timing-alert').count(), 0)
  assert(await batchDialog.locator('.batch-shots label').first().getByRole('checkbox').isChecked())
  assert(await batchDialog.getByRole('button', { name: /^确认生成/ }).isEnabled())
  assert((await page.evaluate((config) => window.director.command({ type: 'config', config }),
    { ...timingConfig, models: { ...timingConfig.models, video: { provider: 'kling', model: 'kling-v2-6', region: 'cn' } } })).ok)
  await batchDialog.getByText('1 个镜头超过当前模型的 10 秒上限，请拆分后生成。').waitFor()
  assert.match(await batchDialog.locator('.batch-shots label').nth(3).innerText(), /6s → 10s/)
  await batchDialog.getByRole('button', { name: '关闭对话框' }).click()
  assert((await page.evaluate((config) => window.director.command({ type: 'config', config }), timingConfig)).ok)
  assert((await page.evaluate(() => window.director.command({ type: 'clearKey' }))).ok)
  for (const original of timingOriginals) {
    assert((await page.evaluate(({ projectId, shot }) => window.director.command({ type: 'shot', projectId, shot }),
      { projectId: project.id, shot: original })).ok)
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1540, 990))
  const archivedVideo = join(data, 'archived-shot.mp4')
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=24',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', archivedVideo,
  ], { windowsHide: true })
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, archivedVideo)
  assert((await page.evaluate(
    ({ pid, sid }) => window.director.command({ type: 'importMedia', projectId: pid, ownerId: sid, slot: 'video' }),
    { pid: project.id, sid: shot.id },
  )).ok)
  assert((await page.evaluate(
    ({ pid, sid }) => window.director.command({ type: 'importMedia', projectId: pid, ownerId: sid, slot: 'video' }),
    { pid: project.id, sid: project.shots[2].id },
  )).ok)
  await page.getByRole('button', { name: '批量', exact: true }).click()
  const boundaryRows = batchDialog.locator('.batch-shots label')
  for (let index = 0; index < await boundaryRows.count(); index++) {
    if (index !== 1) await boundaryRows.nth(index).getByRole('checkbox').uncheck()
  }
  assert.match(await boundaryRows.nth(1).innerText(), /视频尾帧/)
  assert.match(await boundaryRows.nth(1).innerText(), /保留视频首帧/)
  await batchDialog.screenshot({ path: join(evidence, '02-partial-regeneration-boundaries.png') })
  await batchDialog.getByRole('button', { name: '关闭对话框' }).click()
  await page.getByRole('button', { name: 'AI 拆解分镜' }).click()
  const storyboardDialog = page.getByRole('dialog', { name: 'AI 生成分镜' })
  await storyboardDialog.waitFor()
  assert.equal(await storyboardDialog.getByRole('button', { name: '生成分镜' }).count(), 1)
  assert.equal(await storyboardDialog.getByRole('button', { name: '复制并打开 ChatGPT' }).count(), 0)
  assert.equal(await storyboardDialog.getByText('发送给 ChatGPT 的提示词').count(), 0)
  await storyboardDialog.getByRole('textbox', { name: '补充创作要求（可选）' }).fill('突出线索出现的悬念。')
  await storyboardDialog.screenshot({ path: join(evidence, '02-storyboard-generator.png') })
  await storyboardDialog.getByRole('button', { name: '关闭', exact: true }).click()
  const soleEpisodeRemoval = await page.evaluate(
    ({ projectId, episodeId }) =>
      window.director.command({ type: 'deleteEpisode', projectId, episodeId }),
    { projectId: project.id, episodeId: project.episodes[0].id },
  )
  assert.equal(soleEpisodeRemoval.ok, false)
  assert.match(soleEpisodeRemoval.error, /至少需要保留一集/)
  await page.getByRole('button', { name: '剧本 01' }).click()
  const accountStatus = await page.evaluate(() => window.director.command({ type: 'codexStatus' }))
  assert(accountStatus.ok, accountStatus.error)
  await page.getByText('正在检查账号…').waitFor({ state: 'hidden' })
  assert.equal(
    (await page.getByLabel('剧本正文').getAttribute('placeholder')).includes('&#10;'),
    false,
  )
  await page.getByLabel('剧本正文').fill('这是经过桌面 UI 修改并保存的剧本。')
  await page.getByRole('button', { name: '保存剧本', exact: true }).click()
  await page.getByRole('button', { name: '已保存', exact: true }).waitFor()
  await page.screenshot({ path: join(evidence, '03-script-editor.png') })
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  assert.equal(snapshot.state.projects[0].shots.length, 0)
  assert.equal(snapshot.state.projects[0].scriptArchives.length, 1)
  assert(snapshot.state.projects[0].scriptArchives[0].shots[0].videoMediaId)
  await page.getByRole('button', { name: '剧本与视频存档' }).click()
  const scriptArchiveDialog = page.getByRole('dialog', { name: '剧本与视频存档' })
  await scriptArchiveDialog.getByText('旧版剧本').waitFor()
  assert.match(await scriptArchiveDialog.locator('.script-archive-text').innerText(), /深夜，林舟/)
  assert.match(await scriptArchiveDialog.locator('video').getAttribute('src'), /^media:\/\/asset\//)
  await scriptArchiveDialog.screenshot({ path: join(evidence, '03-script-video-archive.png') })
  await scriptArchiveDialog.getByRole('button', { name: '关闭对话框' }).click()
  assert.equal(await page.getByRole('button', { name: '导入 TXT / MD / DOCX' }).count(), 0)
  assert.equal(await page.getByText('创作路线').count(), 0)
  await page.getByLabel('发送到当前集').fill('把结尾改成悬念。')
  assert(await page.getByRole('button', { name: '发送给 AI 编剧' }).isEnabled())
  const append = async (role, text, script, episodeId = project.episodes[0].id, analysis) =>
    page.evaluate(
      async ({ projectId, episodeId, role, text, script, analysis }) =>
        window.director.command({
          type: 'scriptChat',
          projectId,
          episodeId,
          turn: {
            id: crypto.randomUUID(),
            role,
            text,
            ...(script ? { script } : {}),
            ...(analysis ? { analysis } : {}),
            createdAt: new Date().toISOString(),
          },
        }),
      { projectId: project.id, episodeId, role, text, script, analysis },
    )
  assert((await append('user', '把结尾改成悬念。')).ok)
  assert((await append('assistant', '已加强悬念。', '新版悬念剧本。')).ok)
  await page.getByLabel('对话记录').getByText('把结尾改成悬念。', { exact: true }).waitFor()
  await page.getByText('已加强悬念。').waitFor()
  const firstDraft = page.locator('.script-chat-turn').filter({ hasText: '已加强悬念。' })
  const polishOptions = firstDraft.getByRole('region', { name: 'AI 润色选项' })
  await polishOptions.getByText('要润色这版剧本吗？').waitFor()
  assert.equal(await polishOptions.locator('.script-polish-direction').count(), 2)
  assert(await polishOptions.getByRole('button', { name: '按自定义方向润色' }).isDisabled())
  await polishOptions.getByLabel('自定义润色方向').fill('保留结局，让对白更克制。')
  assert(await polishOptions.getByRole('button', { name: '按自定义方向润色' }).isEnabled())
  await polishOptions.screenshot({ path: join(evidence, '03-script-polish-options.png') })
  await polishOptions.getByRole('button', { name: '不润色', exact: true }).click()
  await firstDraft.getByText('已选择不润色，保留此版').waitFor()
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  assert.equal(snapshot.state.projects[0].episodes[0].scriptChat[1].polishSkipped, true)
  assert.equal(snapshot.state.aiTasks.length, 0)
  assert.notEqual(snapshot.state.projects[0].episodes[0].script, '新版悬念剧本。')
  await firstDraft.getByRole('button', { name: '重新选择' }).click()
  await polishOptions.getByText('要润色这版剧本吗？').waitFor()
  await page.getByRole('button', { name: '应用到剧本' }).click()
  await page.waitForFunction(
    () => document.querySelector('[aria-label="剧本正文"]')?.value === '新版悬念剧本。',
  )
  assert.equal(await page.getByLabel('剧本正文').inputValue(), '新版悬念剧本。')
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  assert.equal(snapshot.state.projects[0].episodes[0].script, '新版悬念剧本。')
  assert.equal(snapshot.state.projects[0].episodes[0].scriptChat.length, 2)
  assert.equal(snapshot.state.projects[0].scriptArchives.length, 2)
  await page.getByRole('button', { name: '添加分集' }).click()
  await page.getByLabel('集名称').fill('第二集')
  await page.getByRole('button', { name: '创建分集' }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.waitForFunction(
    () => document.querySelector('.script-episode-switch span')?.textContent?.trim() === '2 / 2',
  )
  await page.getByLabel('剧本正文').fill('第二集未手动保存的草稿。')
  await page.getByRole('button', { name: '上一集' }).click()
  await page.waitForFunction(
    () => document.querySelector('.script-episode-switch span')?.textContent?.trim() === '1 / 2',
  )
  await page.waitForFunction(
    () => document.querySelector('[aria-label="剧本正文"]')?.value === '新版悬念剧本。',
  )
  assert.equal(await page.getByLabel('剧本正文').inputValue(), '新版悬念剧本。')
  await page.getByRole('button', { name: '下一集' }).click()
  try {
    await page.waitForFunction(
      () => document.querySelector('[aria-label="剧本正文"]')?.value === '第二集未手动保存的草稿。',
    )
  } catch (error) {
    const state = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
    console.error('Episode switch state:', await page.getByLabel('剧本正文').inputValue(), state.state.projects[0].episodes.map((episode) => [episode.title, episode.script]))
    throw error
  }
  assert.equal(await page.getByLabel('剧本正文').inputValue(), '第二集未手动保存的草稿。')
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  const secondEpisode = snapshot.state.projects[0].episodes[1]
  assert.equal(secondEpisode.script, '第二集未手动保存的草稿。')
  await page.getByRole('button', { name: '添加分集' }).click()
  await page.getByLabel('集名称').fill('临时第三集')
  await page.getByRole('button', { name: '创建分集' }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByLabel('剧本正文').fill('准备移除的草稿。')
  await page.locator('.episode-nav').getByRole('button', { name: '移除分集 临时第三集' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '确认' }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.waitForFunction(
    () => document.querySelector('[aria-label="剧本正文"]')?.value === '第二集未手动保存的草稿。',
  )
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  assert.equal(snapshot.state.projects[0].episodes.length, 2)
  assert.equal(snapshot.state.projects[0].episodes[1].id, secondEpisode.id)
  assert.equal(await page.locator('.project-note .nav-remove').count(), 0)
  await page.locator('.sidebar').screenshot({ path: join(evidence, '03-sidebar-node-removal.png') })
  assert((await append('user', '第二集问题', undefined, secondEpisode.id)).ok)
  assert(
    (
      await append(
        'assistant',
        '第二集 AI 回复',
        '第二集 AI 剧本。',
        secondEpisode.id,
        '保留人物目标，加强冲突。',
      )
    ).ok,
  )
  await page.getByRole('button', { name: '上一集' }).click()
  await page.getByLabel('对话记录').getByText('第二集 AI 回复').waitFor()
  await page.getByText('保留人物目标，加强冲突。').waitFor()
  await page
    .locator('.script-chat-turn')
    .filter({ hasText: '第二集 AI 回复' })
    .getByRole('button', { name: '应用到剧本' })
    .click()
  await page.waitForFunction(
    () => document.querySelector('[aria-label="剧本正文"]')?.value === '第二集 AI 剧本。',
  )
  assert.equal(await page.getByLabel('剧本正文').inputValue(), '第二集 AI 剧本。')
  await page.getByLabel('发送到当前集').fill('')
  const attachment = join(data, 'reference.xyz')
  await writeFile(attachment, '一个未知扩展名的故事参考文件。')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async (_window, options) => {
      if (options.filters !== undefined) throw new Error('File picker unexpectedly filters types')
      return { canceled: false, filePaths: [file] }
    }
  }, attachment)
  await page.getByRole('button', { name: '添加文件' }).click()
  await page.locator('.script-chat-files.pending').getByText('reference.xyz').waitFor()
  assert(await page.getByRole('button', { name: '发送给 AI 编剧' }).isEnabled())

  // Generation lifecycle is tested against a fake Codex process in plugin.mjs.
  // This desktop check preserves an unsent draft and files across all page tabs.
  await page.getByLabel('发送到当前集').fill('切换页签后保留创作要求。')
  for (const tab of ['资产库 02', '导演台 03', '成片 04']) {
    await page.getByRole('button', { name: tab }).click()
    assert.equal(await page.getByLabel('AI 编剧对话').isVisible(), false)
    await page.getByRole('button', { name: '剧本 01' }).click()
    assert.equal(await page.getByLabel('发送到当前集').inputValue(), '切换页签后保留创作要求。')
    await page.locator('.script-chat-files.pending').getByText('reference.xyz').waitFor()
    await page.getByLabel('对话记录').getByText('第二集 AI 回复').waitFor()
  }
  await page.screenshot({ path: join(evidence, '03-script-chat-draft-after-tabs.png') })
  await page.getByLabel('发送到当前集').fill('')
  await page.getByRole('button', { name: '移除附件 reference.xyz' }).click()
  await page.locator('.script-chat').screenshot({ path: join(evidence, '03-script-chat.png') })
  await page.getByRole('button', { name: '资产库 02' }).click()
  await page.getByRole('heading', { name: '让每次生成，都属于同一个世界。' }).waitFor()
  await page.screenshot({ path: join(evidence, '04-assets.png') })
  const assetFixture = join(data, 'uploaded-character.png')
  await writeFile(
    assetFixture,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, assetFixture)
  await page.getByRole('button', { name: '上传资产图片' }).click()
  await page.getByRole('dialog', { name: '上传资产图片' }).getByRole('combobox', { name: '类型' }).selectOption('location')
  await page.getByRole('button', { name: '选择图片上传' }).click()
  await page.getByRole('dialog', { name: '上传资产图片' }).waitFor({ state: 'hidden' })
  await page.locator('.asset-card').filter({ hasText: 'uploaded-character' }).waitFor()
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  const uploadedAsset = snapshot.state.projects[0].assets.find((a) => a.name === 'uploaded-character')
  assert.equal(uploadedAsset.kind, 'location')
  assert(snapshot.state.projects[0].media.some((m) => m.id === uploadedAsset.selectedMediaId))
  assert.equal(
    await page.evaluate(
      ({ pid, mid }) =>
        new Promise((resolve) => {
          const image = new Image()
          image.onload = () => resolve(image.naturalWidth)
          image.onerror = () => resolve(0)
          image.src = `media://asset/${pid}/${mid}`
        }),
      { pid: project.id, mid: uploadedAsset.selectedMediaId },
    ),
    1,
  )
  await page.screenshot({ path: join(evidence, '04-assets-upload.png') })
  await page.getByRole('button', { name: '连接与设置', exact: true }).click()
  await page.getByRole('dialog', { name: '连接与偏好设置' }).waitFor()
  assert.equal(await page.getByRole('tab', { name: '文字模型' }).count(), 1)
  assert.equal(await page.getByRole('tab', { name: '图片模型' }).count(), 1)
  await page.getByRole('tab', { name: '视频模型' }).click()
  assert.equal(await page.getByText('ChatGPT 浏览器 · 图片辅助').count(), 0)
  assert.equal(await page.getByRole('textbox', { name: 'FFmpeg 可执行文件' }).count(), 0)
  assert.equal(await page.getByText('已内置指定工作流，使用 RunningHub 中国站。只接受消耗 RH币的消费级会员 Key，不使用钱包余额。').count(), 1)
  const mode = page.getByRole('combobox', { name: '视频生成模式' })
  assert.equal(await mode.inputValue(), 'plus')
  await mode.selectOption('default')
  await page.getByRole('combobox', { name: '视频清晰度' }).selectOption('768p')
  await page.getByRole('button', { name: '保存设置' }).click()
  assert.equal((await page.evaluate(() => window.director.command({ type: 'snapshot' }))).state.config.instanceType, 'default')
  assert.equal((await page.evaluate(() => window.director.command({ type: 'snapshot' }))).state.config.videoResolution, '768p')
  await page.getByRole('button', { name: '连接与设置', exact: true }).click()
  await page.getByRole('tab', { name: '视频模型' }).click()
  assert.equal(await page.getByRole('combobox', { name: '视频生成模式' }).inputValue(), 'default')
  assert.equal(await page.getByRole('combobox', { name: '视频清晰度' }).inputValue(), '768p')
  assert.equal(await page.getByRole('textbox', { name: 'Workflow ID' }).count(), 0)
  assert.equal(await page.getByText('参数映射').count(), 0)
  await page.screenshot({ path: join(evidence, '05-provider-settings.png') })
  for (const [channel, providers] of [
    ['文字模型', ['kimi', 'glm', 'doubao', 'minimax', 'xai', 'mistral', 'hunyuan', 'ernie', 'stepfun']],
    ['图片模型', ['doubao', 'minimax', 'xai', 'bfl', 'glm']],
    ['视频模型', ['doubao', 'xai']],
  ]) {
    await page.getByRole('tab', { name: channel }).click()
    for (const provider of providers) {
      await page.getByRole('combobox', { name: '服务商' }).selectOption(provider)
      assert.equal(await page.getByLabel(/^API Key/).inputValue(), '')
      assert(await page.getByLabel('模型 ID').inputValue())
      if (channel === '视频模型') {
        assert.equal(await page.getByLabel('模型 ID').evaluate((select) => select.tagName), 'SELECT')
        assert(await page.getByText(/此接入不继承上一镜头音轨或多参考图/).isVisible())
      }
    }
    await page.screenshot({ path: join(evidence, `05-expanded-${channel}.png`) })
  }
  await page.getByRole('tab', { name: '文字模型' }).click()
  await page.getByRole('combobox', { name: '服务商' }).selectOption('deepseek')
  await page.getByLabel(/^API Key/).fill('fixture-text-channel-key')
  await page.screenshot({ path: join(evidence, '05-text-model.png') })
  await page.getByRole('tab', { name: '图片模型' }).click()
  await page.getByRole('combobox', { name: '服务商' }).selectOption('openai')
  assert.equal(await page.getByLabel(/^API Key/).inputValue(), '')
  await page.getByLabel(/^API Key/).fill('fixture-image-channel-key')
  await page.screenshot({ path: join(evidence, '05-image-model.png') })
  await page.getByRole('tab', { name: '视频模型' }).click()
  await page.getByRole('combobox', { name: '服务商' }).selectOption('kling')
  await page.getByLabel(/^API Key \/ Access Key/).fill('fixture-video-channel-key')
  await page.getByLabel(/^Secret Key/).fill('fixture-video-secret-key')
  await page.screenshot({ path: join(evidence, '05-video-model.png') })
  await page.getByRole('button', { name: '保存设置' }).click()
  const modelState = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  assert.equal(modelState.state.config.models.text.provider, 'deepseek')
  assert.equal(modelState.state.config.models.image.provider, 'openai')
  assert.equal(modelState.state.config.models.video.provider, 'kling')
  assert.equal(modelState.state.credentials['text:deepseek:cn'], true)
  assert.equal(modelState.state.credentials['image:openai:cn'], true)
  assert.equal(modelState.state.credentials['video:kling:cn'], true)
  assert.equal(modelState.state.credentials['text:openai:cn'], false)
  assert.equal(JSON.stringify(modelState).includes('fixture-'), false)
  assert((await page.evaluate((config) => window.director.command({ type: 'config', config: { ...config, models: {
    text: { provider: 'chatgpt', model: '', region: 'cn' }, image: { provider: 'chatgpt', model: '', region: 'cn' }, video: { provider: 'runninghub', model: '', region: 'cn' },
  } } }), modelState.state.config)).ok)
  await page.getByRole('button', { name: '连接与设置', exact: true }).click()
  await page.getByRole('dialog', { name: '连接与偏好设置' }).waitFor()

  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
  await page.locator('.episode-nav .nav-select').first().click()
  await page.getByRole('button', { name: '导演台 03' }).click()
  await page.getByText('当前导演台使用新版剧本，请从剧本拆解分镜：').waitFor()
  await page.screenshot({ path: join(evidence, '05-updated-director-script.png') })
  await page.getByRole('button', { name: '镜头', exact: true }).click()
  await page.locator('.shot-list article').first().click()
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  const currentShot = snapshot.state.projects[0].shots.find((item) => item.episodeId === project.episodes[0].id)
  assert(currentShot)
  await page.getByRole('button', { name: '素材与版本' }).click()
  await page.getByRole('button', { name: 'AI 生图' }).first().click()
  const imageDialog = page.getByRole('dialog', { name: /AI 生图/ })
  await imageDialog.waitFor()
  assert.equal(await imageDialog.getByRole('button', { name: '在软件中直接生成图片' }).count(), 1)
  assert.equal(await imageDialog.getByRole('button', { name: '复制并打开 ChatGPT' }).count(), 0)
  await imageDialog.screenshot({ path: join(evidence, '05-direct-image-generation.png') })
  await imageDialog.getByRole('button', { name: '完成 / 关闭' }).click()
  const fixture = join(data, 'test.png')
  await writeFile(
    fixture,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, fixture)
  const imported = await page.evaluate(
    async ({ pid, sid }) =>
      window.director.command({ type: 'importMedia', projectId: pid, ownerId: sid, slot: 'first' }),
    { pid: project.id, sid: currentShot.id },
  )
  assert(imported.ok)
  const mediaId = imported.state.projects[0].media.find((m) => m.ownerId === currentShot.id && m.slot === 'first').id
  const load = await page.evaluate(
    async ({ pid, mid }) =>
      new Promise((resolve) => {
        const image = new Image()
        image.onload = () => resolve(image.naturalWidth)
        image.onerror = () => resolve(0)
        image.src = `media://asset/${pid}/${mid}`
      }),
    { pid: project.id, mid: mediaId },
  )
  assert.equal(load, 1)
  const archive = join(data, 'test.director.zip')
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, archive)
  const saved = await page.evaluate(
    async (pid) => window.director.command({ type: 'exportArchive', projectId: pid }),
    project.id,
  )
  assert(saved.ok, saved.error)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, archive)
  const restored = await page.evaluate(() => window.director.command({ type: 'importArchive' }))
  assert(restored.ok, restored.error)
  assert.equal(restored.state.projects.length, 2)
  assert.equal(restored.state.projects[0].media.length, saved.state.projects.find((item) => item.id === project.id).media.length)
  const restoredProject = restored.state.projects.find((item) => item.id !== project.id)
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => { throw new Error('Project removal must not open a backup dialog') }
  })
  await page.locator('.project-nav').getByRole('button', { name: restoredProject.title, exact: true }).click()
  await page.locator('.project-nav').getByRole('button', { name: `移除项目 ${restoredProject.title}` }).click()
  await page.getByRole('dialog').getByRole('button', { name: '确认' }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  assert.equal(snapshot.state.projects.length, 1)
  assert.equal(snapshot.state.projects[0].id, project.id)
  assert((await stat(join(data, 'library', 'projects', restoredProject.id, restoredProject.media[0].file))).size > 0)
  await page
    .getByRole('group', { name: '界面主题' })
    .getByRole('button', { name: '深色 · Graphite' })
    .click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await page.screenshot({ path: join(evidence, '06-dark-theme.png') })
  await page.getByRole('group', { name: '界面语言' }).getByRole('button', { name: 'EN' }).click()
  await page.getByRole('heading', { name: 'Turn your story into images.' }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en')
  assert.equal(await page.title(), 'Muweave · AI Director Board')
  await page.screenshot({ path: join(evidence, '07-english-dark.png') })
  await page.getByRole('button', { name: 'Connections & settings', exact: true }).click()
  await page.getByRole('dialog', { name: 'Connections & preferences' }).waitFor()
  await page.screenshot({ path: join(evidence, '08-english-settings.png') })
  assert.equal(await page.getByRole('combobox', { name: 'Interface language' }).inputValue(), 'en')
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Script 01' }).click()
  await page.getByRole('heading', { name: 'Every shot starts with a good story.' }).waitFor()
  await page.screenshot({ path: join(evidence, '09-english-script.png') })
  await page.getByRole('button', { name: 'Assets 02' }).click()
  await page.getByRole('heading', { name: 'Keep every generation in the same world.' }).waitFor()
  await page.screenshot({ path: join(evidence, '10-english-assets.png') })
  await page.getByRole('button', { name: 'Final cut 04' }).click()
  await page.getByRole('heading', { name: 'Bring your shots together into a story.' }).waitFor()
  await page.screenshot({ path: join(evidence, '11-english-cut.png') })
  const previewShots = [0, 1].map((index) => ({
    ...project.shots[index],
    id: crypto.randomUUID(),
    episodeId: secondEpisode.id,
    title: `Preview shot ${index + 1}`,
    duration: 1,
    firstMediaId: undefined,
    lastMediaId: undefined,
    videoMediaId: undefined,
    audioMediaId: undefined,
  }))
  for (const previewShot of previewShots) {
    const result = await page.evaluate(
      ({ pid, shot }) => window.director.command({ type: 'shot', projectId: pid, shot }),
      { pid: project.id, shot: previewShot },
    )
    assert(result.ok, result.error)
  }
  for (let index = 0; index < previewShots.length; index++) {
    const video = join(data, `preview-${index}.mp4`)
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i',
      `color=c=${index ? 'blue' : 'red'}:s=320x180:r=24`,
      '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video,
    ], { windowsHide: true })
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, video)
    const importedVideo = await page.evaluate(
      ({ pid, sid }) => window.director.command({ type: 'importMedia', projectId: pid, ownerId: sid, slot: 'video' }),
      { pid: project.id, sid: previewShots[index].id },
    )
    assert(importedVideo.ok, importedVideo.error)
  }
  await page.locator('.episode-nav .nav-select').nth(1).click()
  await page.getByText('The preview uses the same shot order, aspect ratio, durations, and audio as the MP4 export.').waitFor({ timeout: 60000 })
  await page.waitForFunction(() => {
    const video = document.querySelector('.review-player video')
    return video && Number.isFinite(video.duration) && video.duration >= 1.9
  })
  assert.match(await page.locator('.review-player video').getAttribute('src'), /^media:\/\/preview\//)
  await page.locator('.review-player video').evaluate(async (video) => {
    video.currentTime = 0
    await video.play()
  })
  await page.waitForFunction(() => {
    const video = document.querySelector('.review-player video')
    return video && video.currentTime >= 1.2 && !video.seeking && video.readyState >= 2
  })
  await page.getByText('Preview shot 2', { exact: true }).first().waitFor()
  await page.screenshot({ path: join(evidence, '11-stitched-preview.png') })
  await page.locator('.episode-nav .nav-select').first().click()
  await page.getByRole('button', { name: 'Task center', exact: true }).first().click()
  await page.getByRole('dialog', { name: 'Task center' }).waitFor()
  await page.screenshot({ path: join(evidence, '12-english-tasks.png') })
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Director board 03' }).click()
  await page.getByRole('button', { name: 'AI storyboard' }).click()
  const englishStoryboard = page.getByRole('dialog', { name: 'AI storyboard generation' })
  await englishStoryboard.getByRole('button', { name: 'Generate shots' }).waitFor()
  await englishStoryboard.getByRole('button', { name: 'Close', exact: true }).click()
  await page
    .getByRole('group', { name: 'Interface theme' })
    .getByRole('button', { name: 'Light · Warm paper' })
    .click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.screenshot({ path: join(evidence, '13-english-light.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
  await page.screenshot({ path: join(evidence, '14-compact-desktop.png') })
  await page.getByRole('button', { name: 'Script', exact: true }).click()
  await page.screenshot({ path: join(evidence, '14-compact-script.png') })
  assert(
    await page
      .locator('.script-chat')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  )
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  )
  // Old installations may still have the retired global pause flag saved.
  assert((await page.evaluate(() => window.director.command({ type: 'pause', paused: true }))).ok)
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await page.waitForFunction(() => !!window.director)
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  assert(snapshot.ok)
  assert.equal(snapshot.state.config.paused, false)
  assert.equal(snapshot.state.projects.length, 1)
  assert.equal(snapshot.state.projects.find((p) => p.id === project.id).scriptArchives[0].shots[0].title,
    '桌面测试 · 已保存的镜头')
  assert.equal(
    snapshot.state.projects.find((p) => p.id === project.id).episodes[0].scriptChat.length,
    2,
  )
  assert.equal(
    snapshot.state.projects.find((p) => p.id === project.id).episodes[1].script,
    '第二集 AI 剧本。',
  )
  assert.equal(snapshot.state.credentials['text:deepseek:cn'], true)
  assert.equal(snapshot.state.credentials['image:openai:cn'], true)
  assert.equal(snapshot.state.credentials['video:kling:cn'], true)
  assert.equal(snapshot.state.config.theme, 'light')
  assert.equal(snapshot.state.config.locale, 'en')
  const secret = 'local-test-only-not-a-real-key'
  const credential = await page.evaluate(
    ({ config, key }) => window.director.command({ type: 'config', config, key }),
    { config: snapshot.state.config, key: secret },
  )
  assert(credential.ok)
  assert.equal(credential.state.hasKey, true)
  assert.equal(JSON.stringify(credential.state).includes(secret), false)
  await page.evaluate(() => window.director.command({ type: 'clearKey' }))
  await app.close()
  assert.deepEqual(errors, [])
  await writeFile(
    join(evidence, 'desktop-results.json'),
    JSON.stringify(
      {
        passed: true,
        checks: [
          'welcome',
          'default list and canvas switch',
          '3D previs camera and object keyframes, screenshots, silent MP4, cancellation and compact layout',
          'direct AI storyboard generation dialog',
          'shot edit',
          'bulk asset linking and director settings at 1120px',
          'video batch select all and clear selection',
          '11 second dialogue fit, adapter duration limits, all timing blockers and selective deselection',
          'mixed task ordering, record deletion, stop all without pausing and no pause button',
          'script edit',
          'script and video archive on script revision',
          'episode switching and unsaved draft persistence',
          'project-wide chat and cross-episode script apply',
          'any-extension attachment picker',
          'assets',
          'asset image upload',
          'settings',
          'language and theme switching',
          'media import and protocol',
          'stitched episode preview and timeline seeking',
          'archive roundtrip',
          'project removal without backup prompt',
          'dark mode',
          '1120px desktop',
          'restart persistence and legacy global pause removal',
          'OS-encrypted key and redacted snapshot',
        ],
        errors,
        data,
        executable: process.env.DIRECTOR_EXECUTABLE || 'development Electron',
      },
      null,
      2,
    ),
  )
  console.log('Desktop verification passed. Evidence: ' + evidence)
} catch (error) {
  await page.screenshot({ path: join(evidence, 'desktop-failure.png') }).catch(() => {})
  await writeFile(join(evidence, 'desktop-failure.html'), await page.content()).catch(() => {})
  throw error
} finally {
  await app.close().catch(() => {})
}
