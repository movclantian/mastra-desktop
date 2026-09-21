# 设计原则与可追溯借鉴

> 审查快照：`main` / `9031264`。本文只把能回到当前仓库源码、配置或文档的内容写成“已确认”；对只有形态相似、但没有提交记录或来源声明的内容，统一标为“推断”。行号以本快照为准，文件发生变更后需要重新核对。

## 1. 如何阅读本文

- **已确认事实**：当前代码或项目文档直接表达，或能由导入、配置、注册关系复核。
- **推断**：结构上与某个模式相似，但仓库没有足够证据证明直接复制、生成或继承自该来源。
- **建议原则**：在现有事实之上给后续设计、评审和新增功能使用的约束；它不是当前实现已经满足的保证。

借鉴关系的证据优先级遵循 `docs/project-audit/04-review-method.md:7-18`：当前源码/配置优先，其次是项目文档和已有示例，最后才是依赖的官方文档。不要把依赖名称、视觉相似或目录命名单独当成版权来源证明。

## 2. 产品与系统设计原则

### 2.1 本地优先，但保持服务边界清晰

**已确认事实**：README 将产品定义为 local-first 桌面工作台，agent runtime、向量存储、embedding 模型和会话历史都在本机运行；模型密钥由用户提供，应用不经第三方后端转发（`README.md:3-5`）。架构图明确划分 Electron main、localhost Mastra 服务和 Electron renderer，main 通过 spawn 启动服务，renderer 通过 HTTP/SSE 与服务通信，renderer 与 main 之间走 IPC（`README.md:17-25`）。

**原则**：把“本地数据、可观察进程、明确协议”作为默认设计，而不是把桌面端当成一个没有边界的 Web 页面。涉及模型、文件、凭据或会话的新增能力，应先决定它属于 main、Mastra 还是 renderer，再决定 API 形态。

**工程含义**：

1. renderer 只负责交互和展示，不直接持有凭据或执行任意本机能力。
2. Mastra 服务负责 agent、工具、记忆、RAG、MCP 和工作区 API；main 负责窗口、子进程、PTY 和凭据边界（`README.md:28-34`）。
3. 服务重启、健康检查和退出必须是可见的生命周期，而不能依靠“窗口关闭后进程应该自然结束”的假设。当前 main 在创建窗口前轮询 `/health`（`src/main/index.ts:300-328`），退出时先请求 `/work/shutdown`，再使用 IPC、信号和整树强杀作为兜底（`src/main/index.ts:370-419`）。

### 2.2 分层组织：业务能力按 FSD 层次落位，基础能力集中复用

**已确认事实**：README 明确称 renderer 使用 Feature-Sliced Design，层次为 `app / pages / widgets / features / entities / shared`（`README.md:28-35`）。源码目录与该声明一致：`src/renderer/src` 下有 `app`、`entities`、`features`、`pages`、`shared` 和 `widgets`，例如聊天页面位于 `pages/chat`，工作台状态位于 `entities/workbench`，聊天、侧栏和工作区抽屉位于 `widgets`。

**原则**：跨页面、跨业务复用的契约和 UI 原语放在 `shared`；可识别的领域数据与查询放在 `entities`；用户动作与用例放在 `features`；页面编排放在 `pages`；可组合的大块界面放在 `widgets`；启动和全局 provider 放在 `app`。新增文件先回答“它属于哪一层”，避免把后端 API、业务状态和视觉组件塞到同一个页面文件。

**边界提醒**：FSD 是项目已确认采用的组织方式，但不是把每个小函数都拆成新文件的理由。仓库工程约定要求小于约 100 行的相关逻辑优先留在所属模块中，避免微文件碎片化（`AGENT.md:1-7`）。

### 2.3 契约优先：IPC 与跨进程数据都要可验证

**已确认事实**：`src/shared` 被 README 定义为每个 IPC channel 的 request/result/event schema 单一真相，preload 暴露的 7 个命名空间和每个参数、结果都经 Zod 校验（`README.md:30-33`）。preload 通过 `contextBridge` 暴露 `electron` 与自定义 `api`，并在进入 main 前使用 contract 校验（`src/preload/index.ts:1-19`）。例如工作区打开请求限定 `app` 枚举、目录路径和成功/错误判别联合（`src/shared/workspace-contract.ts:1-29`），外部 URL 还要求 HTTP(S) 且不能携带用户名或密码（`src/shared/workspace-contract.ts:31-50`）。

**原则**：每个跨边界调用都应有显式的输入、输出和错误形状；不要把 `unknown` 直接透传给 main、Mastra 或文件系统。对于新能力，先增加共享 contract，再实现 preload、main、服务端和 renderer 的消费者。

### 2.4 URL 表达可恢复的导航状态，store 表达客户端交互状态

**已确认事实**：路由使用 TanStack Router 的 hash history，因为 Electron 打包后是 `file://`，使用 browser history 会触发真实文件加载；hash 路由在开发和打包环境都能恢复视图（`src/renderer/src/app/router.tsx:1-9`）。线程、技能、设置和资料库的选择分别通过 path/search params 表达（`src/renderer/src/app/router.tsx:7-9`、`src/renderer/src/app/router.tsx:48-99`）。主壳同时从 URL 读取当前线程，并将用户级面板布局持久化到 localStorage（`src/renderer/src/app/app-shell.tsx:88-144`）。

**原则**：刷新、崩溃恢复、跨视图跳转后仍有意义的状态放 URL；仅影响当前窗口交互的状态放 zustand/store 或组件 state。不要把当前线程、设置 section 等重要导航状态只塞进内存。

### 2.5 AI 交互要呈现过程、证据和控制，而不只是最终文本

**已确认事实**：聊天路由在服务端解析请求级模型、检索、附件、技能和线程上下文，并使用 Mastra session 与 `toAISdkStream` 输出 AI SDK v7 流（`src/mastra/routes/chat.ts:1-7`、`src/mastra/routes/chat.ts:9-20`）。自定义 UI 数据部分包括任务快照、资料库来源和工作区日志（`src/mastra/routes/chat.ts:70-115`）。renderer 的消息列表同时使用 Message、MessageScroller、附件、引用、反应和 markdown response（`src/renderer/src/widgets/chat-panel/ui/message-list.tsx:1-83`），输入区支持附件、模型/Agent/模式选择和排队请求（`src/renderer/src/widgets/chat-panel/ui/prompt-input.tsx:17-93`）。

**原则**：AI 工作台的主对象是“可追踪的运行过程”：用户应能看到计划、工具调用、审批、子 Agent、流式输出、来源引用、工作区日志和失败状态。新增流式数据时，应先定义稳定的 data part / metadata，再实现前端展示；不要用仅靠字符串拼接的隐藏协议。

### 2.6 安全默认值优先于便利默认值

**已确认事实**：工作区默认启用 sandbox，工具默认要求先读后写，并限制输出 token 和写锁超时（`src/mastra/workspace/index.ts:198-221`）。配置读取会规范化路径、允许路径、读写模式、sandbox 超时和工具规则，保存配置时还会清空旧 workspace 实例缓存并销毁旧实例（`src/mastra/workspace/index.ts:228-262`、`src/mastra/workspace/index.ts:302-337`）。main 对 IPC sender 同时校验窗口、frame 和受信 renderer URL（`src/main/index.ts:268-298`）。

**原则**：路径、凭据、工具执行和外部 URL 等高风险输入必须“默认拒绝、显式放行、可审计”。任何为了调试而放宽的权限都应是局部、可撤销、可在 UI 中解释的配置，不应变成全局绕过。

### 2.7 Agent 能力集中注册，策略与请求上下文分离

**已确认事实**：Mastra 实例集中注册 controller、主 Agent、explorer/reviewer 子 Agent、background task、processors、tools、gateway、workspace、storage 和 observability（`src/mastra/index.ts:78-175`）。主 Agent 的 model、memory、workspace、mode、权限、联网检索等按 RequestContext 逐请求解析，而不是在模块加载时写死（`src/mastra/agents/index.ts:1-7`、`src/mastra/agents/index.ts:113-150`）。

**原则**：全局注册负责能力发现和共享基础设施；请求上下文负责用户、线程、模型、工作区和模式等易变状态。新增 Agent 或工具应经过统一注册、分类和权限路径，不要在路由中临时创建一套绕过 controller 的执行通道。

### 2.8 配置和数据采用本地持久化，但存储域要有明确用途

**已确认事实**：默认业务数据位于用户目录下的 `.mastrawork`，存储位置支持环境变量、引导配置文件或默认 LibSQL 文件（`src/mastra/storage/index.ts:49-90`）。业务默认使用 LibSQL，observability 单独使用 DuckDB domain；共享 LibSQL client 在进程存活期复用（`src/mastra/storage/index.ts:108-135`）。

**原则**：配置、业务记录、观测指标、外部内容和凭据不能混成一堆无语义文件。每种数据都要说明生命周期、迁移/重置行为、用户可见位置和备份边界；新增本地存储优先复用现有 domain，而不是随手写临时 JSON。

## 3. 视觉与交互原则

### 3.1 设计 token 是 UI 的公共语言

**已确认事实**：`DESIGN.md` 将颜色、字体、间距、圆角和组件 token 写在 YAML front matter，并将界面定义为“桌面 mat + 浮动工作面”的 workstation metaphor（`DESIGN.md:1-15`、`DESIGN.md:116-128`）。布局要求根节点固定在 `h-svh min-h-0 w-full overflow-hidden`，滚动必须局部化到 `ScrollArea` 或 `overflow-auto`（`DESIGN.md:167-184`）。当前 globals 使用 OKLCH 变量、dark variant 和 `--radius: 0.625rem`，并注释说明遵循 shadcn/ui Tailwind v4 的主题结构（`src/renderer/src/styles/globals.css:1-10`、`src/renderer/src/styles/globals.css:12-45`）。

**原则**：组件优先使用语义 token（`bg-background`、`text-muted-foreground`、`border`、`rounded-*`），不要在页面中散落任意颜色或尺寸。桌面工作台要保证内容密度，但以 flex/grid、`min-h-0` 和局部滚动约束边界。

### 3.2 浮动工作面、侧栏与局部滚动构成稳定的空间模型

**已确认事实**：设计规范指定侧栏使用 `collapsible="offcanvas"`、`variant="inset"`，展开宽度为 256px，主内容使用带圆角、边框和阴影的 `SidebarInset`（`DESIGN.md:174-184`）。实现的 `Sidebar` 默认确实是 offcanvas，`SidebarInset` 使用 `m-2`、`rounded-xl`、`shadow-sm` 和最小高度约束（`src/renderer/src/shared/ui/sidebar.tsx:137-149`、`src/renderer/src/shared/ui/sidebar.tsx:265-275`）。主壳再用 resizable panels 编排内容和工作区抽屉，并对面板做 `overflow: hidden`/`min-w-0` 约束（`src/renderer/src/app/app-shell.tsx:159-207`）。

**原则**：把窗口看成有限的工作面，不让 body 或 Electron window 出现全局滚动条；每个面板自己负责滚动和溢出。新增宽内容（代码、终端、文件树、表格）时，必须说明其最小宽度、压缩策略和滚动容器。

### 3.3 组件组合优先于页面内的定制 DOM

**已确认事实**：按钮基于 Base UI primitive、CVA variant 和 `data-slot="button"` 组成（`src/renderer/src/shared/ui/button.tsx:1-7`、`src/renderer/src/shared/ui/button.tsx:43-58`）；侧栏、输入组、dialog、scroll area、message scroller 等在 `shared/ui` 形成可复用原语。`AGENT.md` 要求新增/修改前端组件前先在 `docs/examples/` 或 `docs/aielements/` 按前缀读取参考，并要求复用属性名、ARIA、slot 和嵌套结构（`AGENT.md:11-12`）。

**原则**：先组合现有 primitive，再扩展一个明确的 slot/variant；只有当组件真的拥有独立状态、可访问性或生命周期时才拆分。参考示例是结构基线，不应把 demo 文案、假数据或未使用的复杂 API 原样带入产品。

## 4. 借鉴来源与证据矩阵

下表区分“仓库明确声明/直接依赖”和“形态相似的推断”。“来源”不是说所有文件都由外部项目直接复制，而是说明当前代码可以追溯到哪一类公开模式或参考资料。

| 来源/模式 | 已确认证据 | 当前项目吸收的形态 | 结论边界 |
| --- | --- | --- | --- |
| shadcn/ui 配置与示例体系 | `components.json:1-20` 的 schema、`base-nova`、Tailwind CSS variables、组件别名和 Lucide；`docs/examples/accordion.mdx:18-55` 明确给出 `npx shadcn@latest add accordion`、`@base-ui/react` 和 ComponentSource；globals 也直接注释 shadcn Tailwind v4 结构（`src/renderer/src/styles/globals.css:3-10`） | 语义 token、组件生成/复制式工作流、`data-slot`、CVA variants、`shared/ui` 组件目录 | **已确认是配置和参考体系的来源。** 不能仅凭相似 JSX 断言每个本地组件都来自某一具体 commit；若后续复制代码，应记录来源版本与许可证 |
| Base UI | `package.json` 依赖 `@base-ui/react`；`src/renderer/src/shared/ui/button.tsx:1` 使用 `ButtonPrimitive`，`sidebar.tsx:1-2` 使用 `mergeProps`/`useRender`；`docs/examples/accordion.mdx:39-43` 直接给出 Base UI 安装方式 | headless primitive、render prop、可访问交互状态和 slot 结构 | **已确认直接依赖。** 不等于项目自研组件全部由 Base UI 官方源码复制 |
| AI Elements / AI chat component patterns | `docs/aielements/conversation.tsx:3-10`、`docs/aielements/prompt-input.tsx:3-40` 使用 `@repo/elements/*` 的 Conversation、Message、PromptInput、Attachments、ModelSelector 等；生产代码有对应的本地 `src/renderer/src/shared/ui/ai-elements/`，聊天面板使用 `MessageResponse`、PromptInput、Queue 等（`src/renderer/src/widgets/chat-panel/ui/message-list.tsx:23-83`、`src/renderer/src/widgets/chat-panel/ui/prompt-input.tsx:34-93`） | 流式消息、附件、模型选择、推理/工具/任务/来源等 AI 专用 UI 原语 | **结构影响可确认，直接复制关系只能标推断。** docs 示例仍使用未在本项目包配置中声明的 `@repo/elements` 别名，说明它首先是参考样例，不是生产 import 路径 |
| Vercel AI SDK / Mastra AI SDK adapter | docs demo 使用 `useChat`（`docs/examples/ai-sdk-helper-demo.tsx:1-4`）；生产 renderer 使用 `@ai-sdk/react`（`src/renderer/src/widgets/chat-panel/ui/chat-panel.tsx:1`），服务端使用 `@mastra/ai-sdk/ui` 与 `ai` 的 UI message/stream API（`src/mastra/routes/chat.ts:9-20`） | 以 UI message、流状态和自定义 data part 连接 Mastra 与 React | **已确认依赖与调用关系。** 具体界面是否从 demo 某个版本演化而来，当前仓库没有足够 lineage 证据 |
| Feature-Sliced Design | README 明确写出 `app / pages / widgets / features / entities / shared`（`README.md:28-35`），源码目录与之对应；git history 中还有 `12e90df refactor(renderer): comprehensive migration to Feature-Sliced Design (FSD) architecture` | 页面/业务能力/实体/共享原语的分层边界 | **已确认项目采纳 FSD 命名与组织方式。** 具体层间依赖规则仍以当前导入和代码评审为准，不能假设完整遵循外部 FSD 规范 |
| Electron 官方安全与桌面进程模式 | `electron.vite.config.ts:1-17` 配置 main/preload/renderer；`src/preload/index.ts:13-27` 使用 contextBridge；`src/main/index.ts:285-298` 校验 IPC sender | main/preload/renderer 隔离、contextBridge、主进程权限集中化 | **已确认架构与 Electron API 使用。** 这是平台边界，不等同于某个具体模板的直接复制 |
| Mastra 官方 Agent/Server/Storage/Observability 模式 | `src/mastra/index.ts:1-7` 注明 Mastra 官方文档路径；`src/mastra/agents/index.ts:1-7`、`src/mastra/routes/chat.ts:1-7` 明确引用 Agent、HITL、AI SDK route/session/stream 相关文档；Mastra 实例注册 controller、processors、storage、observability（`src/mastra/index.ts:78-175`） | Agent controller、RequestContext、工具/处理器、memory、workspace、流式 route、composite storage | **已确认代码有官方文档导向和官方包调用。** 不应把项目自己的权限、错误、工作区和 UI 规则误称为 Mastra 官方默认行为 |
| Lucide、CVA、TanStack、dnd-kit、react-resizable-panels | 依赖位于 `package.json:35-108`；实际导入可见 `button.tsx:2`、`app-shell.tsx:3`、`chat-panel/ui/prompt-input.tsx:1-16`、`router.tsx:1-17` | 图标、variant 组合、查询/路由、拖拽排序和可调整面板 | **已确认依赖和使用。** 依赖存在本身不构成外部代码拷贝证明 |

## 5. 后续落地规则

1. **新增 UI 先查示例，再写生产代码。** 根据组件前缀读取 `docs/examples/`；AI 交互读取 `docs/aielements/`，同时对照 `DESIGN.md` 的 token、布局和滚动约束（`AGENT.md:11-12`、`DESIGN.md:217-240`）。
2. **保留来源可追溯性。** 如果从示例或外部组件复制超过一个小片段，应在提交说明或文件头记录来源路径、版本/commit、改动范围和许可证；`@repo/elements` 这类文档别名不能直接当成生产依赖。
3. **先稳定边界，再扩展视觉。** 新能力先定义 shared contract、服务端 route、请求上下文和错误形状，再添加 renderer 查询与 widget；不要让 UI 组件直接拼接 localhost URL 或访问 Electron 原生 API。
4. **把流式 AI 状态当成数据模型。** 任务、工具、审批、引用、附件和日志都应有显式类型与失败态；避免只增加一段 markdown 文本来承载可交互状态。
5. **每次架构或 UI 变更同步更新证据。** 本文中的行号、来源矩阵和“推断”标签应在大重构、依赖升级、示例替换或打包边界变化后复核；不要让过时的来源说明继续指导新代码。

## 6. 尚未能确认的事项

- `docs/examples/` 与 `docs/aielements/` 的仓库内文件没有统一记录上游仓库 URL、版本或 commit；因此本文确认了其内容和 import 形态，但没有把每个示例的作者/具体来源写成事实。
- `src/renderer/src/shared/ui/ai-elements/` 与 `docs/aielements/` 存在明显命名和组合对应，但当前快照没有逐文件的复制声明或映射表；应称为“参考/适配关系（推断）”，直到补充 provenance。
- 视觉规范明确要求 `DESIGN.md` 驱动 UI，但当前审查只读取源码和静态文档，没有进行完整的多窗口、窄宽度、深色主题和安装包运行态视觉验收；这些属于待验证的运行结果，不应在此文档中当作已实现保证。

导航：[项目审查索引](README.md) · [审查方法](04-review-method.md)
