# 幕织 Muweave · 本地 AI 导演台

**Weave your story. 织就你的故事。**

独立项目目录：`C:\Users\31939\Documents\Codex\Muweave`。从原 Director Desk 首版整理而来；旧交付目录和原用户资料库保持不动。后续请在本项目开发。此文件夹可直接作为 Codex 项目添加。

## 品牌设计

- **中文：幕织**。“幕”指银幕、场景、戏剧的一幕；“织”指把人物、剧本、镜头与素材组织成一部作品。
- **英文：Muweave**。Mu 取“幕”的发音，weave 表达编织。建议读作 _moo-weev_，产品名不绑定任何模型服务。
- **Logo**：采用用户选定的 A / FRAME 方案。石墨色取景框形成抽象 M，鼠尾草绿画面居中，表达构图、镜头与导演视角。窗口、应用侧栏、启动页、页面图标和打包图标复用同一 PNG，不另造近似标志。
- **色彩**：石墨 `#272A28`、鼠尾草绿 `#829574`、暖白 `#F4F5EE`。浅色与深色界面均可使用暖白承托底。
- **文件**：`src/renderer/assets/muweave-mark.png` 是透明底正式品牌素材，Windows 打包工具从它生成应用图标。
- **命名状态**：这是首版创意命名，不代表商标、公司名或域名已注册/可注册；商业发布前另行核验。

Logo 使用内置图像生成工具，从选定的 A 款提取独立标志；未使用 API Key 或 CLI 生图。最终编辑提示词：

> Edit the provided image, which is the selected A / FRAME Muweave logo presentation. Extract and faithfully preserve ONLY the large central symbol: two graphite geometric outward frame wings forming an abstract M with the sage trapezoid screen in the middle. Preserve its exact recognizable silhouette and arrangement; do not invent another logo. Remove all text, labels, small examples and presentation layout. Deliver one centered standalone app mark, occupying 80% of square canvas, even margins. Clean strictly flat fills graphite #272A28 and sage #829574, no gradients, no shadows, no bevels, no outlines. Genuine transparent background. Smooth sharp high-resolution edges and balanced small-icon clarity. No wordmark.

## 从旧版迁移

Muweave 使用独立应用标识和资料库，不会暗中搬移旧版 Key 或 ChatGPT 登录状态。若已有创作内容，请在旧版导出 ZIP，再在新版“打开项目存档”中导入，服务账号重新绑定。

为兼容旧存档，ZIP 内的 `director-desk` 格式标识、内部 IPC 名称与测试环境变量保留不变；它们不是遗漏的品牌替换。

Electron + React + TypeScript + Tailwind CSS 的本地短剧工作台。界面参考 Codex 的克制桌面风格；借鉴 Huobao Drama 的制作阶段与 LocalMiniDrama 的画布理念，未复制这两个项目的源码。

## 启动

Windows 安装版：`release/Muweave-0.1.1-Setup.exe`。免安装版：`release/Muweave-0.1.1-Windows.exe`。

安装版双击安装，免安装版双击直接运行。该开发预览版未做代码签名，Windows 可能显示未知发布者提示；请先核对文件来源。安装版按当前用户安装，程序不设置开机自启或后台常驻服务，关闭所有窗口后退出。

第一次启动可选择“探索示例项目”：包含原创「雨夜来信」剧本、4 个资产、6 个镜头；示例没有虚构的生图或视频结果。

侧栏底部可直接切换「中文 / EN」和浅色 / 深色主题，也可在「连接与设置 → 导出与外观」中调整。偏好保存在本机，重启后仍会生效；切换语言不会改写项目名称、剧本或素材内容。

剧本页右侧的「AI 编剧对话」汇总当前项目所有分集的聊天记录。使用 ChatGPT 账号完成 Codex 授权后，可直接发送创作要求；AI 回复包含可见的创作思路摘要，候选剧本点击「应用到剧本」后写入所属分集并显示在左侧。上一集/下一集切换会先保存当前编辑。对话框可选择任意扩展名的本地文件，每轮最多 10 个、每个 50 MB；应用先提取文本、DOCX、PDF 中的文字，图片作为图像输入。其他格式若可识别为文本也会分析，无法解析时会明确说明。附件和聊天记录保存在本地项目及 ZIP 存档中。浏览器登录与 Codex 账号授权各自独立，不读取浏览器 Cookie 或 Token。

开发启动（建议 Node.js 22.13+）：

```sh
npm ci
npm run dev
```

生产构建和本地运行：

```sh
npm run build
npm start
```

如你的 npm 配置存在不可用代理，修复自己的代理配置后安装即可。本项目未修改系统网络、全局 npm 配置或 Codex 配置。

## 已实现的制作流程

1. **项目与分集**：新建项目、画幅、分集、上下集切换和剧本编辑。文本与其他参考文件可从 AI 对话框添加。
2. **ChatGPT 创作**：生成剧本改编、资产提取、分镜拆解和生图提示词；结构化 JSON 校验导入。同名同类型资产合并，新分镜追加而不覆盖原镜头。
3. **资产库**：角色、场景、道具，描述与提示词、参考图版本，关联到镜头。
4. **导演台**：可平移/缩放/拖动布局的三阶段画布，脚本 → 首尾帧 → 视频；列表、搜索、镜头顺序、导演参数、对白、随机种子、审定标记和分组批量提交。
5. **视频生成**：填写 RunningHub API Key，可选 Plus 或 Standard 模式；内置指定工作流，支持镜头提示词、时长、画幅、可选首尾帧、任务查询、下载和本地归档。
6. **任务与版本**：SQLite 持久化、限并发、暂停新提交、失败暂停分组、取消/重试、异常提交人工核实、绑定 Task ID、重启恢复查询。保留素材版本，输入变化提示视频可能过期。
7. **成片**：逐镜预览、镜头条带、导入配音/视频，FFmpeg 整集 MP4 + 独立 SRT，单独 SRT 与可打印 HTML 分镜表。
8. **存档**：项目、画布、素材版本、任务溯源记录 ZIP 导出与恢复。恢复为新项目，旧任务不自动执行。最近 100 次内容修改可回滚，布局移动不产生历史版本。

镜头参数约 0.7 秒后自动保存，切换镜头时也会提交未保存编辑。剧本正文可用“保存剧本”按钮手动保存；切换分集、项目或工作页面时会先保存。关闭应用前仍请保存未提交的剧本编辑。

## ChatGPT 账号连接

在“连接与设置”连接一次 ChatGPT 账号。幕织使用随软件提供的 Codex 运行时，在应用内生成剧本、分镜及图片；图片完成后直接保存到发起生成的镜头或资产，无需复制、下载或再次登录浏览器。生成能力和次数以账号实际可用额度为准。

这里使用 Codex 的 ChatGPT 账号授权，并非向任意第三方模型提供通用 OAuth。软件不读取或外传浏览器 Cookie、会话 Token 或账号密码。旧版浏览器辅助数据仅作兼容保留，不参与新的生图流程。

## RunningHub 设置

在“连接与设置”填写自己的 API Key 并选择 Plus（48 GB）或 Standard（24 GB）。软件固定使用 [导演台工作流](https://www.runninghub.cn/workflow/2105215916815511553?source=workspace) 和 RunningHub 中国站；用户无需填写 Workflow ID 或节点映射。Standard 在接口中对应 `instanceType: "default"`，Plus 对应 `"plus"`。选择在加入队列时写入任务，之后修改默认模式不会改变已排队任务。生成视频前软件读取工作流的 API 格式，校验视频节点，再写入当前镜头的视频提示词、24 fps 帧数和项目画幅。镜头已选首帧或尾帧图片时，先上传图片并接到对应输入。若远端工作流结构变化，提交前会报错，不产生新任务。

使用的接口来自 [RunningHub 官方工作流文档](https://www.runninghub.cn/runninghub-api-doc-cn/api-425749013)：

- `/api/openapi/getJsonApiFormat`
- `/task/openapi/upload`
- `/task/openapi/create`
- `/task/openapi/status`
- `/task/openapi/outputs`
- `/task/openapi/cancel`
- `/uc/openapi/accountStatus`

生成前会提示确认远端付费。网络断开导致创建结果不确定时，不自动重试；请在 RunningHub 控制台确认，再绑定 Task ID。暂停本地队列不代表远端任务停止。取消、退款和已产生费用以平台实际状态为准。

下载仅允许 HTTPS 的 RunningHub / xiaoyaoyou.com 子域，单文件上限 1 GB。若平台返回其他 CDN 域名、非常规视频格式或临时下载链接失效，会保留 Task ID 并提示人工下载导入；不会把未知域名直接放行。

## 视频导出

Windows 版本随程序附带 FFmpeg 与 ffprobe，用户无需配置路径。`npm run dev` 和 Windows 打包脚本会准备本地 `vendor/ffmpeg/`；优先使用本机 Gyan 构建，否则下载并校验固定版本。发行包将二进制文件放入 `resources/ffmpeg/`，其来源与许可信息见同目录 `NOTICE.txt`。macOS 打包和导出尚未验证。

- 横屏 1920×1080、竖屏 1080×1920、方形 1080×1080，30 fps，H.264 + AAC。
- 按当前集的镜头顺序及镜头时长拼接；画幅不同时等比例适配、补边。
- 导入的配音优先；否则保留原视频音轨；无音轨补静音。
- 视频比镜头短时重复尾帧，长时截断；音频不足补静音。
- SRT 使用镜头时长分配对白时间，不做语音强制对齐；不烧录进画面。
- 当前是基础整集组接，不是多轨非线性剪辑器；没有自动 TTS、口型同步、转场或自动配乐。

## 数据、安全与备份

- 资料库路径显示在设置页。Windows 新版位于独立的 Muweave / muweave 应用数据目录（以应用显示的实际路径为准），旧 `director-desk` 目录不会被改动。
- `director.sqlite` 保存项目、对话、最近 100 次历史和任务；`projects/<id>/media/` 保存媒体文件，`projects/<id>/chat/` 保存对话附件。
- API Key 用 Electron safeStorage / 操作系统凭据加密保存，不回传到前端，不进入项目 ZIP。
- ChatGPT 文字及图片生成共用 Codex 账号授权；旧版浏览器辅助保留独立分区以兼容已有数据。
- 渲染进程只通过校验过的 IPC 命令访问本地能力。网页窗口无法调用这些 IPC。
- ZIP 导入有路径穿越、格式和解压体积检查。ZIP 当前素材和对话附件总量上限 512 MB；大型项目请在关闭应用后备份完整资料库。
- ZIP 包含完整当前工程状态和素材版本，任务记录仅供溯源；**不包含 SQLite 历史回滚表、Key、浏览器会话或全局设置**。
- 没有同步服务器、遥测、支付或自动更新模块。主动生成时会按所用服务发送相应提示词/素材。

## 源码结构

```text
src/
  main/
    index.ts       Electron 窗口、IPC 路由、安全边界
    store.ts       SQLite 项目 / 历史 / 任务
    chatgpt.ts     隔离浏览器与人工确认下载归档
    runninghub.ts  API 客户端与持久任务状态机
    media.ts       媒体导入、受限下载、ZIP、FFmpeg
  preload/         最小桌面桥接
  shared/          Zod 数据契约、提示词、结构化导入、字幕
  renderer/
    src.tsx        工作空间导航与应用状态
    Canvas.tsx     React Flow 导演画布
    Inspector.tsx  镜头检查器与素材版本
    Production.tsx 剧本、资产、成片、任务
    Dialogs.tsx    建项目、生成、设置、导出
    ui.tsx         共享交互组件
    i18n.tsx       界面中英文文案
    styles.css     Tailwind + 语义化双主题样式
tests/
  core.test.ts     存储、存档、队列与真实 FFmpeg 测试
  desktop.mjs     真实 Electron 桌面端到端测试
```

## 验证与构建

```sh
npm test
npm run build
npm run test:desktop
npm run package:win
```

核心测试中视频导出测试需要 FFmpeg。桌面测试使用临时资料库；原生文件选择器替换为测试路径，但窗口、界面操作、IPC、素材协议、存档文件和重启均实际执行。RunningHub 异常状态使用受控桩测试，不消耗真实额度。

`test-results/` 中有桌面截图及 `desktop-results.json`。本次已验证 Windows 1540×990 和 1120×760 窗口。macOS 代码路径已预留，`npm run package:mac` 需在 Mac 上构建，尚未进行 Mac 实机验证。

已使用当前 ChatGPT 账号验证一次真实图片生成。使用 RunningHub Key 提交真实视频任务会产生费用，本地测试只校验 Plus 与 Standard 的请求参数和队列流程，不消耗额度。

商业分发前还需单独检查各服务使用条款、第三方依赖许可证、代码签名与平台发布要求。本开发预览版不构成合规认证。
