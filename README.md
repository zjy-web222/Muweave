# 幕织 Muweave

[简体中文](README.md) | [English](README.en.md)

<img src="src/renderer/assets/muweave-mark.png" width="96" alt="Muweave 幕织标志">

**Weave your story. 织就你的故事。**

幕织是一个使用 Electron、React 和 TypeScript 构建的本地 AI 导演台。从剧本对话、人物与场景资产、分镜视频到整集成片，在同一个项目中完成创作。既可作为独立桌面软件运行，也可通过插件在 Codex 和 iPolloWork 中使用 Studio 页面。

项目、素材和任务记录保存在本机；AI 生成需要连接 ChatGPT 或 RunningHub。当前运行环境以 **Windows x64** 为主。

## 目录

- [主要功能](#主要功能)
- [快速启动](#快速启动)
- [连接生成服务](#连接生成服务)
- [制作流程](#制作流程)
- [插件与 Studio](#插件与-studio)
- [数据与备份](#数据与备份)
- [开发与验证](#开发与验证)
- [常见问题与限制](#常见问题与限制)
- [品牌与兼容约定](#品牌与兼容约定)

## 主要功能

| 模块       | 能力                                                                                  |
| ---------- | ------------------------------------------------------------------------------------- |
| 项目与分集 | 创建项目、设置画幅、切换上下集、编辑剧本；剧本更新时存档旧剧本及对应分镜视频          |
| AI 编剧    | 在软件内对话生成剧本、查看项目各集的对话记录、上传附件、一键应用候选剧本              |
| 资产库     | 管理人物、场景和道具；上传或直接生成参考图，自动保存并选中生成结果，保留素材版本      |
| 导演台     | 默认镜头列表，可切换 React Flow 画布；AI 拆镜、编辑对白与镜头参数、关联资产、分组生成 |
| 视频生成   | 内置 RunningHub 工作流，支持 Standard / Plus、多参考图与同场景前镜头衔接              |
| 成片       | 连续播放整集预览、按镜头跳转、导入配音或视频，导出 MP4、SRT 和 HTML 分镜表            |
| 任务与存档 | 持久任务队列、暂停与恢复查询、异常提交人工核实、素材版本、项目 ZIP 导入导出           |
| 界面与插件 | 中英文、明暗主题；独立桌面、Codex MCP 工具、iPolloWork 手动导入插件和 Studio          |

## 快速启动

### 环境要求

- Windows x64、Node.js **22.13 或更新版本**、npm。
- 安装依赖、连接账号和调用生成服务时需要网络。
- Windows 开发启动会自动准备 FFmpeg 与 ffprobe，无需用户手动填写路径。

在项目根目录执行：

```sh
npm ci
npm run dev
```

首次启动可选择“探索示例项目”，包含原创「雨夜来信」剧本、人物与场景资产、分镜示例；示例不附带生成的视频或图片结果。

侧栏底部或“连接与设置”可切换中文 / English、浅色 / 深色。偏好保存在本机，切换语言不会翻译或改写已有剧本、项目名称和资产内容。

运行已构建的桌面版：

```sh
node scripts/prepare-ffmpeg.mjs
npm run build
npm start
```

Windows 安装版和免安装版的构建命令见[开发与验证](#开发与验证)。安装包目前未做代码签名；macOS 尚未进行实机验证。

## 连接生成服务

在“连接与设置”中配置。项目内容和生成服务凭据分别存储，插件复用同一套本地配置。

### ChatGPT：文字与图片

连接一次 ChatGPT 账号，通过随软件提供的 Codex 运行时生成剧本、分镜和图片。参考图生成完成后会直接保存到对应资产或镜头，并选中为当前版本，无需复制提示词、跳转其他页面或手动导入结果。

这使用的是 **Codex 的 ChatGPT 账号授权**，不代表通用第三方 OAuth。幕织不读取或外传浏览器 Cookie、会话 Token 或账号密码；旧版浏览器辅助仅作兼容保留，不参与当前直接生图流程。可用能力与额度取决于账号和运行时，授权失效或额度不足时会显示实际错误。

AI 对话中的“创作思路”是面向用户的创作摘要，不是模型的隐藏推理过程。

### RunningHub：视频

1. 填写 RunningHub **消费级会员 API Key**。
2. 选择 **Standard** 或 **Plus**。
3. 在导演台选择镜头，确认生成后加入队列。

内置中国站的[“导演台”工作流](https://www.runninghub.cn/workflow/2105215916815511553?source=workspace)，ID 为 `2105215916815511553`。用户无需配置工作流 ID 或节点映射。Standard 对应接口参数 `instanceType: "default"`，Plus 对应 `"plus"`；模式在加入队列时记录，修改设置不会改变已排队任务。

当前采用 RH 币生成路径，一次运行一个视频任务。软件在入队及提交前检查账号，要求 `apiType: "NORMAL"` 且有 RH 币余额；工作流节点也必须通过白名单校验。会使用钱包计费的 Key、未核准节点或不匹配的工作流会阻止提交。实际扣费与余额以 RunningHub 账单为准。

付费任务创建结果不确定时，**不会自动重新提交**。请先在 RunningHub 核实，再在任务中心绑定已存在的 Task ID、恢复查询。暂停本地队列只停止新提交；已提交任务的取消和费用以平台状态为准。

### FFmpeg：预览与导出

Windows 开发启动及打包脚本自动准备 `vendor/ffmpeg/`，优先复用符合要求的本机 Gyan 构建，否则下载并校验固定版本。Windows 发行包附带 FFmpeg、ffprobe 和许可文件，用户无需安装或配置路径。来源和许可记录随包保存在 `resources/ffmpeg/NOTICE.txt`。

## 制作流程

### 从故事到分镜

1. **创建项目与分集**：选择 `16:9`、`9:16` 或 `1:1`，输入故事或在 AI 编剧中对话。
2. **应用剧本**：查看候选内容，点击“应用到剧本”。切换分集、项目或工作页面时会先保存编辑，也可手动保存。
3. **准备资产**：固定人物外观、服装、场景布局和道具描述，上传 PNG / JPEG / WebP 或直接生成参考图。
4. **AI 拆解分镜**：生成可编辑的镜头；核对动作、说话人、对白、时长和关联资产。结构化导入会复用同名同类型资产，新镜头追加到当前集。
5. **生成视频**：按镜头顺序加入队列，审看每个结果，必要时修改后人工重试。
6. **预览与导出**：整集镜头都有视频后，在成片页连续播放，再导出影片或分镜表。

剧本对话可选择任意扩展名的附件，每轮最多 **10 个**，每个最多 **50 MB**。目前支持提取文本、DOCX 和 PDF 文字，PNG / JPEG / WebP 作为图片输入；其他文件尝试按文本读取。文字提取最多 30,000 字符，PDF 最多读取前 30 页。扫描件、受保护文件或无法解析的二进制格式会说明原因，不保证所有文件类型都能分析。

### 人物与场景连续性

内置多参考图路径使用 MiniMax H3 Ref2VA。软件按镜头关联的资产选择人物、场景和道具参考图，最多 **9 张**；参考图版本在入队时固定。同场景后续镜头等待前一镜头完成，再参考它的末帧和视频。前镜头失败时，后续镜头暂停；没有任何参考图的新场景使用保留的 FL2VA 路径。

提示词会标明参考图编号及用途，并传入角色设定、说话人和对白。单镜提交时长为 **4–15 秒**；短镜头补到 4 秒，对白会按长度补足所需时长，超过当前 10 秒对白估算上限的内容需要拆镜。整批镜头先校验，通过后才创建视频任务。

参考图和前镜头能改善连续性，生成模型仍可能改变人物、环境或对白，也不会严格锁定首帧。关键角色和地点应使用稳定的设定及选定参考图，并逐镜审看。

### 剧本更新与视频存档

更新已有分集的剧本正文，会保存旧剧本、旧分镜和视频关联为独立存档，保留已有素材版本；当前导演台与成片页转到新剧本。随后用“AI 拆解分镜”创建新镜头。仅修改分集标题不会触发存档。

若该集还有未完成的视频任务，先完成或取消任务再改剧本。顶部“剧本与视频存档”可查看旧内容并播放旧视频；存档随项目 ZIP 导出，历史回滚不会删除已建立的剧本存档。

### 成片输出

- MP4：H.264 + AAC、30 fps，支持 1920×1080、1080×1920、1080×1080。
- 按镜头顺序和设定时长拼接；画幅不符时等比例适配并补边，短视频补尾帧，长视频截断。
- 导入的配音优先，否则保留视频原音轨；没有音轨时补静音。
- 整集预览复用导出流程，更换视频、配音或时长后重新生成缓存。
- SRT 按镜头时长分配对白时间，不做语音强制对齐或字幕烧录；HTML 分镜表可打印。

## 插件与 Studio

插件复用桌面版的 SQLite 资料库、凭据、素材与任务队列。Studio 使用相同的剧本、资产、导演台、成片和任务界面，通过浏览器上传和下载文件。

### 构建插件

```sh
node scripts/prepare-ffmpeg.mjs
npm run package:plugin
```

产物位于 `release/`，版本号取自 [package.json](package.json)：

| 产物                                   | 用途                        |
| -------------------------------------- | --------------------------- |
| `muweave-plugin/`                      | Codex 本地插件目录          |
| `Muweave-<version>-plugin.zip`         | 插件归档                    |
| `Muweave-<version>.ipollowork-plugin`  | iPolloWork 手动导入包       |
| `.agents/plugins/marketplace.json`     | Codex 本地 marketplace 索引 |
| `iPolloWork-local-plugin-review.patch` | 本地插件审批入口的宿主补丁  |

构建不会自动安装插件，也不会把幕织内置到 iPolloWork。

### Codex

在幕织源码根目录执行：

```sh
codex plugin marketplace add ./release
codex plugin add muweave@muweave-local
```

重新加载插件或开启新对话后，可以要求“打开幕织 Studio”“写一集剧本并保存到幕织”“把这集拆成连续分镜”。支持 MCP Apps 的宿主可内嵌 `ui://muweave/studio`；其他界面打开 `muweave_studio_info` 返回的本机地址。

### iPolloWork

在“设置 → 扩展 → 插件 → 添加”中手动选择 `.ipollowork-plugin`。支持本地审批的宿主会展示权限、服务源码和文件指纹；审批后安装，再打开“幕织 Studio”。

仅接受签名本地服务的旧宿主会拒绝此开发插件。需要在兼容的 iPolloWork 源码中审阅并应用[本地插件审批补丁](scripts/ipollowork-local-plugin-review.patch)，或使用已提供该审批入口的版本。插件采用手动导入，不随 iPolloWork 内置或自动安装。

### 工具与运行环境

| MCP 工具              | 用途                                   |
| --------------------- | -------------------------------------- |
| `muweave_studio_info` | 获取 Studio 页面及本机连接地址         |
| `muweave_read`        | 读取项目、历史和任务                   |
| `muweave_edit`        | 编辑项目、分集、资产与分镜             |
| `muweave_generate`    | 文字、图片生成及视频任务队列           |
| `muweave_import`      | 导入用户选定的工作区文件               |
| `muweave_export`      | 生成整集预览，导出 ZIP、MP4、SRT、HTML |

iPolloWork 对应动作是 `studio-info`、`read`、`edit`、`generate`、`import`、`export`。视频提交和重试要求 `confirmed: true`，表示用户已授权该次付费生成；工具不提供密钥读取或替换能力。

本地插件需 Node.js 22.13+ 和幕织 0.2.x 运行环境，生成包默认指向当前已构建的源码。搬移源码或换电脑后重新构建并更新插件；可用 `MUWEAVE_HOME` 指向已构建目录，或 `MUWEAVE_EXECUTABLE` 指向相应版本的安装程序。

执行 `npm run build` 后，可用 `npm run studio` 单独启动后台 Studio。服务只监听 `127.0.0.1`，每次启动生成临时会话地址；不要公开或转发该地址。插件优先复用已有幕织进程；以 `--plugin-server` 启动的后台会在宿主关闭后继续处理任务，直到进程退出，不设置开机自启或 Windows 服务。

## 数据与备份

- **资料库**：实际路径可在设置页查看；Windows 默认在 `%APPDATA%/muweave/library/`。
- **数据库与文件**：`director.sqlite` 保存项目、对话、历史和任务；`projects/<id>/media/` 保存素材，`projects/<id>/chat/` 保存附件。
- **凭据**：RunningHub Key 由 Electron safeStorage 使用操作系统能力加密保存，不回传到前端，不进入项目 ZIP 或插件包。ChatGPT 文字和图片共用 Codex 账号授权。
- **访问方式**：桌面使用经过 Zod 校验的 IPC，Studio 使用带临时会话校验的本机 HTTP 服务，复用同一命令契约。
- **项目 ZIP**：包含当前项目、剧本存档、素材版本、对话附件和任务溯源记录；不包含 SQLite 历史回滚表、Key、账号会话或全局设置。导入恢复为新项目，旧任务不会自动执行。
- **容量与恢复**：ZIP 导出素材及附件总量上限 512 MB，导入检查安全路径和解压体积。最近 100 次项目内容修改可回滚，画布布局移动不创建历史版本。

大型项目可在停止桌面和 Studio 后备份完整资料库。删除项目或分集前，如需保留内容，请自行导出存档；删除操作不自动创建备份。

幕织没有项目云同步服务。主动调用 AI 时会发送相应提示词、附件内容或参考素材，因此本地存储不代表生成过程完全离线。

### 从旧 Director Desk 迁移

在旧版导出项目 ZIP，再在幕织“打开项目存档”中导入并重新连接账号。幕织使用独立应用标识和资料库，不自动复制旧 Key、浏览器会话或整个旧数据库。后续开发仅在本项目中进行。

## 开发与验证

### 常用命令

| 命令                            | 用途                                    |
| ------------------------------- | --------------------------------------- |
| `npm run dev`                   | 准备 Windows FFmpeg，启动开发版         |
| `npm run build`                 | TypeScript 检查与 Electron / React 构建 |
| `npm start`                     | 运行已有构建                            |
| `npm run studio`                | 运行已有构建的后台 Studio               |
| `npm test`                      | 核心存储、队列、媒体与图片生成契约测试  |
| `npm run test:desktop`          | 真实 Electron 桌面端到端测试            |
| `npm run test:plugin`           | 本机服务、MCP、Studio 与插件端到端测试  |
| `npm run package:plugin`        | 构建并生成插件包                        |
| `npm run package:win`           | 构建 Windows x64 免安装版               |
| `npm run package:win:installer` | 构建 Windows x64 安装版                 |
| `npm run package:mac`           | macOS DMG 构建入口，尚未实机验证        |

Windows 构建输出为 `release/Muweave-<version>-Windows.exe` 或 `release/Muweave-<version>-Setup.exe`。版本号以 `package.json` 为准，README 中的文件名规则不表示已发布安装包。

完整验证顺序（PowerShell）：

```powershell
node scripts/prepare-ffmpeg.mjs
$env:PATH = "$(Join-Path (Get-Location) 'vendor\ffmpeg');$env:PATH"
npm test
npm run build
npm run test:desktop
npm run test:plugin
```

测试会直接调用 PATH 中的 `ffmpeg`；上面的设置仅影响当前终端。插件界面测试还需要安装 Microsoft Edge。桌面与插件测试使用临时资料库，截图和结果位于 `test-results/`；自动测试中的生成调用使用受控替身，不提交真实付费视频任务。

### 源码结构

```text
src/
  main/          Electron、SQLite、Codex、RunningHub、媒体与 Studio 服务
    workflows/   内置工作流与无参考图时的兼容路径
  preload/       最小桌面 IPC 桥接
  shared/        共用 Zod 契约、导演提示词、字幕和插件工具定义
  renderer/      React 工作空间、分镜画布、列表、双语与主题
    assets/      正式品牌素材
  plugin/        宿主服务入口与幕织创作技能
scripts/         FFmpeg 准备、插件打包和 iPolloWork 审批补丁
tests/           核心、图片、桌面及插件验证
```

开发约束见 [AGENTS.md](AGENTS.md)。`node_modules/`、`dist/`、`release/`、`test-results/` 和 `vendor/ffmpeg/` 是本地依赖或生成产物，不提交为源码。

## 常见问题与限制

| 情况                                 | 处理方式                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| ChatGPT 授权失效、生成超时或额度不足 | 查看实际错误，检查网络和账号；必要时在设置中重新连接，再人工重试                  |
| RunningHub 拒绝 Key 或节点           | 使用有 RH 币余额的消费级会员 Key；工作流变更后需要核对软件的节点契约，不绕过校验  |
| 创建任务超时，不知道是否已扣费       | 先核实平台任务和账单，绑定已存在的 Task ID；不要重复提交                          |
| 后续镜头暂停                         | 检查同场景前镜头是否完成、失败或取消，并处理前镜头任务                            |
| 成片没有整集预览                     | 确认当前集每个镜头都有可用视频，再检查 FFmpeg；Windows 发行包缺失二进制时重新安装 |
| 插件找不到 Studio 服务               | 检查源码是否已构建、插件路径是否有效；搬移目录后重新构建并安装插件                |
| 附件无法分析                         | 使用可提取文字的文件或支持的图片；扫描 PDF 不会自动 OCR                           |

视频结果下载限制为允许的 HTTPS RunningHub / xiaoyaoyou.com 子域，单文件最多 1 GB；其他 CDN、过期链接或不支持的格式需要人工下载导入，Task ID 会保留。

当前成片模块提供基础整集拼接，没有自动 TTS、口型同步、多轨剪辑、转场或自动配乐。人物、环境、首帧和对白的生成准确度需要人工审看。macOS 打包、账号生成及导出未进行实机验证。

## 品牌与兼容约定

**幕织**：“幕”指银幕、场景与戏剧的一幕；“织”指把人物、剧本、镜头和素材组织成作品。**Muweave** 取“幕”的读音与 weave，建议读作 _moo-weev_。

正式标志采用已选定的 A / FRAME 方案：石墨色取景框形成抽象 M，鼠尾草绿画面居中。各界面和打包图标复用 [muweave-mark.png](src/renderer/assets/muweave-mark.png)，不另造近似标志。品牌色为石墨 `#272A28`、鼠尾草绿 `#829574`、暖白 `#F4F5EE`。这是创意命名，不代表商标或域名已经注册或获准使用。

品牌图像从选定方案提取，保留原始编辑提示词以便追溯：

> Edit the provided image, which is the selected A / FRAME Muweave logo presentation. Extract and faithfully preserve ONLY the large central symbol: two graphite geometric outward frame wings forming an abstract M with the sage trapezoid screen in the middle. Preserve its exact recognizable silhouette and arrangement; do not invent another logo. Remove all text, labels, small examples and presentation layout. Deliver one centered standalone app mark, occupying 80% of square canvas, even margins. Clean strictly flat fills graphite #272A28 and sage #829574, no gradients, no shadows, no bevels, no outlines. Genuine transparent background. Smooth sharp high-resolution edges and balanced small-icon clarity. No wordmark.

旧 ZIP 的 `director-desk` 格式标识、`director:*` IPC 名称与 `DIRECTOR_DATA_DIR` 测试变量是保留的兼容契约。第三方二进制与依赖的许可信息以各自随附文件为准。
