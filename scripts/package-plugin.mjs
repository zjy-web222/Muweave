import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { zipSync } from 'fflate'
import { pluginTools, pluginVersion, studioUri } from '../dist/main/plugin-contract.js'
import { studioHtml } from '../dist/main/plugin-server.js'

const root = resolve('.'), output = resolve('release/muweave-plugin')
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
if (version !== pluginVersion) throw new Error('插件与软件版本不一致')
const files = {}
const put = async (path, value) => {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value
  files[path] = bytes
  await mkdir(dirname(resolve(output, path)), { recursive: true })
  await writeFile(resolve(output, path), bytes)
}
const json = (value) => JSON.stringify(value, null, 2) + '\n'
const description = '剧本、人物场景资产、连续分镜视频与成片导出，使用本机幕织项目库。'
const presentation = { displayName: 'Muweave 幕织 Studio', shortDescription: description,
  developerName: 'Muweave', category: 'Design', capabilities: ['Read', 'Write'],
  defaultPrompt: ['打开幕织 Studio', '帮我写一集剧本并保存到幕织', '把这集剧本拆成连续分镜'],
  composerIcon: './assets/muweave-mark.png', logo: './assets/muweave-mark.png' }
await put('plugin.json', json({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'muweave', version, description, author: { name: 'Muweave' },
  extensions: { 'com.openai': { interface: presentation } } }))
await put('.codex-plugin/plugin.json', json({ name: 'muweave', version, description,
  author: { name: 'Muweave' }, skills: './skills/', mcpServers: './.mcp.json', interface: presentation }))
const servers = { muweave: { command: 'node', args: [resolve(output, 'service/muweave.mjs')] } }
await put('.mcp.json', json({ mcpServers: servers }))
await put('mcp.json', json({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: { muweave: { type: 'stdio', ...servers.muweave } } }))
const actions = pluginTools.map((tool) => ({ id: tool.name.replace(/^muweave_/, '').replaceAll('_', '-'),
  title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
  effect: tool.annotations.readOnlyHint ? 'read' : 'write' }))
await put('ipollowork.plugin.json', json({ schemaVersion: 2, id: 'muweave', name: '幕织 Studio',
  description, category: '设计与创作', defaultEnabled: true,
  source: { format: 'ipollowork-extension-manifest', origin: 'local', trusted: false },
  package: { version, publisher: { id: 'muweave', name: 'Muweave' },
    compatibility: { ipollowork: '>=0.21.0' }, updateId: 'muweave/studio' },
  icon: { src: 'assets/muweave-mark.png' }, composer: { prompt: '打开幕织 Studio，创作剧本、资产与连续分镜。' },
  permissions: [
    { id: 'network', reason: '连接本机幕织 Studio 服务，由原有队列运行用户授权的 RunningHub 任务。' },
    { id: 'workspace-read', reason: '导入用户选择的工作区图片、剧本、视频或项目 ZIP。' },
    { id: 'process', reason: '启动本机幕织运行环境，复用已打开的幕织进程。' },
  ],
  resources: [
    { type: 'ui', id: 'studio', label: '幕织 Studio', path: 'ui/studio.html', required: true,
      ui: { uri: studioUri, mimeType: 'text/html;profile=mcp-app', prefersBorder: false,
        csp: { connectDomains: ['http://127.0.0.1:*'], resourceDomains: ['http://127.0.0.1:*'] } } },
    { type: 'local-service', id: 'service', label: '幕织本地服务', path: 'service/muweave.mjs',
      required: true, provides: actions.map((a) => `action:${a.id}`), actions },
    { type: 'skill', id: 'muweave', label: '幕织创作', path: 'skills/muweave/SKILL.md', requires: ['service:service'] },
    { type: 'file', id: 'runtime', path: 'service/runtime.json' },
    { type: 'file', id: 'brand', path: 'assets/muweave-mark.png' },
  ],
  contributions: [{ type: 'workspace-app', ref: 'studio', label: '幕织 Studio', description }],
}))
const html = await studioHtml(resolve('dist/renderer'))
if (Buffer.byteLength(html) > 5 * 1024 * 1024) throw new Error('Studio 页面超过宿主 5 MB 限制')
await put('ui/studio.html', html)
await put('service/muweave.mjs', await readFile('src/plugin/service/muweave.mjs'))
await put('service/runtime.json', json({ version, sourceRoot: root }))
await put('skills/muweave/SKILL.md', await readFile('src/plugin/skills/muweave/SKILL.md'))
await put('assets/muweave-mark.png', await readFile('src/renderer/assets/muweave-mark.png'))
await put('LICENSE', await readFile('LICENSE'))
await put('NOTICE', await readFile('NOTICE'))
await put('README.md', `# 幕织 Studio ${version}\n\n此包支持 Codex 本地插件和 iPolloWork Workspace App。需要本机已构建的幕织 ${version} 或同版本安装版；复用原项目库、凭据和任务队列。不会附带项目、账号或 Key。\n\niPolloWork：设置 → 插件 → 导入 \\*.ipollowork-plugin，启用后打开幕织 Studio。\n\nCodex：在上一级目录运行 codex plugin marketplace add .，然后 codex plugin add muweave@muweave-local。新对话中使用幕织插件并要求打开 Studio。宿主不支持内嵌页面时，打开 studio-info 返回的本机地址。\n\n跨电脑：将 service/runtime.json 中 sourceRoot 改为目标机器的已构建源码位置，或删去 sourceRoot 并安装幕织；也可设置 MUWEAVE_HOME / MUWEAVE_EXECUTABLE。不复制浏览器会话或密钥。\n`)
const archive = zipSync(files, { level: 6 })
if (Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0) > 10 * 1024 * 1024)
  throw new Error('插件超过宿主 10 MB 限制')
await writeFile(resolve(`release/Muweave-${version}.ipollowork-plugin`), archive)
await writeFile(resolve(`release/Muweave-${version}-plugin.zip`), archive)
await copyFile(resolve('scripts/ipollowork-local-plugin-review.patch'), resolve('release/iPolloWork-local-plugin-review.patch'))
const catalog = resolve('release/.agents/plugins/marketplace.json')
await mkdir(dirname(catalog), { recursive: true })
await writeFile(catalog, json({ name: 'muweave-local', interface: { displayName: '幕织本地插件' },
  plugins: [{ name: 'muweave', source: { source: 'local', path: './muweave-plugin' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Design' }] }))
console.log(`插件 ${version} 已生成：${output}（${(archive.length / 1024).toFixed(0)} KB）；Studio ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`)
