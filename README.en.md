# Muweave 幕织

[简体中文](README.md) | [English](README.en.md)

**Weave your story. 织就你的故事。**

Muweave is a local AI filmmaking workspace built with Electron, React, and TypeScript. Develop screenplays through conversation, maintain character and location assets, generate storyboard videos, and assemble an episode within one project. Run it as a desktop app or use its Studio page through plugins in Codex and iPolloWork.

Projects, media, and task records stay on your computer. Text, image and video generation can independently use ChatGPT or supported providers’ official APIs. The current runtime primarily targets **Windows x64**.

<img width="1524" height="951" alt="Muweave director workspace with the example project's shot list" src="https://github.com/user-attachments/assets/3ad6603f-ddff-40ea-aa26-9275698ecbc6">

_Application screenshot: the example project's director shot list in light mode, with the Chinese interface._

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Generation services](#generation-services)
- [Production workflow](#production-workflow)
- [Plugins and Studio](#plugins-and-studio)
- [Data and backups](#data-and-backups)
- [Development and verification](#development-and-verification)
- [Troubleshooting and limitations](#troubleshooting-and-limitations)
- [License](#license)

## Features

| Module                | Capabilities                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Projects and episodes | Create projects, choose an aspect ratio, switch episodes, and edit screenplays; archive the previous screenplay and its video-linked shots when the script changes |
| AI screenwriter       | Generate scripts inside the app, view conversations across a project's episodes, attach files, and apply a candidate script with one click                         |
| Asset library         | Manage characters, locations, and props; upload or generate reference images, automatically save and select results, and retain media versions                     |
| Director workspace    | A shot list by default, with an optional React Flow canvas; AI storyboard generation, dialogue and camera controls, asset associations, and batch generation       |
| Video generation      | Built-in RunningHub workflow with Standard / Plus, multiple reference images, and continuity from the previous shot in the same scene                              |
| Film assembly         | Continuous episode previews, shot navigation, voice or video imports, and MP4, SRT, and HTML storyboard exports                                                    |
| Tasks and archives    | Persistent queue, pause and query recovery, manual verification of uncertain submissions, media versions, and project ZIP import/export                            |
| Interface and plugins | Chinese / English and light / dark themes; desktop app, Codex MCP tools, manually imported iPolloWork plugin, and Studio                                           |

## Quick start

### Requirements

- Windows x64, Node.js **22.13 or later**, and npm.
- Network access to install dependencies, connect accounts, and use generation services.
- Windows development startup prepares FFmpeg and ffprobe automatically. Users do not need to configure executable paths.

From the repository root:

```sh
npm ci
npm run dev
```

On first launch, choose the example project to explore the original “Rainy Night Letter” screenplay, character and location assets, and storyboard shots. The example does not include generated video or image results.

Switch Chinese / English and light / dark themes from the bottom of the sidebar or connection settings. Preferences persist locally. Changing the interface language does not translate or rewrite existing scripts, project names, or asset content.

To run a built desktop version:

```sh
node scripts/prepare-ffmpeg.mjs
npm run build
npm start
```

Windows installer and portable build commands are listed under [Development and verification](#development-and-verification). Packages are currently unsigned. macOS has not been verified on a physical machine.

## Generation services

Configure services in connection settings. Project content and service credentials are stored separately; plugins reuse the same local configuration.

### Independent models and API keys

Settings has **Text model / Image model / Video model** tabs. Each channel selects its own provider and stores its own key, even when both text and images use OpenAI. Existing ChatGPT and RunningHub connections are preserved.

| Channel | Supported providers | Authentication |
| --- | --- | --- |
| Text: screenplays, chat, asset extraction, storyboards | ChatGPT, OpenAI, DeepSeek, Qwen, Claude, Gemini, Kimi, GLM, Doubao, MiniMax, Grok, Mistral, Hunyuan, ERNIE, StepFun | ChatGPT account or official provider API key |
| Images: asset references, first/last frames | ChatGPT, OpenAI GPT Image, Wan, Gemini, Seedream, MiniMax Image-01, Grok Imagine, FLUX, GLM-Image / CogView | Separate image credentials; results are saved automatically |
| Video | RunningHub, Kling, MiniMax Hailuo, Seedance, Grok Imagine | Separate video key; Kling supports a current API key or legacy Access Key + Secret Key |

Choose the channel and provider, select or enter a model ID, and save the matching key. Qwen, Kling, MiniMax, Kimi and GLM offer mainland China and international endpoints with separate credentials. Doubao/Seedream/Seedance use the China Ark endpoint. Grok, Mistral and FLUX use official global endpoints. Text/image IDs can use the same supported API protocol; video, Wan and FLUX image models use adapted presets.

Tasks snapshot their model and region when queued, so changing settings does not change existing tasks. Finish outstanding tasks before replacing a key with one from a different account. Connection checks use non-billable model/task queries. Wan, MiniMax, Ark, GLM and FLUX checks confirm saved configuration only; they do not claim to validate generation permissions or start paid tests.

New presets cover Kimi K3/K2.6, GLM 5.3/5.2/4.7/4.6V, Doubao Seed 2.1/2.0, MiniMax M3/M2.7/M2.5, Grok 4.7, Mistral Small/Large, Seedream 5.0/4.5/4.0, Image-01, Grok Imagine Image 2.0, FLUX.2 Pro/Max/Flex/Klein, Seedance 2.5/2.0/Fast and Grok Imagine Video 1.5. Availability depends on provider permissions and region. Adapters are verified with isolated API fixtures, not real paid account generations.

Additional adapters cover Hunyuan TurboS/T1, ERNIE 4.5 Turbo/Turbo VL, Step 3.7 Flash/3.5 Flash and GLM-Image/CogView-4. Hunyuan and ERNIE use China endpoints; StepFun offers separate China/global endpoints and credentials. Hunyuan, non-vision ERNIE and Step 3.5 reject image attachments before submission; Step 3.7 accepts images. These text adapters request JSON in the prompt and validate results with the shared contract, without claiming strict structured output. GLM images use adapted presets and model-specific sizes; downloads never carry API keys. Hunyuan and StepFun connection checks confirm saved configuration only. Veo and Runway are not yet adapted; the retired Sora Videos API is excluded.

Official references: [Hunyuan](https://cloud.tencent.com/document/product/1729/111007), [ERNIE](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb), [StepFun](https://github.com/stepfun-ai/Step-3.7-Flash), [GLM images](https://docs.z.ai/api-reference/image/generate-image), [Sora retirement](https://developers.openai.com/api/docs/deprecations).

Seedance and Grok support 4–15 seconds and first/last frame control in these adapters. Seedance requires a first frame when a last frame is supplied; Grok also accepts a last frame alone. Neither adapter forwards previous audio or multiple asset references. Native audio does not guarantee voice continuity. FLUX persists its task ID and cluster polling URL, validates the official polling domain/path before attaching a key, and downloads image results without credentials.

New official references: [Kimi](https://platform.kimi.com/docs/models), [GLM](https://docs.z.ai/api-reference/llm/chat-completion), [Seedance](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh), [Seedream](https://docs.volcengine.com/docs/ark/seedream-4-0-5-0?lang=zh), [MiniMax text](https://platform.minimax.io/docs/api-reference/text-openai-api), [MiniMax images](https://platform.minimax.io/docs/api-reference/image-generation-t2i), [Grok images](https://docs.x.ai/developers/model-capabilities/images/generation), [Grok boundaries](https://docs.x.ai/developers/model-capabilities/video/reference-to-video), [FLUX](https://docs.bfl.ai/quick_start/generating_images), [Mistral](https://docs.mistral.ai/api).

Each provider bills its own API account; a ChatGPT subscription does not include OpenAI API credits. The existing file parser extracts text before submission; image attachments require a vision-capable text model. This DeepSeek adapter accepts text only and explicitly rejects image attachments.

Videos remain sequential and inherit the actual last frame of the preceding shot in the same scene. RunningHub retains multiple reference images, preceding video/audio references and RH coin checks. Kling supports first/last frames and native audio on 2.6; this adapter does not inherit preceding audio or multiple image references. Hailuo supports a first frame and 6/10-second silent video; import shot audio for dialogue. Without a first frame, Hailuo supports landscape only. Use RunningHub for multiple references and voice continuity. Review generated output manually.

Wan image task IDs are persisted and resumed by querying the existing task after restart. Unknown paid submissions are never automatically retried. Video task IDs remain available in the task center, and adapters without a remote cancellation endpoint do not claim remote cancellation.

Official interfaces: [OpenAI Images](https://developers.openai.com/api/docs/guides/image-generation), [DeepSeek](https://api-docs.deepseek.com/), [Qwen](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope), [Wan images](https://help.aliyun.com/en/model-studio/text-to-image-v2-api-reference), [Claude Messages](https://platform.claude.com/docs/en/api/messages/create), [Gemini Interactions](https://ai.google.dev/api/interactions-api), [Kling](https://kling.ai/document-api/api/video/2-6/image-to-video/legacy), [Hailuo](https://platform.minimax.io/docs/api-reference/video-generation-i2v).

### ChatGPT: text and images

Connect a ChatGPT account once. The bundled Codex runtime generates screenplays, storyboards, and images. Generated reference images are saved directly to the requesting asset or shot and selected as the current version. There is no need to copy prompts, visit another page, or manually import the result.

This uses **Codex's ChatGPT account authorization**, not a general third-party OAuth integration. Muweave does not read or export browser cookies, session tokens, or account passwords. Legacy browser assistance remains for compatibility and is not part of the current direct image generation flow. Available capabilities and quotas depend on the account and runtime; authorization and quota failures report their actual errors.

The creative notes shown in AI conversations are user-facing summaries, not hidden model reasoning.

### RunningHub: video

1. Enter a RunningHub **consumer-member API Key**.
2. Choose **Standard** or **Plus**.
3. Select shots in the director workspace and confirm generation to add them to the queue.

The app uses the built-in [“导演台” workflow](https://www.runninghub.cn/workflow/2105215916815511553?source=workspace) on the Chinese site, with ID `2105215916815511553`. Users do not need to configure a workflow ID or node mappings. Standard maps to `instanceType: "default"`; Plus maps to `"plus"`. The choice is recorded when a task is queued, so later settings changes do not affect existing tasks.

The current generation path uses RH coins and runs one video task at a time. Before queuing and submitting, the app requires an account response with `apiType: "NORMAL"` and a positive RH coin balance. Workflow nodes must also pass an allowlist check. Keys that use wallet billing, unapproved nodes, and incompatible workflows block submission. RunningHub's billing records remain the source of truth for actual charges and balances.

An uncertain paid task creation is **never automatically resubmitted**. Verify the task on RunningHub first, then attach its existing Task ID in the task center and resume querying. Pausing the local queue stops new submissions; cancellation and charges for submitted tasks depend on the platform's actual state.

### FFmpeg: previews and exports

Windows development startup and packaging scripts prepare `vendor/ffmpeg/`. They reuse an eligible local Gyan build when available, otherwise download and verify a pinned version. Windows packages include FFmpeg, ffprobe, and license files, so users do not need to install them or configure paths. Source and license information ships in `resources/ffmpeg/NOTICE.txt`.

## Production workflow

### From story to storyboard

1. **Create a project and episode:** choose `16:9`, `9:16`, or `1:1`, then enter a story or start a screenwriter conversation.
2. **Apply the screenplay:** review the candidate and apply it to the script. Every AI script response offers two suggested polish directions, a custom direction, and a skip option. Polishing uses the selected candidate and returns a complete new candidate for manual application. Skipping does not start generation. Switching episodes, projects, or workspace pages saves edits first; manual saving is also available.
3. **Prepare assets:** define consistent appearance, clothing, location layout, and props. Upload PNG / JPEG / WebP images or generate references directly.
4. **Generate a storyboard:** review editable shots, actions, speakers, dialogue, duration, and asset associations. Structured imports reuse assets with matching names and types, and append new shots to the episode.
5. **Generate videos:** queue shots in order, inspect each result, and revise or manually retry as needed.
6. **Preview and export:** once every shot has a video, play the continuous episode preview and export the film or storyboard.

Script conversations accept attachments with any file extension, up to **10 files per turn** and **50 MB per file**. Text, DOCX, and PDF text can be extracted; PNG / JPEG / WebP are supplied as image inputs. Other files are attempted as text. Extraction is limited to 30,000 characters and the first 30 PDF pages. Scanned documents, protected files, and unsupported binary formats report a limitation; accepting an attachment does not mean every format can be analyzed.

### Character and scene continuity

The multiple-reference path uses MiniMax H3 Ref2VA. The app selects character, location, and prop images from the shot's associated assets, with up to **9 reference images**. Selected reference versions are fixed when queued. Later shots in the same scene wait for the previous shot and use its last frame and video as additional references, including the video's audio track when present. A failed predecessor pauses subsequent continuing shots. A new scene without any reference images uses the retained FL2VA path.

**Partial regeneration** reconnects retained neighbours: the preceding video's actual last frame is the opening reference, and the following retained video's actual first frame is the closing target. These take priority over manual boundary images, and retained video versions are fixed when queued. Consecutive selected shots chain through newly generated predecessors; only the segment's last shot targets the retained successor. Old videos selected for replacement are never used as boundary references. Missing neighbours leave that side without an automatic frame; the app does not skip gaps to find distant videos. Character, location and prop references remain separate identity references.

The generation dialog shows each shot's frame sources. Prompts include neighbouring action and composition context, restrict generation to the current shot's action and dialogue, and prohibit replaying the preceding shot, performing the following shot early, teleporting or unscripted cuts. RunningHub Ref2VA uses labelled boundary reference images; Kling uses its first/last-frame interface. This Hailuo adapter cannot target a last frame: regeneration that needs a retained successor is rejected before submission with a request to select RunningHub or Kling.

Prompts identify reference images by number and purpose, and include character definitions, speakers, and dialogue. Submitted shots are **4–15 seconds** long. Short shots are extended to 4 seconds; dialogue length can increase the required duration. Dialogue exceeding the current 10-second estimate limit must be split into separate shots. The whole batch is validated before video tasks are created.

References and previous-shot context improve continuity, but generative models can still alter characters, environments, or dialogue, and do not strictly lock the first frame. Use consistent definitions and selected reference images for key characters and locations, then review each shot.

### Video generation standard

These execution rules and output acceptance criteria apply to the desktop app, plugins, and Studio. Visual, dialogue, and voice requirements are added automatically to generation prompts.

1. **Generate sequentially:** use the project's episode order and director shot order, regardless of checkbox or input ID order. Submit one video task at a time and wait for generation, download, and local saving before submitting the next. Later tasks cannot bypass an earlier pending or paused task in the same batch.
2. **Continue from the preceding final frame:** within the same scene, extract the actual last frame of the preceding video and prioritize it over a manually assigned opening image. Supply the preceding video as a motion and camera reference. Continue its final pose and object positions without replaying completed actions or resetting the scene.
   **Reconnect retained successors:** single-shot or partial batch regeneration targets the actual first frame of the immediate retained successor, matching pose, prop state, eyelines, movement direction, set layout and lighting. Only same-scene neighbours in the same episode qualify; missing videos leave that boundary unset. Wait for new selected predecessors and never reference selected successors' old outputs, avoiding mixed versions and dependency cycles.
3. **Follow scripted transitions:** use consistent location, interior/exterior, and time-of-day identifiers. A scripted location or time change starts a new scene rather than inheriting the old scene's final frame. Character and voice identities remain consistent. Episodes do not automatically chain together.
4. **Preserve characters:** use selected references and character definitions to keep facial identity, age, hairstyle, clothing, and body proportions stable. Reject unscripted face or outfit changes, extra or missing limbs, malformed hands, morphing, and flicker.
5. **Preserve locations and props:** keep spatial geometry, set layout, light direction, colors, prop shapes, scale, and state consistent. Backgrounds and objects must not change, appear, or disappear without a scripted cause. Position changes caused by action must be continuous and coherent.
6. **Maintain the correct voice for each speaker:** retain speaker IDs, timbre, perceived age, accent, pitch range, and speaking manner. When the preceding video has audio, use a `video_audio` reference for established voices and ambience. Reuse a reference voice only for the same identified speaker, never for a different character. Emotion may change; vocal identity stays stable. Videos without audio remain visual references without an invented audio label.
7. **Keep dialogue exact and audio clean:** speak only the current shot's verbatim screenplay dialogue, in its original language and order. Do not repeat preceding dialogue or add background speech. Require natural pacing and matching lip sync, with no missing words, repeated syllables, truncated dialogue, sudden voice changes, clipping, buzzing, metallic or robotic artifacts. Silent shots contain no speech, and non-speaking characters keep their lips closed.
8. **Preserve continuity dependencies:** pause when a required new predecessor fails, is cancelled or has no usable output. Missing pinned neighbour media prevents submission. Initially absent neighbours add no dependency. Preserve task IDs for unknown submission outcomes and resume queries after manual verification; never automatically resubmit a paid task. Changing an earlier video marks later videos as needing an update.
9. **Review every shot:** check the transition, characters, environment, dialogue, lip sync, voice, and audio artifacts, then review the assembled episode. Correct rejected shots and manually regenerate affected successors. These are generation constraints and acceptance criteria; Ref2VA uses the final frame as a reference and does not guarantee exact frame locking, automatic quality approval, or zero deformation.

Audio reference implementation: [RunningHub Ref2VA nodes](https://github.com/HM-RunningHub/ComfyUI_RH_MinMaxH3/blob/main/minimax_h3_nodes/api/conditioning.py). Voice reference and dialogue rules: [MiniMax official full-reference prompting guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md).

### Script changes and video archives

Changing an existing episode's screenplay archives the old script, shots, and video associations while retaining media versions. The active director workspace and film page move to the new script. Generate new shots with the AI storyboard action. Renaming an episode alone does not create an archive.

Complete or cancel unfinished video tasks for that episode before changing its script. The screenplay and video archive entry at the top lets you inspect old content and play its videos. Archives travel with project ZIP exports and are retained when project history is rolled back.

### Film output

- MP4: H.264 + AAC at 30 fps, with 1920×1080, 1080×1920, or 1080×1080 output.
- Final MP4 exports and episode previews include the bilingual brand name “幕织 Muweave” as a text watermark in the lower-right corner with a safe margin. Original shot media remains unwatermarked. Windows uses the system Microsoft YaHei font.
- Shots are assembled in order using their configured durations. Mismatched aspect ratios are fitted with padding; short videos hold the final frame, and long videos are trimmed.
- Imported voice audio takes priority; otherwise the original video audio is retained. Missing audio is filled with silence.
- Episode previews use the same pipeline as exports and regenerate their cache when video, audio, or duration changes.
- SRT timings are allocated from shot durations, without forced speech alignment or burned-in subtitles. HTML storyboards can be printed.

## Plugins and Studio

Plugins reuse the desktop app's SQLite library, credentials, media, and queue. Studio exposes the same screenplay, asset, director, film, and task interfaces, with browser uploads and downloads.

### Build the plugin

```sh
node scripts/prepare-ffmpeg.mjs
npm run package:plugin
```

Artifacts are written to `release/`. Their version comes from [package.json](package.json):

| Artifact                               | Purpose                                       |
| -------------------------------------- | --------------------------------------------- |
| `muweave-plugin/`                      | Codex local plugin directory                  |
| `Muweave-<version>-plugin.zip`         | Plugin archive                                |
| `Muweave-<version>.ipollowork-plugin`  | Package for manual iPolloWork import          |
| `.agents/plugins/marketplace.json`     | Codex local marketplace index                 |
| `iPolloWork-local-plugin-review.patch` | Host patch for explicit local plugin approval |

Building does not install the plugin or bundle Muweave into iPolloWork.

### Codex

From the Muweave repository root:

```sh
codex plugin marketplace add ./release
codex plugin add muweave@muweave-local
```

Reload plugins or start a new conversation, then ask to open Muweave Studio, write and save an episode, or turn its script into continuous storyboard shots. MCP Apps hosts can embed `ui://muweave/studio`; other interfaces can open the local URL returned by `muweave_studio_info`.

### iPolloWork

Manually select the `.ipollowork-plugin` file under Settings → Extensions → Plugins → Add. Hosts with local approval support show permissions, service source, and file fingerprints. Approve the package to install it, then open Muweave Studio.

Older hosts that accept only signed local services reject this development plugin. Review and apply the [local plugin approval patch](scripts/ipollowork-local-plugin-review.patch) to compatible iPolloWork source, or use a version that already provides this approval entry. Installation is manual; Muweave is not bundled or automatically installed with iPolloWork.

### Tools and runtime

| MCP tool              | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `muweave_studio_info` | Obtain the Studio page and local connection URL                |
| `muweave_read`        | Read projects, history, and tasks                              |
| `muweave_edit`        | Edit projects, episodes, assets, and shots                     |
| `muweave_generate`    | Generate text and images, and manage video generation requests |
| `muweave_import`      | Import user-selected workspace files                           |
| `muweave_export`      | Build episode previews and export ZIP, MP4, SRT, or HTML       |

Equivalent iPolloWork actions are `studio-info`, `read`, `edit`, `generate`, `import`, and `export`. Video submission and retry require `confirmed: true`, representing user authorization for that paid generation. Tools do not expose credential reading or replacement.

Local plugins require Node.js 22.13+ and a Muweave 0.2.x runtime. Generated packages point to the current built source checkout. Rebuild and update the plugin after relocating the source or moving to another computer. `MUWEAVE_HOME` can identify a built checkout; `MUWEAVE_EXECUTABLE` can identify a compatible installed executable.

After `npm run build`, use `npm run studio` to start Studio in the background. It listens only on `127.0.0.1` and generates a temporary session URL on each start; do not publish or forward that URL. Plugins reuse an existing Muweave process when available. A backend started with `--plugin-server` continues processing tasks after the host closes, until the process exits. It does not install a Windows service or start at login.

## Data and backups

- **Library:** find the actual location in settings. On Windows, the default is `%APPDATA%/muweave/library/`.
- **Database and files:** `director.sqlite` stores projects, conversations, history, and tasks. `projects/<id>/media/` holds media, and `projects/<id>/chat/` holds attachments.
- **Credentials:** Electron safeStorage encrypts the RunningHub Key using operating system facilities. The key is not returned to the frontend or included in project ZIPs or plugin packages. Text, image and video keys are stored separately by channel, provider and region. Plugin tools use the selected services and cannot read or modify credentials.
- **Access:** the desktop uses Zod-validated IPC; Studio uses a local HTTP service with temporary session validation. Both reuse the same command contracts.
- **Project ZIPs:** include current project state, screenplay archives, media versions, conversation attachments, and task provenance. They exclude SQLite rollback history, keys, account sessions, and global settings. Imports create new projects and do not execute old tasks automatically.
- **Limits and recovery:** exported media and attachments are limited to 512 MB. Imports validate paths and uncompressed size. The latest 100 content revisions can be rolled back; canvas layout changes do not create history entries.

For larger projects, stop the desktop app and Studio before backing up the full library. Export an archive before deleting a project or episode if you need to retain its content; deletion does not create an automatic backup.

Muweave has no project cloud synchronization service. AI requests send the relevant prompts, attachment content, or reference media to the selected service. Local storage does not mean generation is fully offline.

### Migrating from Director Desk

Export a project ZIP from the old app, import it through Muweave's project archive action, and reconnect accounts. Muweave uses a separate application identity and library. It does not automatically copy old keys, browser sessions, or the entire old database. This repository is the authoritative source for further development.

## Development and verification

### Commands

| Command                         | Purpose                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| `npm run dev`                   | Prepare Windows FFmpeg and start development mode           |
| `npm run build`                 | Check TypeScript and build Electron / React                 |
| `npm start`                     | Run the existing build                                      |
| `npm run studio`                | Run the existing build as a Studio backend                  |
| `npm test`                      | Test storage, queue, media, and image generation contracts  |
| `npm run test:desktop`          | Run end-to-end tests in a real Electron desktop             |
| `npm run test:plugin`           | Test the local service, MCP, Studio, and plugin integration |
| `npm run package:plugin`        | Build and package plugins                                   |
| `npm run package:win`           | Build a Windows x64 portable executable                     |
| `npm run package:win:installer` | Build a Windows x64 installer                               |
| `npm run package:mac`           | macOS DMG build entry; not verified on a physical machine   |

Windows output names are `release/Muweave-<version>-Windows.exe` and `release/Muweave-<version>-Setup.exe`. The version comes from `package.json`; these naming patterns do not imply a published installer is available.

Full verification sequence in PowerShell:

```powershell
node scripts/prepare-ffmpeg.mjs
$env:PATH = "$(Join-Path (Get-Location) 'vendor\ffmpeg');$env:PATH"
npm test
npm run build
npm run test:desktop
npm run test:plugin
```

Tests invoke `ffmpeg` from PATH; the setting above affects only the current terminal. Plugin UI tests also require Microsoft Edge. Desktop and plugin tests use temporary libraries, with screenshots and results in `test-results/`. Generation calls in automated tests use controlled substitutes and do not submit real paid video tasks.

### Source layout

```text
src/
  main/          Electron, SQLite, Codex, RunningHub, media, and Studio service
    workflows/   Built-in workflows and fallback for scenes without references
  preload/       Minimal desktop IPC bridge
  shared/        Shared Zod contracts, director prompts, subtitles, and tool definitions
  renderer/      React workspace, storyboard canvas/list, languages, and themes
    assets/      Official brand assets
  plugin/        Host service entry and Muweave creative skill
scripts/         FFmpeg preparation, plugin packaging, and iPolloWork approval patch
tests/           Core, image, desktop, and plugin verification
```

Development rules are in [AGENTS.md](AGENTS.md). `node_modules/`, `dist/`, `release/`, `test-results/`, and `vendor/ffmpeg/` are local dependencies or generated artifacts, not source files to commit.

## Troubleshooting and limitations

| Issue                                                  | Action                                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT authorization, timeout, or quota error         | Inspect the actual error and check the account and network. Reconnect in settings when needed, then retry manually           |
| RunningHub rejects a key or node                       | Use a consumer-member Key with RH coins. Workflow changes require checking the app's node contract; do not bypass validation |
| Task creation times out with an unknown billing result | Verify platform tasks and billing, then attach an existing Task ID. Do not submit a duplicate                                |
| Later shots are paused                                 | Check whether the previous shot in the same scene completed, failed, or was cancelled, and resolve that task                 |
| No continuous episode preview                          | Ensure every shot has a usable video, then check FFmpeg. Reinstall a Windows package if its bundled binaries are missing     |
| Plugin cannot find Studio                              | Check that the source is built and plugin paths are valid. Rebuild and reinstall after moving directories                    |
| Attachment cannot be analyzed                          | Use extractable text or supported images. Scanned PDFs are not automatically processed with OCR                              |

Media downloads accept only approved HTTPS CDNs for the selected provider and never carry API keys. Videos are limited to 1 GB per file. Other CDNs, expired links or unsupported formats require manual import; task IDs are retained.

Film assembly currently provides basic episode concatenation, without automatic TTS, lip synchronization, multitrack editing, transitions, or automatic music. Character, environment, first-frame, and dialogue accuracy require review. macOS packaging, account generation, and exports have not been verified on a physical machine.

## License

Muweave's original source code and documentation are licensed under the **[Apache License 2.0](LICENSE)**. Commercial use, modification, and redistribution are permitted subject to its license and notice requirements. See [NOTICE](NOTICE) for copyright and third-party information.

Third-party components retain their respective licenses. FFmpeg / ffprobe in the Windows package use their accompanying GPL license and are not relicensed under Apache-2.0; build information and license files are in `resources/ffmpeg/`. Desktop distributions and plugin packages include Muweave's `LICENSE` and `NOTICE`.
