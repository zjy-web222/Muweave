# Muweave 幕织

独立 Electron + React + TypeScript 本地 AI 导演台。此目录是后续开发的唯一源码项目；旧 Director Desk 交付目录保留作原始版本，不在其中继续改动。

## 工作约束

- 复用当前组件、共享 Zod 数据契约、SQLite 存储及任务队列，不新建第二套实现。
- 支持文字、图片、视频独立选择 ChatGPT 或已接入服务商的官方 API。模型 Key 按生成通道、服务商和区域分别加密保存；不可回传到界面、插件工具或项目存档。不要把浏览器登录描述为通用官方 OAuth，不读取或外传浏览器 Cookie / Token。
- 付费生成的未知提交结果不得自动重试。保留任务 ID，允许人工核实、恢复查询。
- 视频生成遵循 README 的“视频生成规范”：批量按分集和镜头顺序串行执行，同场景优先参考上一镜实际尾帧及含音轨的视频，保留人物、场景、道具和说话人音色；逐字使用当前对白。明确转场不强行继承旧场景尾帧。质量约束不能描述为模型零变形或自动验收保证。
- 局部重生成使用同集、同场景的前镜实际尾帧和后镜保留视频的实际首帧作为两端参考。保留版本入队时固定；本批前镜等待新结果，本批后镜不参考旧视频。缺失邻镜不补造首尾帧，也不跨镜取参考；不支持尾帧的服务在付费提交前明确阻止。
- 新品牌使用 Muweave / 幕织；旧 ZIP `director-desk` 格式标识、`director:*` IPC 名称和 `DIRECTOR_DATA_DIR` 测试变量是保留的兼容契约，不做无谓替换。
- 旧版项目通过 ZIP 导出/导入迁移。不要未经用户请求搬移或复制浏览器会话、API Key 或整个旧资料库。
- 品牌图片位于 `src/renderer/assets/`；品牌说明和生图提示词记录在 README。使用已生成的标志，不另造近似版本。
- Windows 发行包尚未签名。FFmpeg 依赖外部安装。不要宣称真实账号生成、商标可用性或 macOS 已验证，除非已经实测。

## 验证

运行 `npm test`、`npm run build`。可见界面改动运行 `npm run test:desktop` 并检查截图。打包使用 `npm run package:win`；打包后可设置 `DIRECTOR_EXECUTABLE=release/win-unpacked/Muweave.exe` 再执行桌面测试。

`node_modules/`、`dist/`、`release/`、`test-results/` 为本地依赖或生成产物，不是源码。
