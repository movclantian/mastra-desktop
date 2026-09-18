# mastra-desktop

A local-first, multi-agent coding workbench for the desktop. Built with Electron, React 19, TypeScript and the [Mastra](https://mastra.ai) agent framework.

Everything runs on your own machine: the agent runtime, the vector store, the embeddings model and the conversation history. You bring your own model API keys — the app never proxies your traffic through a third-party backend.

## What it does

- **Multi-agent workbench** — a main coding agent with `explorer` and `reviewer` sub-agents, plus user-defined agents and agent teams orchestrated with supervisor / handoff / workflow / council strategies.
- **Plan / build / review modes** — three work modes with a shared permission model. Plan mode requires an explicit plan approval before any tool runs; every tool call is classified into a category and gated by rules you control.
- **Bring your own model** — a gateway that talks to OpenAI, Anthropic, Google Gemini and any OpenAI-compatible endpoint. Configure providers and keys in the UI; keys are stored in an encrypted local vault.
- **Knowledge library (RAG)** — local vector search with `fastembed` embeddings and LibSQL, recursive chunking, optional reranking, plus a knowledge-graph mode.
- **Integrated workspace** — file tree, CodeMirror change diffs, a real PTY terminal, an embedded live browser view, and an LSP-backed code intelligence tool.
- **Skills hub** — load skills from `SKILL.md` bundles, browse community marketplaces, and connect MCP servers over HTTP/SSE or stdio.
- **Local-first privacy** — credentials are held by the main process in an AES-256-GCM vault and handed to the agent runtime over a local named pipe, never over the network.

## Architecture

Three processes:

```
Electron main process  ──spawn──▶  local Mastra AI service  (http://localhost:4111)
        │  IPC (contract + zod)              │
        ▼                                    │ HTTP + SSE
Electron renderer (React)  ◀───────────────┘
```

| Path | Role |
| --- | --- |
| `src/main` | Electron main process: window lifecycle, spawning and supervising the local AI service, PTY terminals, the credential vault and broker |
| `src/mastra` | The local AI backend: Mastra agents, tools, RAG, memory, MCP client, skills registry and the HTTP API |
| `src/preload` | `contextBridge` surface — 7 namespaces, every argument and result validated with zod |
| `src/shared` | Contract layer and single source of truth for each IPC channel (request / result / event schemas) |
| `src/renderer` | React front end, organised with Feature-Sliced Design (`app` / `pages` / `widgets` / `features` / `entities` / `shared`) |

## Requirements

- Node.js 22 or newer (Node 22 LTS recommended)
- pnpm 12
- Windows, macOS or Linux

## Getting started

```bash
pnpm install
pnpm dev
```

`pnpm dev` first ensures the bundled Chromium runtime is present, then starts the renderer, the main process and the local Mastra service together.

On first launch, open **Settings → Providers**, add a provider and paste your own API key, then pick a model in the chat composer.

### Build

```bash
pnpm build:win     # Windows installer
pnpm build:mac     # macOS disk image
pnpm build:linux   # Linux AppImage / snap / deb
```

A full build runs the browser runtime check, the type check, `mastra build` and `electron-vite build`, then packages with electron-builder.

### Other scripts

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Type-check the Node, web and Mastra projects |
| `pnpm lint` | Biome check and autofix |
| `pnpm format` | Biome format |

## Configuration

Configuration lives in a local LibSQL database (by default under your home directory, and relocatable from **Settings → Storage**). Model provider credentials are stored separately in an encrypted vault and are never written into the database or sent anywhere except the provider endpoint you configured.

## Project documentation

- `DESIGN.md` — the design system specification (tokens, typography, layout, component rules)
- `AGENT.md` — engineering conventions for the codebase
- `docs/` — component references used while developing the UI

## Third-party resources

This project is built on open source software. A full inventory — versions, licences, how each resource is used, and the obligations we take on — is maintained in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

The major building blocks are Apache-2.0 (the Mastra framework and the Vercel AI SDK), MIT (Hono, zod, node-pty, the React and TanStack ecosystem) and OFL-1.1 (the bundled web fonts). There is no GPL, AGPL or other strong copyleft dependency in the tree.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Copyright 2026 mastra-desktop contributors.

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the LICENSE file for the specific language governing permissions and limitations under the License.

## Contributing

Issues and pull requests are welcome. Please run `pnpm typecheck` and `pnpm lint` before opening a pull request.
