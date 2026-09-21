# Third-party notices

This project is distributed under the Apache License 2.0 (see [LICENSE](LICENSE)). It incorporates and depends on a large number of open source components, each governed by its own license. This file records those components, how they are used, and the obligations we take on.

**Audit baseline**: 135 declared direct dependencies (119 runtime + 16 development) and a resolved dependency tree of **1,530 packages** from `pnpm-lock.yaml`.

**How this was verified**: every package in `node_modules` was scanned programmatically for its declared license, and every non-permissive license was read in full from the package's own `LICENSE` file. The scripts live in `.vscode/aic/_txt/` (`_licaudit.mjs`, `_licdetail.mjs`, `_directmap.mjs`). Audit date: 2026-09-18.

## Copyleft audit result

> **There is no GPL-2.0, GPL-3.0, AGPL, LGPL, SSPL, Elastic License, BUSL or CC-BY-NC dependency anywhere in the tree.**
>
> - `jszip@3.10.1` is dual-licensed `(MIT OR GPL-3.0-or-later)`. We elect **MIT**, so no GPL source-provision or derivative-works obligation applies.
> - `dompurify@3.4.13` is dual-licensed `(MPL-2.0 OR Apache-2.0)`. We elect **Apache-2.0**.
> - `lightningcss` (and its platform binary package) is **MPL-2.0**. MPL-2.0 is a *file-level* copyleft license: obligations attach only to modified MPL files and do not propagate to code that merely calls it. It is a build-time dependency of Tailwind v4 and is unmodified.
> - `css-value@0.0.1` declares **no license** and ships no license file. It arrives transitively through the `webdriverio` chain and is never called by this project. We redistribute it unmodified and make no claim about it. See "Open items" below.
>
> License distribution across all 1,530 packages: MIT 1,119 · Apache-2.0 176 · ISC 97 · BSD-3-Clause 39 · BSD-2-Clause 31 · OFL-1.1 20 · BlueOak-1.0.0 13 · CC0/Unlicense/MIT-0/0BSD 12 · combination licenses 20 · MPL-2.0 (incl. dual) 5 · CC-BY-4.0 2 · undeclared 1.

## What we do and do not do

- We **do not modify, fork, patch or vendor** any third-party package. Everything is integrated through its public API and redistributed by the package manager under its original license.
- We **do not train or fine-tune any model**. The embedding model is used with its original weights.
- We **do not use any third-party training dataset**. Knowledge-bank content is imported by the end user from their own files and never leaves their machine.
- We **distribute no credentials**. API keys live only in the user's local encrypted vault.

## Category 1 — AI framework, agent runtime and model access

| Component | Version | License | How it is used | Key obligations |
| --- | --- | --- | --- | --- |
| `mastra` | 1.30.0 | Apache-2.0 (excluding `ee/`) | Core framework that builds and runs the local AI service | Retain LICENSE/NOTICE; do not use `ee/` content |
| `@mastra/core` | 1.67.0 | Apache-2.0 (excluding `dist/auth/ee`, `dist/agent-builder/ee`) | Agent runtime, server primitives, workspace tools | Same as above |
| `@mastra/ai-sdk` | 1.10.3 | Apache-2.0 | Bridges the AI SDK UI message stream to the agent stream | Retain license |
| `@mastra/memory` | 1.30.0 | Apache-2.0 | Observational memory, working memory, semantic recall | Retain license |
| `@mastra/rag` | 2.6.3 | Apache-2.0 | Vector retrieval, document chunking, reranking, GraphRAG | Retain license |
| `@mastra/libsql` | 1.23.0 | Apache-2.0 | Default storage domain | Retain license |
| `@mastra/duckdb` | 1.9.0 | Apache-2.0 | Observability storage domain (DuckDB itself is MIT) | Retain license |
| `@mastra/fastembed` | 1.3.1 | Apache-2.0 | Local ONNX embedding inference | Model weights carry their own license, see Category 2 |
| `@mastra/mcp` | 1.18.0 | Apache-2.0 | MCP client over HTTP/SSE and stdio, with OAuth | Retain license |
| `@mastra/observability` | 1.17.8 | Apache-2.0 | Runtime metrics and tracing | Retain license |
| `@mastra/tavily` | 1.1.2 | Apache-2.0 | Tavily integration package | Service itself is not open source, see Category 3 |
| `@mastra/agent-browser` | 0.5.3 | Apache-2.0 | Browser automation capability | Retain license |
| `@mastra/browser-firecrawl` | 0.2.3 | Apache-2.0 | Firecrawl browser capability | Retain license |
| `@mastra/stagehand` | 0.3.5 | Apache-2.0 | Stagehand browser capability (upstream Stagehand is MIT) | Retain license |
| `@mastra/editor` | 0.15.0 | **Mixed**: Apache-2.0 outside `ee/`; **Mastra Enterprise Edition License v1.0** for `ee/` | Editor capability. See the compliance note below | **Do not redistribute `ee/` content** |
| `ai` (Vercel AI SDK) | 7.0.101 | Apache-2.0 | UI message protocol and streaming primitives | Retain LICENSE/NOTICE |
| `@ai-sdk/react` | 4.0.104 | Apache-2.0 | React streaming state hooks | Retain license |
| `@ai-sdk/openai` | 4.0.66 | Apache-2.0 | OpenAI and OpenAI-compatible endpoints | Retain license |
| `@ai-sdk/anthropic` | 4.0.53 | Apache-2.0 | Anthropic endpoints | Retain license |
| `@ai-sdk/google` | 4.0.70 | Apache-2.0 | Google Gemini endpoints | Retain license |
| `@ai-sdk/openai-compatible` | 3.0.48 | Apache-2.0 | Generic OpenAI-compatible gateway adapter | Retain license |

### Compliance note — `@mastra/editor` Enterprise Edition

`@mastra/editor` ships a mixed license. Everything outside `ee/` is Apache-2.0. Anything under a directory named `ee/` — including `dist/ee/workspace/skills/**` — falls under the Mastra Enterprise Edition License v1.0 (Copyright (c) 2026 Kepler Software, Inc.), which permits production use **only** under a written agreement with Kepler Software, Inc. and explicitly forbids copying, merging, publishing, distributing, sublicensing and selling the software.

The current source tree no longer reaches into that directory. `src/mastra/routes/skills.ts` now reads built-in skills only from the repository-owned `resources/builtin-skills/` directory, and `electron-builder.yml` excludes the editor package's `ee/` paths from packaged files. **The source-level compliance fix is complete; a clean packaged-artifact scan remains required before release.**

## Category 2 — models and data

| Component | Version / source | License | How it is used | Key obligations |
| --- | --- | --- | --- | --- |
| `BAAI/bge-small-en-v1.5` embedding model (384-dim), loaded via the `fastembed.small` alias | ONNX conversion distributed from `storage.googleapis.com/qdrant-fastembed/`; upstream at `huggingface.co/BAAI/bge-small-en-v1.5` | **MIT** (OSI-approved, commercial use permitted; the conversion carries the upstream terms) | Local CPU inference for knowledge-bank vectorisation; cached locally | Retain MIT attribution and license text; do not imply upstream endorsement |
| `MastraAgentRelevanceScorer` | Shipped with `@mastra/rag` 2.6.3 | Apache-2.0 | Optional reranking stage | Retain license |
| Training datasets | — | — | **None used.** No model is trained or fine-tuned | — |
| Knowledge-bank data | Supplied by the end user | The user's own or licensed content | Stored only in the user's local LibSQL database | The app ships no third-party corpus and aggregates nothing |

## Category 3 — third-party services

| Service | Access path | Terms | How it is used | Key obligations |
| --- | --- | --- | --- | --- |
| Model provider APIs (OpenAI, Anthropic, Google, any OpenAI-compatible gateway) | Configured by the user, BYOK | Each provider's own terms of service | The user calls providers with their own keys. This app does not proxy, relay or resell API access | The user is responsible for regional and use-case compliance. We distribute no model weights |
| Tavily Search API | `@tavily/core` 0.7.12, `@mastra/tavily` 1.1.2 | Commercial API terms (not open source) | One of four optional web-search engines, enabled by the user's own key | Quota, billing and data-processing terms apply; queries leave the machine. Surfaced to the user in-app |
| Firecrawl API | `firecrawl` 4.40.0, `@mastra/browser-firecrawl` 0.2.3 | Commercial API terms; the SDK itself is MIT | Optional scraping and structured extraction engine | As above; respect target-site robots and copyright |
| Provider-native web search | Provided by the configured model vendor | The vendor's terms | Optional search engine | As above |
| GitHub API | `api.github.com` | Platform terms; hosted content keeps its own license | Listing and downloading public skill repositories | Rate limits apply; only public resources are accessed; each repository's license is respected |
| skills.sh | `skills.sh` | Site terms | Optional community skill leaderboards | Rate limits and site terms apply |
| npm public registry | `registry.npmjs.org` | Package terms per package; registry service terms | Dependency distribution channel | Versions and integrity hashes are pinned in `pnpm-lock.yaml` |

## Category 4 — storage, parsing and network

| Component | Version | License | How it is used |
| --- | --- | --- | --- |
| `@libsql/client` | 0.18.0 | MIT (LibSQL/SQLite itself is public domain) | Local database client for config, sessions and the knowledge bank |
| DuckDB (via `@mastra/duckdb`) | 1.9.0 | MIT | Local columnar storage for observability metrics |
| `hono` | 4.13.8 | MIT | HTTP routing framework for the local AI service |
| `zod` | 4.6.5 | MIT | Runtime validation across IPC contracts, config normalisation and API boundaries |
| `pdf-parse` | 2.4.5 | Apache-2.0 | PDF text extraction |
| `pdfjs-dist` | 6.3.289 | Apache-2.0 | PDF parsing and rendering |
| `mammoth` | 1.12.3 | BSD-2-Clause | `.docx` to HTML conversion for knowledge ingestion |
| `xlsx` (SheetJS Community Edition) | 0.18.5 | Apache-2.0 | Spreadsheet parsing. **Pinned at 0.18.5** because later upstream releases moved to a proprietary license |
| `adm-zip` | 0.6.1 | MIT | Skill-package extraction, behind our own path-traversal and size-limit checks |
| `@fastify/busboy` | 3.2.2 | MIT | Streaming multipart parsing for resumable chunked uploads |
| `nanoid` | 6.0.1 | MIT | Short ID generation |
| `tokenlens` | 1.3.1 | MIT | Model context-window and token-budget lookup |

## Category 5 — Electron runtime, security and build infrastructure

| Component | Version | License | How it is used |
| --- | --- | --- | --- |
| `electron` | 44.3.0 | MIT | Desktop runtime. Bundles Chromium (BSD-3-Clause) and Node.js (MIT); their notices are retained in the packaged artifact |
| `@electron-toolkit/preload` | 3.0.2 | MIT | Preload-script helpers |
| `@electron-toolkit/utils` | 4.0.0 | MIT | Main-process platform helpers |
| `@electron-toolkit/tsconfig` | 2.0.0 | MIT | Base TypeScript config (we derive three project configs from it) |
| `electron-builder` | 26.15.3 | MIT | Packaging for Windows NSIS, macOS DMG and Linux AppImage/snap/deb |
| `electron-vite` | 6.0.0-beta.1 | MIT | Build orchestration for the three entry points (pinned exactly) |
| `node-pty` | 1.1.0 | MIT | Real PTY terminal sessions; native binary, notices retained |
| `@xterm/xterm` | 6.0.0 | MIT | Terminal front-end rendering |
| `@xterm/addon-fit` | 0.11.0 | MIT | Terminal auto-sizing |
| `vscode-jsonrpc` | 9.0.2 | MIT | LSP transport |
| `vscode-languageserver-protocol` | 3.18.3 | MIT | LSP protocol types |
| `playwright-core` | 1.63.0 | Apache-2.0 | Browser automation driver (browser binary downloaded at install time) |
| Playwright Chromium binary | fetched by `scripts/install-browser.mjs` | Chromium is BSD-3-Clause plus bundled third-party licenses | Embedded browser view and browser automation; downloaded at runtime, never vendored into the repository |
| `firecrawl` | 4.40.0 | MIT | Firecrawl service client |
| `@tavily/core` | 0.7.12 | MIT | Tavily service client |
| `@biomejs/biome` | 2.5.13 | MIT OR Apache-2.0 — we elect **MIT** | Linting and formatting |
| `typescript` | 7.0.2 | Apache-2.0 | Type system and the `pnpm typecheck` three-project check |
| `vite` | 8.3.0 | MIT | Renderer build |
| `@vitejs/plugin-react` | 6.1.1 | MIT | React compilation |
| `@tailwindcss/vite` | 4.3.3 | MIT | Tailwind v4 Vite integration |
| `tailwindcss` | 4.3.3 | MIT | Utility CSS engine |
| `lightningcss` (+ `lightningcss-win32-x64-msvc`) | 1.32.0 / 1.33.0 | **MPL-2.0** | Build-time CSS processing, pulled in by Tailwind v4. File-level copyleft only; unmodified |
| `concurrently` | 10.0.5 | MIT | Parallel process startup |
| `@types/node` / `@types/react` / `@types/react-dom` | 26.5.1 / 19.3.0 / 19.3.0 | MIT | Type declarations |
| `jszip` | 3.10.1 | `(MIT OR GPL-3.0-or-later)` — we elect **MIT** | Transitive ZIP handling |
| `dompurify` | 3.4.13 | `(MPL-2.0 OR Apache-2.0)` — we elect **Apache-2.0** | Transitive HTML sanitisation |
| `khroma` | 2.1.0 | MIT (declared only in the package's `license` file, not in `package.json`) | Transitive CSS colour maths via mermaid |
| `css-value` | 0.0.1 | **None declared** | Transitive, reached via the `webdriverio` chain; never called by this project. Redistributed unmodified with no claim made |

## Category 6 — front end, UI and design assets

| Component | Version | License | How it is used |
| --- | --- | --- | --- |
| `react`, `react-dom` | 19.3.0 | MIT | Rendering framework |
| `@tanstack/react-query` | 5.102.8 | MIT | Server-state caching and request orchestration |
| `@tanstack/react-router` | 1.170.36 | MIT | Routing (hash history, safe under `file://`) |
| `zustand` | 5.0.15 | MIT | Client-only transient state |
| `i18next`, `react-i18next`, `i18next-browser-languagedetector` | 26.4.2 / 17.0.14 / 8.2.1 | MIT | Internationalisation (zh / en) |
| `@base-ui/react` | 1.8.0 | MIT | Unstyled component primitives |
| `@radix-ui/react-use-controllable-state` | 1.2.6 | MIT | Controllable-state hook |
| `@shadcn/react` | 0.3.1 | MIT | shadcn/ui component system, consumed as copied local source. Upstream MIT attribution is retained for those files |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | Variant style composition |
| `clsx` | 2.1.1 | MIT | Class-name joining |
| `tailwind-merge` | 3.7.0 | MIT | Tailwind class conflict resolution |
| `lucide-react` | 1.46.0 | ISC | Icon set, unmodified |
| `@iconify-json/material-icon-theme` | 1.2.70 | MIT | File-tree icons, unmodified |
| `cmdk` | 1.1.1 | MIT | Command palette primitive |
| `sonner` | 2.0.8 | MIT | Toasts |
| `motion`, `framer-motion` | 13.3.0 | MIT | Declarative animation |
| `border-beam` | 1.3.0 | MIT | Decorative border animation |
| `@rive-app/react-webgl2` | 4.34.2 | MIT | Rive vector animation runtime |
| `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` | 6.3.1 / 10.0.0 / 3.2.2 | MIT | Drag-and-drop sorting |
| `react-resizable-panels` | 4.12.4 | MIT | Resizable panel layout |
| `react-use-measure` | 2.1.7 | MIT | Element measurement |
| `use-stick-to-bottom` | 1.1.6 | MIT | Stream scroll pinning |
| `next-themes` | 0.4.6 | MIT | Light/dark theme switching |
| `recharts` | 3.10.1 | MIT | Charts |
| `@xyflow/react` | 12.11.6 | MIT | Node-graph visualisation |
| `react-activity-calendar` | 3.2.1 | MIT | Activity heatmap |
| `embla-carousel-react` | 8.6.0 | MIT | Carousel |
| `react-day-picker` | 10.0.1 | MIT | Date picker |
| `input-otp` | 1.5.0 | MIT | OTP input |
| `media-chrome` | 4.19.2 | MIT | Media controls |
| `date-fns` | 4.4.0 | MIT | Date formatting and localisation |
| `node-emoji` | 2.2.0 | MIT | Emoji shortcode parsing |
| `@open-file-viewer/core`, `@open-file-viewer/react` | 0.1.46 | MIT | Workspace file preview |

## Category 7 — editor, markdown rendering and code intelligence

| Component | Version | License | How it is used |
| --- | --- | --- | --- |
| `codemirror` | 6.0.2 | MIT | Editor core |
| `@codemirror/state`, `view`, `language`, `autocomplete`, `lint`, `search`, `lang-json` | 6.7.1 / 6.43.11 / 6.12.4 / 6.20.3 / 6.9.7 / 6.7.2 / 6.0.2 | MIT | Editor state, view, grammar, completion, diagnostics, search, JSON support |
| `@uiw/react-codemirror` | 4.25.11 | MIT | React binding for CodeMirror |
| `@uiw/codemirror-extensions-langs` | 4.25.11 | MIT | Language extension bundle |
| `react-codemirror-merge` | 4.25.11 | MIT | Diff view |
| `shiki` | 4.4.3 | MIT | Syntax highlighting. Its bundled TextMate grammars and themes carry their own (mostly MIT) licenses and are redistributed unmodified |
| `streamdown` | 2.6.0 | Apache-2.0 | Streaming markdown rendering |
| `@streamdown/cjk`, `code`, `math`, `mermaid` | 1.0.3 / 1.1.1 / 1.0.2 / 1.0.2 | Apache-2.0 | CJK typography, code blocks, maths and Mermaid diagrams (mermaid and katex are MIT) |
| `ansi-to-react` | 6.2.6 | BSD-3-Clause | ANSI escape rendering |
| `react-jsx-parser` | 2.4.1 | MIT | Runtime JSX parsing for in-app previews |

## Category 8 — fonts

All 20 bundled typefaces are open source fonts under the **SIL Open Font License 1.1**, distributed through the official `@fontsource/*` and `@fontsource-variable/*` packages at version `5.3.0`.

Geist · Geist Mono · Inter · Noto Serif SC · Bricolage Grotesque · Public Sans · Plus Jakarta Sans · Space Grotesk · Space Mono · JetBrains Mono · Fira Code · Nunito · Cormorant Garamond · Cinzel · Orbitron · Rajdhani · Shippori Mincho · Silkscreen · VT323 · Press Start 2P

**OFL-1.1 obligations**: retain the copyright notice and the license text; the fonts may not be sold on their own; a modified font may not use a reserved font name. **We ship every font file unmodified.** OFL is a font-specific license and does not extend to application code.

## Open items

| # | Item | Status | Plan |
| --- | --- | --- | --- |
| 1 | `@mastra/editor` `ee/` content is reachable and copied at runtime | **Source fixed; artifact scan pending** | Keep built-in skills under `resources/builtin-skills/`, retain the package exclusion, and scan a clean packaged artifact before release |
| 2 | `css-value@0.0.1` declares no license | Disclosed | Drop the `webdriverio` chain if possible to remove the ambiguity entirely |
| 3 | Per-file licenses of `shiki` TextMate grammars and themes | Pending | Verify file by file and extend this notice |
| 4 | Third-party notices bundled inside the Playwright Chromium binary | Pending | Retain Chromium's own license files in the packaged artifact and reference them here |
| 5 | Third-party notices bundled inside Electron (Chromium, Node.js) | Pending | Retain Electron's `LICENSES.chromium.html` in the packaged artifact and reference it here |
| 6 | Per-font copyright holders and reserved font names | Pending | Extract from each `@fontsource` package's `LICENSE` file into this notice |

## Reproducing this audit

```bash
node .vscode/aic/_txt/_licaudit.mjs     # scan the whole tree, print the distribution and flag risks
node .vscode/aic/_txt/_licdetail.mjs <package...>   # read a package's actual license file
node .vscode/aic/_txt/_directmap.mjs    # map direct dependencies to versions and licenses
```
