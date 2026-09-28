import { _electron as electron } from 'playwright'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

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
  await page.getByRole('button', { name: 'AI 拆解分镜' }).click()
  const storyboardDialog = page.getByRole('dialog', { name: 'AI 生成分镜' })
  await storyboardDialog.waitFor()
  assert.equal(await storyboardDialog.getByRole('button', { name: '生成分镜' }).count(), 1)
  assert.equal(await storyboardDialog.getByRole('button', { name: '复制并打开 ChatGPT' }).count(), 0)
  assert.equal(await storyboardDialog.getByText('发送给 ChatGPT 的提示词').count(), 0)
  await storyboardDialog.getByRole('textbox', { name: '补充创作要求（可选）' }).fill('突出线索出现的悬念。')
  await storyboardDialog.screenshot({ path: join(evidence, '02-storyboard-generator.png') })
  await storyboardDialog.getByRole('button', { name: '取消' }).click()
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
  await page.getByRole('button', { name: '应用到剧本' }).click()
  await page.waitForFunction(
    () => document.querySelector('[aria-label="剧本正文"]')?.value === '新版悬念剧本。',
  )
  assert.equal(await page.getByLabel('剧本正文').inputValue(), '新版悬念剧本。')
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  assert.equal(snapshot.state.projects[0].episodes[0].script, '新版悬念剧本。')
  assert.equal(snapshot.state.projects[0].episodes[0].scriptChat.length, 2)
  await page.getByRole('button', { name: '添加分集' }).click()
  await page.getByLabel('集名称').fill('第二集')
  await page.getByRole('button', { name: '创建分集' }).click()
  await page.getByLabel('剧本正文').fill('第二集未手动保存的草稿。')
  await page.getByRole('button', { name: '上一集' }).click()
  await page.waitForFunction(
    () => document.querySelector('[aria-label="剧本正文"]')?.value === '新版悬念剧本。',
  )
  assert.equal(await page.getByLabel('剧本正文').inputValue(), '新版悬念剧本。')
  await page.getByRole('button', { name: '下一集' }).click()
  await page.waitForFunction(
    () => document.querySelector('[aria-label="剧本正文"]')?.value === '第二集未手动保存的草稿。',
  )
  assert.equal(await page.getByLabel('剧本正文').inputValue(), '第二集未手动保存的草稿。')
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  const secondEpisode = snapshot.state.projects[0].episodes[1]
  assert.equal(secondEpisode.script, '第二集未手动保存的草稿。')
  await page.getByRole('button', { name: '添加分集' }).click()
  await page.getByLabel('集名称').fill('临时第三集')
  await page.getByRole('button', { name: '创建分集' }).click()
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
  await page.screenshot({ path: join(evidence, '05-provider-settings.png') })
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
  await page.getByRole('button', { name: '导演台 03' }).click()
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
    { pid: project.id, sid: shot.id },
  )
  assert(imported.ok)
  const mediaId = imported.state.projects[0].media.find((m) => m.ownerId === shot.id && m.slot === 'first').id
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
  assert.equal(restored.state.projects[0].media.length, 2)
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
  await page.getByRole('button', { name: 'Task center', exact: true }).first().click()
  await page.getByRole('dialog', { name: 'Task center' }).waitFor()
  await page.screenshot({ path: join(evidence, '12-english-tasks.png') })
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Director board 03' }).click()
  await page.getByRole('button', { name: 'AI storyboard' }).click()
  const englishStoryboard = page.getByRole('dialog', { name: 'AI storyboard generation' })
  await englishStoryboard.getByRole('button', { name: 'Generate shots' }).waitFor()
  await englishStoryboard.getByRole('button', { name: 'Cancel' }).click()
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
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await page.waitForFunction(() => !!window.director)
  snapshot = await page.evaluate(() => window.director.command({ type: 'snapshot' }))
  assert(snapshot.ok)
  assert.equal(snapshot.state.projects.length, 1)
  assert.equal(
    snapshot.state.projects.find((p) => p.id === project.id).shots[0].title,
    '桌面测试 · 已保存的镜头',
  )
  assert.equal(
    snapshot.state.projects.find((p) => p.id === project.id).episodes[0].scriptChat.length,
    2,
  )
  assert.equal(
    snapshot.state.projects.find((p) => p.id === project.id).episodes[1].script,
    '第二集 AI 剧本。',
  )
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
          'direct AI storyboard generation dialog',
          'shot edit',
          'script edit',
          'episode switching and unsaved draft persistence',
          'project-wide chat and cross-episode script apply',
          'any-extension attachment picker',
          'assets',
          'asset image upload',
          'settings',
          'language and theme switching',
          'media import and protocol',
          'archive roundtrip',
          'project removal without backup prompt',
          'dark mode',
          '1120px desktop',
          'restart persistence',
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
} finally {
  await app.close().catch(() => {})
}
