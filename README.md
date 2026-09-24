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

当前开发版的剧本页新增「AI 编剧对话」：在「连接与设置」中使用 ChatGPT 账号完成 Codex 授权后，可直接在剧本页发送创作要求并接收回复，无需复制粘贴。对话按分集保存在本地项目中，生成的完整剧本需要点击「应用到剧本」才会写入当前集；应用前的版本可从项目历史恢复。资产与分镜的文字结果也可在创作助手中直接生成。图片仍使用独立的 ChatGPT 浏览器辅助流程；浏览器登录与 Codex 账号授权各自独立，不读取浏览器 Cookie 或 Token。

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

1. **项目与分集**：新建项目、画幅、分集、TXT/Markdown/DOCX 文本导入、剧本编辑、全片视觉风格。
2. **ChatGPT 创作**：生成剧本改编、资产提取、分镜拆解和生图提示词；结构化 JSON 校验导入。同名同类型资产合并，新分镜追加而不覆盖原镜头。
3. **资产库**：角色、场景、道具，描述与提示词、参考图版本，关联到镜头。
4. **导演台**：可平移/缩放/拖动布局的三阶段画布，脚本 → 首尾帧 → 视频；列表、搜索、镜头顺序、导演参数、对白、随机种子、审定标记和分组批量提交。
5. **视频生成**：RunningHub API Key、站点、指定工作流 ID、节点字段映射、文件上传、任务提交、查询、下载和本地归档。
6. **任务与版本**：SQLite 持久化、限并发、暂停新提交、失败暂停分组、取消/重试、异常提交人工核实、绑定 Task ID、重启恢复查询。保留素材版本，输入变化提示视频可能过期。
7. **成片**：逐镜预览、镜头条带、导入配音/视频，FFmpeg 整集 MP4 + 独立 SRT，单独 SRT 与可打印 HTML 分镜表。
8. **存档**：项目、画布、素材版本、任务溯源记录 ZIP 导出与恢复。恢复为新项目，旧任务不自动执行。最近 100 次内容修改可回滚，布局移动不产生历史版本。

镜头参数约 0.7 秒后自动保存，切换镜头时也会提交未保存编辑。剧本正文使用右上角的“保存剧本”按钮。不要在未保存剧本时关闭或切换项目。

## ChatGPT：浏览器辅助，不是假 OAuth

本版**不把 ChatGPT 网页登录冒充为任意模型的官方 API 授权**，也不抓取 Cookie、会话 Token 或账号密码。

使用方法：

1. 点“连接与设置 → ChatGPT → 打开 / 登录”，由本人完成登录与验证。
2. 从剧本页的创作路线或画布的“生图”打开提示词面板。
3. 点“复制并打开 ChatGPT”，在 ChatGPT 窗口粘贴提示词并发送。
4. 文本：复制完整 JSON 回到“导入生成结果”，点“读取剪贴板”，检查预览后导入。
5. 图片：在 ChatGPT 中下载；应用会询问是否归入发起时的镜头/资产。若下载识别失败，使用“导入图片”手动选择。

参考图需要你在 ChatGPT 对话里附加；当前不自动上传参考图、不自动点击发送、不自动抓取网页回复、不批量驱动网页绕过限制。遇到网页登录限制或验证码，需要人工处理；也可在常用浏览器完成生成后，将结果导入本应用。生成能力、次数和订阅限制以你的 ChatGPT 账号为准。

“退出并清除登录记录”只清除本应用隔离浏览器中的记录，不影响外部浏览器。

## RunningHub 设置

准备自己的 API Key，以及你有权运行的 **ComfyUI 工作流 Workflow ID**。这不是 AI App 的 `webappId` 接口。

在“连接与设置”选择实际使用的站点（`.ai` / `.cn`）、填写 Key 和 Workflow ID，保存后测试连接和读取节点 JSON。

参数映射须按实际工作流填写，以下仅解释用途，不是可直接运行的节点编号：

| 数据来源    | 写入工作流的内容                  | 常见字段（仅示例） |
| ----------- | --------------------------------- | ------------------ |
| 视频提示词  | 当前镜头 videoPrompt，无则 action | text               |
| 首帧 / 尾帧 | 上传后返回的 fileName             | image              |
| 随机种子    | 镜头 seed                         | seed               |
| 时长（秒）  | 镜头 duration                     | duration           |
| 固定值      | 你填写的字符串                    | 任意标量字段       |

不要把“秒”映射到需要“帧数”的字段；该情况请按工作流要求填固定帧数，或修改工作流使其接收秒。不同工作流的节点 ID、字段名和单位可能不同，本版不会猜测或自动改造工作流。

使用的接口来自 [RunningHub 官方工作流文档](https://www.runninghub.ai/runninghub-api-doc-en/doc-8287472)：

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

需要 FFmpeg 与 ffprobe，在 PATH 中或位于设置指定的 FFmpeg 同一目录。这台开发电脑已安装 FFmpeg；**免安装程序本身不捆绑 FFmpeg**。

- 横屏 1920×1080、竖屏 1080×1920、方形 1080×1080，30 fps，H.264 + AAC。
- 按当前集的镜头顺序及镜头时长拼接；画幅不同时等比例适配、补边。
- 导入的配音优先；否则保留原视频音轨；无音轨补静音。
- 视频比镜头短时重复尾帧，长时截断；音频不足补静音。
- SRT 使用镜头时长分配对白时间，不做语音强制对齐；不烧录进画面。
- 当前是基础整集组接，不是多轨非线性剪辑器；没有自动 TTS、口型同步、转场或自动配乐。

## 数据、安全与备份

- 资料库路径显示在设置页。Windows 新版位于独立的 Muweave / muweave 应用数据目录（以应用显示的实际路径为准），旧 `director-desk` 目录不会被改动。
- `director.sqlite` 保存项目、最近 100 次历史和任务；`projects/<id>/media/` 保存媒体文件。
- API Key 用 Electron safeStorage / 操作系统凭据加密保存，不回传到前端，不进入项目 ZIP。
- ChatGPT 使用独立持久化浏览器分区，禁用 Node 集成、隔离上下文和沙箱执行。
- 渲染进程只通过校验过的 IPC 命令访问本地能力。网页窗口无法调用这些 IPC。
- ZIP 导入有路径穿越、格式和解压体积检查。ZIP 当前素材总量上限 512 MB；大型项目请在关闭应用后备份完整资料库。
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

尚需你的账号完成的验收：ChatGPT 登录后的一次文字/图片生成、实际 RunningHub 工作流的节点映射与一次视频生成。当前不宣称这些真实账号链路已成功验证。

商业分发前还需单独检查各服务使用条款、第三方依赖许可证、代码签名与平台发布要求。本开发预览版不构成合规认证。
