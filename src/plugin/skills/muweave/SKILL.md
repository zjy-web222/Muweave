---
name: muweave
description: Use Muweave 幕织 to create and revise episodic screenplays, maintain character and location reference assets, edit storyboards, generate continuous RunningHub videos with RH coins, and assemble or export films. Open Muweave Studio when a visual workbench helps.
---

# 幕织 / Muweave

Use the installed plugin's `muweave_*` MCP tools, or the equivalent iPolloWork extension actions for plugin `muweave`: `studio-info`, `read`, `edit`, `generate`, `import`, `export`. If discovery reports the tools unavailable, explain the actual runtime error. Do not invent project or task IDs.

1. Read project summaries, then the requested project. Preserve episode IDs, asset IDs, selected reference images, existing videos, dialogue, and confirmed appearance settings.
2. Use the current host conversation for screenplay and storyboard reasoning. Save structured results through `edit`; there is no need to launch another model merely to think. The project's stored `scriptChat` turns may contain user-facing creative summaries, never hidden chain-of-thought. A candidate screenplay can be saved as an assistant turn; apply it to the episode only when requested.
3. Use `edit` with the existing command contract. `episode` stores a screenplay and automatically archives the previous screenplay and video-linked shots. `parse` imports structured JSON: `{episodeTitle?, script?, assets?, shots?}`. Read actual asset and shot schemas from the tool before preparing data. Existing assets are reused; reference IDs must come from the project.
4. For images, prefer the host's available image-generation tools and import their saved files into the correct asset or frame slot. The plugin's `generateImage` uses the separately connected Muweave Codex runtime; check connection before claiming it is available. Do not copy login tokens between hosts.
5. Video generation consumes RH coins. Require an explicit user request that authorizes the selected shot or batch, then use `generate` with `{command:{type:"queue",projectId,shotIds,stopOnFailure:true},confirmed:true}`. The software enforces consumer-member billing and the audited RunningHub workflow. Keep the user's Standard/Plus choice. Never silently change to wallet billing.
6. Let the persisted queue run sequentially. Same-scene shots reuse previous video and last frame plus character/location/prop references. This improves consistency but cannot guarantee a generative model never drifts. Read job state; do not resubmit a slow task. An uncertain submission needs manual verification or attachment of the known task ID.
7. Open `studio-info` to show Studio. Return its local URL and open it in the host browser/panel when supported. MCP Apps hosts can render `ui://muweave/studio`; iPolloWork contributes the native Studio workbench. Keep tools usable when no page is open.
8. Import only real user-selected files within the active workspace. `paths` are workspace-relative. Studio also supports selecting and uploading files. Secrets belong in Studio settings, never tool arguments, chat transcripts, generated files, or plugin packages.
9. Export only after the requested shots have usable videos. Use `previewEpisode` for continuous playback, `exportEpisode` for MP4/SRT/HTML, or `exportArchive` for the project ZIP. Report actual completed files and known limitations. Do not start paid generation to test installation.

Keep one authoritative local Muweave library and queue shared by desktop and plugin. Installation uses a local Muweave 0.2.0 runtime; `MUWEAVE_HOME` can identify a built development checkout, or `MUWEAVE_EXECUTABLE` an installed executable. Setup must not erase existing projects, copy browser sessions, or disclose API keys.
