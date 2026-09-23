import { _electron as electron } from 'playwright'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
  await page.locator('.canvas-card').first().waitFor()
  await page.screenshot({ path: join(evidence, '02-director-canvas.png') })
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
  await page.getByRole('button', { name: '剧本 01' }).click()
  await page.getByLabel('剧本正文').fill('这是经过桌面 UI 修改并保存的剧本。')
  await page.getByRole('button', { name: '保存剧本', exact: true }).click()
  await page.getByRole('button', { name: '已保存', exact: true }).waitFor()
  await page.screenshot({ path: join(evidence, '03-script-editor.png') })
  await page.getByRole('button', { name: '资产库 02' }).click()
  await page.getByRole('heading', { name: '让每次生成，都属于同一个世界。' }).waitFor()
  await page.screenshot({ path: join(evidence, '04-assets.png') })
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
  const mediaId = imported.state.projects[0].media[0].id
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
  assert.equal(restored.state.projects[0].media.length, 1)
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
  await page
    .getByRole('group', { name: 'Interface theme' })
    .getByRole('button', { name: 'Light · Warm paper' })
    .click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.screenshot({ path: join(evidence, '13-english-light.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
  await page.screenshot({ path: join(evidence, '14-compact-desktop.png') })
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
  assert.equal(snapshot.state.projects.length, 2)
  assert.equal(
    snapshot.state.projects.find((p) => p.id === project.id).shots[0].title,
    '桌面测试 · 已保存的镜头',
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
          'canvas',
          'shot edit',
          'script edit',
          'assets',
          'settings',
          'language and theme switching',
          'media import and protocol',
          'archive roundtrip',
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
