# 工程问题修复计划

## 2026-09-21：聊天文档与长期资料库语义对齐（当前批次）

状态：代码实现完成；范围为附件归类、索引可见性和缓存刷新，真实桌面验收与发布由本轮门禁继续跟进。

目标：符合产品约定——文本/PDF/Word/Excel 等可解析聊天附件保存后进入长期资料库并建立索引，同时保留当前会话引用；图片/音频/视频仍只作为会话附件；ZIP/PPT/PPTX 不新增解析能力。

实施：

1. 后端 multipart 聊天上传为可解析格式增加长期资料引用，不删除原有 `threadId` 引用；已有同 SHA 资产也能补长期引用。
2. 聊天上传完成后失效资料库查询缓存，让已打开的资料库页面立即看到新资产并轮询索引状态。
3. 保持上传响应与异步索引解耦，但让长期资料目录中的 `indexing/error` 状态可见、可重试。
4. 增加契约回归：文本聊天附件双引用、媒体不自动晋升、聊天上传后刷新资料库查询。

不做：不把图片做 FastEmbed 文本索引；不把 ZIP/PPT/PPTX 送入模型；不改资料库分片上传协议；不引入第二套资产表。

验收：定向回归、全量回归、类型检查、改动文件 lint；真实桌面验证聊天上传文本/PDF 后出现在“文档目录”并从“会话附件”仍可引用，图片仍只在会话附件，索引失败可见且可重试。

本轮验证结果（2026-09-21）：定向附件回归 17/17、全量回归 51/51、`pnpm run typecheck`、改动文件 Biome lint、`git diff --check` 均通过；`http://localhost:4111/health` 返回 200。新增 `hasLibraryReference` 语义字段，避免“有线程引用的长期文档”继续被默认文档目录过滤。未执行生产安装包构建；开发服务保持运行。仍需真实桌面确认文档目录出现、会话附件引用和索引状态刷新。

## 2026-09-21：附件语义与能力边界修补（当前批次）

状态：代码修补完成，静态/自动化验证通过；等待真实桌面回归；不重打包、不推送。

- 附件动作若渲染为链接，显式关闭 Base UI 的 `nativeButton`，避免运行时语义告警；普通复制按钮继续保留原生按钮语义。
- 消息气泡的 `ContextMenuTrigger` 使用 Base UI 原生 `div` 触发器，不额外伪造按钮属性；本批只修复已在源码栈中确认的 `AttachmentAction` 链接按钮告警。
- 资料库上传菜单增加能力说明；“未建立文本索引”改成“已保存，未建立文本索引”，区分存储成功与索引能力边界。
- 不改变 FastEmbed 文本向量策略，不放开 ZIP/PPT/PPTX 到模型原生输入；后续若需要技能包导入，另立协议和验收项。

验收门槛：附件定点回归新增原生语义和能力提示断言；三套 typecheck、改动文件 Biome、`git diff --check`；随后用户复测附件打开/下载、资料库上传和不支持格式提示。

验证证据（2026-09-21）：附件定点回归 14/14、全量回归 48/48、`pnpm run typecheck`、改动文件 Biome lint、`git diff --check` 均通过；`mastra build --force` 与 `electron-vite build` 通过。普通 `pnpm run build` 首次被正在运行的 dev server（PID 31260）保护性阻止，未杀用户进程，改用显式 `--force` 完成生产构建。构建仅保留已知 Node engine、package-lock fallback 和 `INEFFECTIVE_DYNAMIC_IMPORT` 警告。

真实桌面验收仍由用户执行：重启开发服务后，验证附件打开/下载、资料库上传、图片/未知格式提示，并确认 Base UI `nativeButton` 告警不再出现。本轮未宣称 React 更新深度、鼠标/滚动卡顿或长任务流恢复已解决。

## 2026-09-21：双路调研后第一批修复结果

状态：定向修复完成，等待真实桌面回归；不重打包、不推送。

- `src/main/index.ts` 的 `img-src` 已精确加入 `${MASTRA_SERVER_URL}`，闭合资料库图片 URL 的 CSP 回归，不放开通配符。
- `src/mastra/agents/processors.ts` 在输入处理和 provider 边界拦截空 MIME/`application/octet-stream`；只把未知文件转为明确提示，识别出的图片/音频及已有文本/资产路径不变。即使没有 `resourceId`，未知 MIME 也不会继续下发。
- `normalizeTraceParts` 在助手轨迹最后渲染边界按有效 `toolCallId` 保留最新快照；空/非法 ID 不合并，避免重连脏数据互相覆盖。
- PromptInput 宽度测量改为脱离布局流的克隆节点 + `requestAnimationFrame`，不再在 `ResizeObserver` 回调中改写被观察节点；相同宽度不重复上报，降低 observer/layout 反馈环风险。

证据：附件定点回归 12/12、全量回归 46/46、三套 typecheck、`git diff --check` 通过；新增行为级测试覆盖未知 MIME 分类和空 toolCallId。全仓 `pnpm run lint` 仍被工作树已有 `.agent/core-patch` 生成文件及 CRLF/大批非本轮格式诊断阻断，未把它计为本批通过。

未宣称：真实桌面 React 更新深度、鼠标/滚动流畅度、长任务流恢复和多供应商实机行为仍需重启开发态后手测；本批没有构建安装包。

## 2026-09-21：双路调研结果（仅审查，不改业务代码）

### 源码审查结论

- **P1 / 当前分支明确问题**：renderer CSP 的 `img-src` 未包含 `http://localhost:4111`，而资料库图片 URL 正是该来源；报告中的浏览器阻断与 [src/main/index.ts:306](../src/main/index.ts:306) 直接对应。该行由 `6a1f493b` 引入，属于本次改动造成的回归候选。
- **P1 / 上游缺口 + 当前边界未封口**：`application/octet-stream` 仍可从文件引用/未知 MIME 进入 OpenAI-compatible provider。AI SDK 会拒绝该 file part；当前处理器只覆盖可识别的资料库资产形状，不能把所有原始 FileUIPart 当成可发送媒体。
- **P1 / 当前修复不完整**：`normalizeAgentTools` 和队列最后一道去重已存在，但报告仍出现原始 `toolCallId` 重复 key，说明重复数据可能在更早的消息/trace 投影或另一层列表产生；不能再加无证据的第三层去重。
- **P1 / 上游布局反馈环候选**：PromptInput 的 ResizeObserver→Zustand `promptMinWidth`→AppShell `chatMinWidth` 链路来自较早上游代码；它不是 `6a1f493b` 首次引入，但报告已证明当前运行时发出 loop warning，应通过帧级测量计数与滚动性能取证后再决定是否改。
- **P2 / 错误边界**：空工作区导致 `Thread has no browsable workspace` 属于测试前置条件；renderer 仍把错误和非预期响应冒泡为未捕获 Promise/ZodError，是真实 UX 缺陷。
- **P2 / 语义警告**：`MessageItem` 上的 Base UI `nativeButton` 警告需要修，但目前没有证据表明它是卡顿根因。

### 外部方案调研结论

- Mastra durable agents 用 `runId`、PubSub、事件缓存和 `observe(runId)` 支持断线续接；长任务应由后端继续运行，renderer 只重连和投影，不重新提交用户消息。
- Vercel/Cloudflare/Anthropic/LangGraph 的共同边界是：事件带唯一 ID/序号，重连按游标补发，客户端按 `eventId → toolCallId → messageId` 分层幂等。
- AI SDK 文件上传契约要求显式且正确的 `mediaType`；流式字节无法 sniff 时会回退为 `application/octet-stream`。OpenAI-compatible provider 不应被假设支持任意文件 part。
- ResizeObserver 官方建议避免回调内形成同步布局反馈环；必要时使用 `requestAnimationFrame`/节流，并区分“测量”与“写布局”。

### 下一步顺序

1. 先做附件能力矩阵：可上传、可预览、可索引、可注入模型分别记录；覆盖 txt/md/pdf/docx/xlsx/csv/pptx/zip/图片/音频/视频/未知二进制。
2. 最小修复 CSP 和 provider MIME 边界，并为每个失败保留请求/响应证据。
3. 增加运行时事件日志（runId/eventId/toolCallId/messageId），定位重复 key 的第一生产点，再修消息投影。
4. 对 ResizeObserver 做 60 秒桌面 TRIAL，记录 loop 次数、帧响应、鼠标和滚动；未证实前不盲改布局。
5. 最后再做 durable/resume 方案评估，不在当前阶段直接引入外部队列或 Redis。

外部依据：Mastra Durable Agents、AI SDK File Uploads、Vercel AI SDK Resume Streams；本轮只完成调研和归因，未构建、未打包、未推送。

## 当前执行结果（2026-09-21）

已完成附件边界的第一步确定性修复与门禁：混合选择时不再静默丢弃不支持的文件，而是列出被拒绝的文件名；ZIP/PPT/PPTX 仍明确不进入聊天模型输入，资料库保留与模型可注入能力分开验证。新增 `scripts/test-library-attachment-regressions.mjs`，覆盖 6 项附件契约与边界断言。

本地证据：附件定点测试 6/6、全量回归 40/40、三套 typecheck 通过、Biome lint（改动文件）通过、`git diff --check` 通过。pnpm 仅报告 Node/pnpm engine warning；本轮没有构建、安装包或推送。

长任务主阻断仍未关闭：React 更新深度错误、鼠标/滚动卡顿和长任务记录停更尚未取得同一时间窗的 renderer/Mastra/SSE 原始证据，因此暂不继续扩大业务补丁。下一步是让用户重启开发态后跑固定短/长任务，回传时间、线程 URL、截图和三类日志，再按官方“可恢复流 + runId/rejoin + 持久化快照”模式定位事件重复或渲染压力。

## 2026-09-21：长任务稳定性与附件能力边界（当前执行批次）

状态：执行中；不重打包、不推送、不扩大模型能力声明。

复杂度/风险/动作：`C2 + R-runtime + R-protocol + R-ui + A0`。本批跨 renderer、SSE/任务状态和资料库附件协议；先做确定性 UX 修复，再以真实证据定位长任务更新循环。

### 已确认的设计参考

- OpenAI Agents SDK：必须等待 `stream.completed`，取消/续跑复用原 `state`。
- Vercel AI SDK：长流需要持久化 stream，刷新或断线按 chat/run 标识恢复。
- LangChain join/rejoin：服务端继续执行，客户端用 `run_id` 重新加入并补收事件。
- 本仓库 Mastra durable-agent 文档：用 checkpoint、PubSub、`observe(runId)` 和持久化快照承载长任务。

这些是约束和参考，不直接复制另一套运行时。当前旧问题仍是主阻断：`Maximum update depth exceeded`、鼠标/滚动卡顿、长任务记录停止更新；已有消息去重/限频/快照合并只算局部缓解，不能宣称已解决。

### 执行顺序

1. **上传边界（本轮先落地）**：混合选择时明确列出被拒绝文件名和原因；保留 ZIP/PPT 等不具备模型解析链路的类型为明确“不支持”，不静默丢弃。
2. **上传回归矩阵**：覆盖文本/代码、PDF/DOCX/XLSX/CSV、图片、音频、视频、ZIP、PPTX 和未知二进制，分别记录可上传、可预览、可索引、可注入模型四种结果。
3. **长任务证据**：以一次短工具链和一次长工具链为固定输入，采集 renderer/main/Mastra 同一时间窗的首个重复 `toolCallId`、首个 `Maximum update depth`、SSE 终态和快照状态；先找到根因再改。
4. **最小流式修复**：若根因是事件重复，按 `eventId → toolCallId → messageId` 分层幂等；若根因是渲染压力，继续沿用缓冲/限频并减少已完成轨迹 DOM，不新增第二套消息事实源。
5. **验收**：静态回归 + 类型检查后，真实桌面连续 3 次长任务必须满足：无 React 更新深度错误、无重复 key、任务记录实时更新、无需切换会话、鼠标和滚动可用；附件矩阵中每一类必须给出明确结果。

### 本批非目标

- 不继续瘦身安装包、不重打包、不推送/force-push。
- 不把“余额不足导致的 `network error`”当作本地 React 卡顿根因。
- 不在没有解析器和安全边界的情况下放开 ZIP/PPT 等文件到模型原生输入。

## 2026-09-21：资料库附件 401 与首条上传跳页修复（当前批次）

状态：定向修复完成，等待真实桌面回归；不重打包、不推送。

证据：后台日志显示 `DOWNLOAD_ASSETS_FAILED`，Mastra 服务端访问
`/work/library/assets/:assetId/content?resourceId=...` 返回 401；该 URL 是渲染层带用户会话使用的受保护地址，服务端模型下载器没有浏览器 Authorization。与此同时，首条消息在附件持久化和模型请求前就创建并选中新线程，失败后用户看到空白/新页面。

修复：修正 `libraryAttachmentProcessor`，同时识别 Mastra 的 `content: [...]` 与 `content: { parts: [...] }` 两种输入形状，并兼容 `data/url/image` 载荷；处理器在框架下载资源前把文本/媒体转换为模型可用内容，不改写原始消息历史。新线程首条消息带附件时延后路由选择，上传成功后才切换；无附件首条消息保持原行为。

回归：新增 `scripts/test-library-attachment-regressions.mjs`，验证服务端预解析、首条附件延后切换和资源 URL 边界；`pnpm run typecheck`、`pnpm run test:regression`（37/37）与 `git diff --check` 通过。仍需用户在开发态上传一个文档并发送“生成技能包”验证真实流；若仍中断，保留时间、线程 URL、renderer/主进程日志。

## 2026-09-21：成果冻结与基线修复（当前批次）

状态：成果已冻结为本地提交；进入专项修复；不推送、不 force-push、不重打包。

复杂度/风险/动作：`C2 + R-runtime + R-protocol + R-ui + A0/A1`。本批涉及跨模块运行态、流协议和用户体验；本地提交用于可回滚里程碑，远端 push 仍需 Owner 单独授权。

目标：以 `origin/main`/`9031264` 为上游基线，固定当前工作树成果和证据身份；按产品源码、测试/发布门禁、审计交接文档拆分本地提交；在冻结里程碑上单独处理长任务流中断和 renderer 卡顿。

当前调用链证据：后台 SSE `background-task-output` → `ChatPanel` 事件回调 → `reloadDisplayState()` → Query 请求与多组 React state 更新；消息流更新同时触发 `buildDisplayMessages(messages)` 和长工具轨迹渲染。该路径先做定量/针对性验证，再决定修复范围。

成果分组与提交顺序见 [docs/push-overview.md](../docs/push-overview.md)。冻结前只做文档和版本控制整理，不改业务逻辑；冻结后新增修复必须进入独立提交并可单独回滚。

验收：冻结提交可从基线单独回滚；`pnpm run typecheck`、`pnpm run test:regression`、`git diff --check` 通过；卡顿/中断专项修复必须有对应回归；静态测试不能替代桌面 TRIAL。

当前冻结提交：`0d571f0`（审计工件）、`b030954`（推送概览）、`6a1f493`（产品/运行时）、`0b42216`（测试/发布门禁）。

专项修复顺序：

1. 先移除后台输出事件到 display-state 的逐事件请求，按终态/限频刷新，并批量提交任务卡 UI 状态。
2. 再降低已完成工具轨迹的默认 DOM 负载，保留手动展开能力。
3. 用专项回归和类型检查验证；若仍有卡顿，再从消息投影/长 Markdown 渲染切入，不扩大修改面。

## 2026-09-21：批准卡死与长任务记录停滞（当前批次）

状态：定向源码修复已完成，等待类型/回归验证与用户手工桌面回归；不重打包、不推送。

现象与根因：批准按钮把完整长流 Promise 当作 busy；重连 GET 流没有传 `keepUntilIdle=true`；重放过滤前未计数后台任务；前台流结束后没有持续刷新后台任务快照。

最小修复：恢复请求 dispatch 后立即释放 busy，失败且服务端仍挂起时恢复交互；GET 流沿用后台保持语义；新增后台任务生命周期追踪与初始快照；后台 SSE 事件触发 display-state 刷新；active run 存在时不覆盖本地实时消息；在路由边界同步批准后的模式上下文。

验收：`pnpm run typecheck`、`pnpm run test:regression`、Biome/diff 检查；运行中开发服务健康检查；用户手测“批准后按钮可再次操作、长任务记录持续更新、无需重新打开会话”。浏览器视觉自动化若 CUA 仍不可连接则标记阻塞，不把静态或隔离测试写成桌面通过。

## 2026-09-21：用户批准的定向体验修复（当前批次）

状态：补丁完成，待用户手工回归。范围锁定为真实桌面回归已确认的三项，不重打包、不推送、不扩大能力边界。

证据基线：隔离 Playwright 登录和本机 HTTP 实测中，简单流式请求能完成；长工具链服务端已结束且 display-state/tool invocation 已是终态，但前端直到重新打开会话才显示最终文本，说明流结束后的消息投影没有收敛。新会话在首条消息前选择“执行”时，创建线程后模式回落为“计划”，说明创建线程读取的模式快照与输入栏选择存在竞态。开发态浏览器还会触发 `OpenInIde` 对不存在的 Electron API 的警告。

实施顺序：

1. 给每线程 Chat 增加“流已结算”回调；在服务端确认没有 active run 后，有限重试拉取 display-state 和消息，避免必须切换会话才能看到工具结果。
2. 创建新线程时允许调用方显式传入当前模式快照；首条消息使用提交瞬间的 store 快照，防止“执行”被默认的“计划”覆盖；其他创建线程入口保持兼容。
3. `OpenInIde` 在浏览器/非 Electron 环境跳过 IDE 检测，不产生误导性控制台错误；Electron 环境行为不变。
4. 运行类型检查、定点回归和一次隔离真实 UI 测试；验收标准是工具链无需导航即可显示最终结果、新线程首条消息保留选中模式、无新增 pageerror/IDE 检测警告。失败则保留日志，不宣称桌面整体通过。

约束：不修改 Provider 协议、不写入用户凭据、不删除工作区数据、不执行安装包构建；所有已有工作树改动保留。

### 本批结果与 fresh-context 复核

- 已实现流结算回调、有限退避对账、线程切换后的待结算标记，并在对账前检查本地 Chat 是否仍处于 `submitted/streaming`，避免旧服务端快照覆盖新一轮本地流。
- 已实现新线程首条提交的 `modeId` 快照；旧的字符串标题调用保持兼容。
- 已让 `OpenInIde` 在没有 Electron preload 的浏览器开发态静默跳过 IDE 探测。
- fresh-context reviewer 复核确认：旧实现存在“旧结算覆盖新流”和“非当前线程结算被丢弃”两个阻断风险，当前补丁已覆盖；未发现新的无限重试或模式 API 兼容问题。
- `pnpm run typecheck`、`pnpm run test:regression`（32/32）和 `git diff --check` 已通过。隔离 Playwright 的简单流式 UI 测试通过且无 `pageerror`；工具链测试能收到最终文本/工具标记，但至少一次仍观察到旧的“进行中”字样，因此不能宣称长工具链 UI 已完全验收。

### 用户手工验收门

1. 重启 `pnpm run dev`，新建会话并选择“执行”，发送首条消息，确认模式不回落为“计划”。
2. 在同一会话执行一次会产生工具调用的任务，等待最终文本，确认无需切换/重新打开会话即可看到工具结果，任务卡片进入终态。
3. 连续发送两轮消息，确认上一轮结算不会覆盖下一轮正在增长的流；若失败，保留发生时间、截图和主进程/renderer 日志。
4. 仅在上述手测通过后，再考虑重新构建安装包；本批不执行构建或推送。

## 当前批次：工具完整性（用户已授权执行）

执行状态：1–5源码实现完成；29回归+3套typecheck+源码门禁通过。grep预算默认8MiB可用maxFileBytes显式提高，超限提示不完整。独立review完成并复核LF/读取预算修正。第6步真实工具层完成，视觉验收因两次Vite预编译超时暂阻塞；下一步为实际应用状态展示和原会话卡顿取证，不先重打包或扩大自动扫工具。

C2 + R-runtime/R-protocol/R-ui + A0。继承本地工作台边界；保留权限、工具、用户数据，不打包、不推送、不更改用户全局 AGENTS.md。

1. grep：当前 core 1.67.0 的 workspace grep 在单文件/目录/glob 三处分支按扩展名过滤；验证39文本探针与二进制/忽略规则，使用可重复安装的依赖补丁修复，不手工漂移 node_modules。
2. Windows：当前 LocalProcessHandle 用默认 UTF-8 StringDecoder；在原始字节入口定义编码契约，覆盖前台/后台、stdout/stderr及分块中文；不能事后替换乱码。
3. 委派：agents/index.ts 空文本 hook 返回无发现但保留结果；改为明确未完成、结束原因、工具证据索引，不编造步数耗尽原因，不把工具内容提升为指令。
4. 审批历史：model/types.ts 解析 submittedPlan；agent-panels.tsx 区分批准/否决/待修订/未知，未知不得显示已批准。不修改授权语义。
5. 技能：说明当前暴露工具/已发现技能才是能力依据，缺失时明确报告并提供安装入口，不修改用户全局规则或冒充 browser-harness 已安装。
6. 验证：定点复现→修复→回归/类型检查→独立审查；UI实际渲染证据与完整桌面验收分别记录。React卡顿仍待原始会话复现，不随本批关闭。

## 最新执行：上下文用量与真实会话验证

累计计费/单次上下文分离已实现，24 项回归通过。用户允许账号登录全线测试，但最新提供账号认证失败；等待确认后进行新测试会话、组件栈与 SSE 取证。独立120工具/60更新 React 探针未复现循环，不能认定修复。保持能力，暂不打包/推送；详细状态见审计文档10。

## 最新执行：修复、fresh review 与测试包构建

用户已授权本地重新构建。`C2 + R-runtime/R-protocol/R-data + A0`；继承现有产品边界，安装和发布不在本批执行范围。

- 上传维护改为后台单飞、5分钟节流，避免会话创建等待残留目录清理；不改清理目标或过期判定。
- fresh agent `/root/fresh_release_review` 无历史对话独立审查：对比HEAD，独立跑21项回归，核对媒体/分块/上传/流/消息及打包入口，未发现阻止生成测试包的明确问题；没有确认React循环根因。
- 三套typecheck、21项回归和源码资源检查通过。Mastra及electron-vite源码构建通过。
- 使用独立 `dist-review-20260920-1259` 输出目录保留旧包；后续校验产物、资源、EE路径与SHA256。仅产物验收，不冒充安装运行验收。
- 当前Node24.19/pnpm11.19，与声明Node22/pnpm12仍有差异；上下文统计、React卡顿、grep/编码等继续未完成。

## 当前实施批次：恢复明确缩减的能力（2026-09-20）

`C2 + R-runtime/R-protocol/R-ui + A0`。使用 dev-loop、karpathy-guidelines；自有技能按 skill-creator 编写与校验。继承本地 AI 工作台产品边界，用户决定体验，模型仅使用实际工具。不复制 EE 内容、不新增虚构工具、不打包、不推送。

本批已实施：媒体读取边界与原上传50MB一致、恢复资料库视频dataURL路径、两项原创可安装技能、chunker默认overlap、上传短写保护、Provider测试指令一致性、回归测试入口和PR检查接入。

验收：20项函数/依赖/本机HTTP测试，后端类型检查，技能校验与发布源码检查；尚无桌面TRIAL。原技能集合不宣称等价恢复。后续先定位React循环与卡顿，随后修正上下文统计、清理请求阻塞、grep/编码；安全专项与包体积收敛暂停。

## 2026-09-20 最新对比后的执行顺序（优先于下文历史计划）

上游最新及 HEAD 均为 `90312644ff0af8d938552207345a416c88f2db9f`。完整归因、证据边界和验收矩阵见 `docs/project-audit/08-upstream-current-comparison.md`。

1. P1：先捕获 React 更新循环的实际组件栈/会话事件并做有界重放，定位后最小修复；目前仍未闭环。
2. P1：区分累计计费与单次上下文占用，修复显示与附件预算语义。
3. P1：处理我们引入的技能能力空缺、媒体限制提示不一致及上传清理/短写风险。
4. P2：修复 chunker 默认 overlap、grep .ps1、Windows 输出编码和工具失败契约。
5. P2：Provider 请求矩阵与审批事件契约测试，去掉 Provider 测试残留结构化指令。
6. 将定点回归接入 CI，完成开发态/产物桌面实测和独立复核后再推进发布。

本轮同条件源码回归：上游2/14，当前14/14。仅代表已知缺陷夹具，不是整机质量评分。安全专项、包体积收敛与强推继续暂停；本轮只审计、更新计划，没有改业务代码。

## Current phase

P1 source acceptance: rebuild the latest source and hand-test the Provider,
Mastra restart, and 20 MB upload fixes. Package-size convergence is paused.
Classification: `C2 + R-runtime/R-protocol + A0`.

## Current remediation cycle: provider and upload correctness

### Goal

Repair the confirmed BYOK endpoint-routing and upload-diagnostics defects exposed by
fresh-context review, without broad packaging work or unrelated product changes.

### Scope and order

1. Propagate Mastra registry provider URLs into built-in BYOK resolution and the
   Workbench gateway; preserve explicit custom gateway URLs.
2. Make provider connectivity tests use a plain text response and preserve useful
   upstream status semantics instead of converting every failure to HTTP 400.
3. Align the chat attachment allowlist with the backend's extractable text formats;
   keep ZIP out of chat until safe archive extraction/indexing exists, and document
   that library ZIP uploads are stored but not indexed.
4. Stop mapping every multipart/chunk upload failure to "file too large"; preserve
   typed work errors and use the generic upload error for non-size failures.

### Acceptance

- Built-in `deepseek` resolves to its registry endpoint (`https://api.deepseek.com`)
  rather than the OpenAI default when no custom URL is configured.
- Explicit custom `baseUrl` remains authoritative for all protocols.
- Provider test failures expose 401/402/429/5xx or network/configuration semantics,
  while a plain successful text response still reports `ok: true`.
- Chat accepts all backend text-extractable extensions in the allowlist, while ZIP
  remains rejected with no attempt to send archive bytes to a model.
- Upload parsing, validation, storage, and size failures produce distinguishable
  status/code/message combinations.
- `typecheck`, `verify:release`, `git diff --check`, and focused source assertions
  pass; no claim of packaged runtime success is made in this cycle.

## What

落实审查清单中的高优先级修复，并处理不需要产品取舍的低风险维护项。

## Where / ownership

- 主线程：许可证技能路径、打包资源、Workspace 缓存、资产媒体内存、文档与最终整合。
- Agent 1：`.github/workflows/release.yml`、`package.json`、`pnpm-workspace.yaml`、`scripts/install-browser.mjs` 的 CI/依赖/浏览器安装边界。
- Agent 2：`src/mastra/rag/storage/upload.ts`、`src/mastra/rag/storage/db.ts` 的上传清理与流式合并。
- Agent 3：`src/main/index.ts`、`src/mastra/index.ts` 的 Electron sandbox、窗口来源和 CORS 边界。

## Order

1. 完成 G0/设计决策和分工。
2. 并行处理互不重叠的 CI、上传、宿主安全改动。
3. 主线程处理许可证路径、资源缓存和媒体读取，随后整合。
4. 做静态检查：路径存在、行号范围、YAML/JSON 结构、`git diff --check`；不启动应用、测试或构建。
5. fresh-context 定点复核安全、数据清理和发布配置，修复阻断项后交付。

## Previous follow-up work (runtime verification pending)

1. 先移除 Workspace 缓存对活跃实例的破坏性淘汰；只允许明确终态实例被回收，容量上限作为软上限，直到 Mastra 暴露可用的 in-flight/lease 信号。
2. 将上传完成改为“数据库删除优先、磁盘清理 best-effort、失败可重试”，并增加 24 小时宽限的孤儿分片目录清理，避免资产已成功却返回失败或留下永久临时文件。
3. 做静态验收：调用树、关键常量、SQL 结构、`git diff --check`；不执行应用、构建或自动化测试。
4. 由 fresh-context reviewer 复核本轮数据/并发改动；之后交付用户手工 smoke 清单，不把静态结果写成运行通过。

## Issue-by-issue remediation queue

按用户确认的优先级逐项推进，每项完成“根因证据 → 最小修复 → 匹配验收”后再进入下一项：

1. **P1 安装包体积**：先做静态体积归因和消费者矩阵，只裁剪有证据的非运行时内容；保留 Chromium/native/Mastra 必需资源。
2. **P1 最新源码验收**：用户手工重建并验证 `/settings`、Mastra 重启、上传协议。
3. **P0/P1 发布与许可证**：干净产物扫描、CI/Release 链路验证。
4. **P2 资源/安全运行验证**：大文件内存、Electron CSP/sandbox/CORS、浏览器/native 资源。
5. **P3 工程治理**：E2E、许可证审计可复现化、模块拆分。

安装包收敛已按用户要求暂停；第一处安全裁剪保留在工作树，但不再继续删除
Chromium/native/Mastra 运行时。当前转入第 2 项源码重建验收。

### P1 packaging — paused after first safe reduction

- **证据**：`resources/icon.png` 同时出现在 `app.asar` 和
  `app.asar.unpacked/resources`；主进程由 `?asset` 生成的路径指向
  `app.asar/resources/icon.png`，而浏览器与内置技能才需要 unpacked 文件系统路径。
- **修复**：`asarUnpack` 从 `resources/**` 收敛为
  `resources/browsers/**` 与 `resources/builtin-skills/**`，保留图标在 asar 内，避免
  每个安装包重复携带图标。
- **预期**：静态上消除约 0.7MB 的重复内容；不会影响浏览器路径、内置技能路径或窗口图标。
- **验收**：用户/CI 重新执行干净的 `electron-builder --dir` 与 `verify:package:dir`，确认
  `app.asar/resources/icon.png` 存在、`app.asar.unpacked/resources/icon.png` 不存在，且
  两个 unpacked 运行时目录仍存在。未完成重建前不宣称运行验证通过。
- **下一道门**：若要继续削减数百 MB，必须在“离线内置浏览器 + 本地 fastembed”与“按需下载浏览器/远程 embedding”之间做产品决策；当前不盲删。

### P1 source acceptance — current

- **构建**：由用户/CI 执行 `pnpm run build`，确认最新源码而不是旧 `out/` 产物。
- **手工回归**：启动桌面端后依次验证 `/settings`、Mastra 崩溃重启、20 MB 分片上传和失败重试。
- **记录**：保留构建输出、启动日志、截图和上传请求/响应；未完成这些证据前不进入许可证产物扫描或 Release 验收。

### P2-D — Workspace 淘汰安全 (`R-runtime/R-architecture`)

- **现状/风险**：当前缓存上限代码直接 `destroy()` 最旧实例，Mastra `Workspace` 类型没有公开 in-flight 计数；活跃 Agent/Sandbox/LSP 可能被提前终止。
- **改动**：仅回收 `error`/`destroyed` 终态实例；有活跃或未知状态时保留实例，不牺牲正在执行的任务换取硬容量上限。
- **验收**：静态确认淘汰路径不再销毁 `pending`/`initializing`/`ready` 实例；运行时并发压测留待用户/CI。

### P2-E — 上传完成状态 (`R-data/R-protocol`)

- **现状/风险**：资产落盘后若先清理目录或删除会话失败，可能出现资产已存在但接口失败，重试又缺少分片。
- **改动**：数据库会话/分片记录先删除；磁盘目录清理失败不反转已成功的资产结果；启动/创建会话时清理超过宽限期且无数据库会话的孤儿目录。
- **验收**：静态确认 DB 删除位于 best-effort `rm` 之前；孤儿扫描只删除无会话且超过 24 小时的专用目录；故障注入和大文件运行测试留待用户/CI。

## P1/P2 follow-up plan

### P1-A — 内嵌品牌图标 (`R-ui`)

- **现状/调用链**：`src/renderer/src/widgets/app-sidebar/ui/app-sidebar.tsx:106-119` 使用 `WaypointsIcon`；`src/renderer/src/features/auth/login-screen.tsx:100-125` 使用登录动作图标；`src/renderer/index.html` 没有 favicon。
- **改动**：将用户提供的图标复制为 renderer public asset；侧栏品牌位、登录页品牌区和 favicon 使用同一资源。保留登录按钮的 `LogInIcon/UserPlusIcon` 语义图标。
- **验收**：源码只存在一个 renderer 引用路径；静态检查确认 asset 被构建入口引用；实际页面截图由用户手动确认。

### P1-B — 上传峰值 (`R-data/R-runtime`)

- **现状/调用链**：`src/mastra/routes/library.ts:214-225` 先读完整临时文件；`src/mastra/rag/storage/upload.ts:195-213` 先读完整分片再写合并文件；`uploadAsset` 再读完整合并文件。
- **改动**：增加文件路径上传入口；multipart 直接从临时文件流式 hash/复制；分片合并按流写入临时文件；完成阶段把临时文件路径交给资产层。可抽取格式仍按需读取一次供解析，媒体文件不再整体读入内存；资产落盘后的抽取或入库失败会删除孤儿文件。
- **验收**：静态调用链不再出现“所有 chunk → parts/merged Buffer”；手动用 50 MB 文件测量峰值和失败重试清理，并检查后处理失败不会留下目标文件。

### P2-A — 发布/供应链门禁 (`R-runtime/R-security`)

- 恢复 pnpm `minimumReleaseAge` 为 1440 分钟。
- 新增只读 `verify:release` 源码/资源门禁，检查图标、内置技能目录和 Enterprise 运行时路径。
- 在 PR/tag workflow 接入门禁；不在本轮自动启动安装器，安装后 smoke 继续由用户在目标平台执行。

### P2-B — 媒体上下文内存预算 (`R-runtime/R-protocol`)

- **现状/调用链**：`src/mastra/rag/storage/assets.ts:310-327` 无条件把媒体文件读成 Buffer 并转 base64；`src/mastra/agents/processors.ts:56-80,126-170` 之后才按 token 预算决定是否注入。
- **改动**：在读取媒体前传入字节上限；超限只返回元数据和明确的“超过上下文预算”提示，不读取文件。
- **验收**：静态检查确认预算判断位于 `readAssetBytes` 之前；手动用大图片/音频确认不会产生 data URL。

### P2-C — 验收工件 (`R-runtime`)

- 增加 `docs/release-smoke.md`，明确 Windows/macOS/Linux 的安装、启动、健康检查和退出验收步骤。
- 本轮只生成可复核脚本和文档，不执行应用、安装器、测试或大规模构建；真实 smoke 结果必须由用户或 CI 运行后回填。

## P1 packaging follow-up — Windows 安装器超时与产物一致性

### Goal

在不扩大运行时依赖树的前提下，降低 NSIS 安装时的临时解压峰值，并阻止旧的
`setup.exe` 被误当成当前构建产物；先做可静态验证、可回滚的门禁和打包边界收敛，再进行目录包启动与安装 smoke。当前目录包和修复版 NSIS 安装 smoke 均已完成。

### Evidence

- `.agent/install-attempt-20260919.md`：安装器运行约 10.6 分钟，Temp 约 7.5 GB、约 20.9 万文件，目标目录为空。
- `dist/win-unpacked`：`app.asar` 约 1.07 GB，`app.asar.unpacked` 约 1.93 GB；主要来源是 `.mastra/output/node_modules`、`resources/browsers` 和 unpacked native/runtime dependencies。
- `electron-builder.yml`：`.mastra/output/**` 被打包进 `app.asar`，仅浏览器/native 资源进入 `asarUnpack`；`.mastra/output/node_modules/**` 被排除，避免重复依赖树。
- `setup.exe` 与最新 `.nsis.7z` 的修改时间不一致，当前流程没有 clean dist 或构建身份校验。

### Order

1. 增加 `scripts/verify-package-artifacts.mjs`：清点候选安装包、校验版本/平台/文件名，拒绝旧时间戳或缺失 blockmap 的本地发布目录，并输出大小摘要。
2. 在 `package.json` 增加只读 `verify:package` 命令；在 tag/manual build 的 package step 后调用它，PR 不触发安装器。
3. 在 `electron-builder.yml` 中只收敛可证明的排除项（源码、文档、测试、映射文件和非目标平台冗余），不直接删除 `.mastra/output` 或浏览器运行时；先避免错误地把必需运行时裁掉。
4. 生成一份打包体积报告，确认 `.mastra/output/node_modules` 与浏览器资源的真实消费者，再决定按需下载、专用 runtime deploy 或拆分资源。
5. 通过静态检查后执行新的 `--dir`、NSIS 安装、启动、健康检查和退出 smoke，并保留失败/成功证据。

### First measurement result

- 清理旧 `dist` 后执行 `electron-builder --dir`，退出码为 `0`。
- `dist/win-unpacked` 约 2.18 GB；`app.asar` 约 708.61 MB；`app.asar.unpacked` 约 1.13 GB。
- source map 数量为 0；`resources/browsers` 约 0.69 GB，unpacked `node_modules` 约 0.44 GB，仍是下一轮精简重点。
- 目录打包结果已记录在 `.agent/package-size-20260919.md`；开发态实例已受控停止，目录包和修复版 NSIS 安装 packaged smoke 均已独立通过。
- 已停止确认属于项目的开发态进程树，并用隔离 userData 完成目录包启动、4111 归属、健康检查和退出清理；随后以新生成的 NSIS 安装包完成相同验收。

### Acceptance

- `verify:package` 能拒绝旧 setup、缺少目标平台产物或版本不一致的目录，并报告明确原因。
- PR check 仍不执行 electron-builder；tag/manual 发布在上传前必须通过产物门禁。
- `getPackagedMastraEntry()` 改为从 `app.asar` 读取，浏览器查找路径和 native module 解包路径保持不变；preload 通过 bundle 解决安装后 sandbox 依赖解析。
- 修复版安装器真实 smoke 已通过；后续体积精简仍需每次重新做同样的构建身份、安装、启动和退出验证。

## Risks / non-goals

- `@mastra/editor` 本身是否还能保留依赖，需要根据 `MastraEditor` API 和上游许可继续核对；本轮先切断 `ee/` 内容。
- 跨平台 sandbox、核心用户路径和上传峰值未在本轮运行验证；Windows 安装启动链路已通过。
- 不修改已有用户数据，不清理用户目录；仅在用户已同意的发布复核计划中，通过受保护的 `clean:package` 清理项目自身 `dist`。

## Current fresh-context remediation evidence

- 独立审查确认内置 registry Provider 的 URL 未进入模型工厂，DeepSeek 等会错误回落到 OpenAI 默认端点；已在 `create-model.ts`、`providers.ts` 和 `gateways.ts` 统一补上 registry URL，显式 `baseUrl` 仍优先。
- Provider 测试已改为纯文本连通性探针，并保留上游 HTTP 状态；上传路由只把明确的尺寸错误映射为 413，其余保留上传失败语义。
- 聊天附件 allowlist 已补齐后端可提取的文本扩展名；ZIP 暂不进入聊天模型链路，知识库中的 ZIP 仍是保存/预览但不解压、不索引的 `unsupported` 资产。
- `pnpm-workspace.yaml` 的无效 `allowBuilds` 占位值已改为明确白名单，避免依赖重建遮蔽源码验证。
- 已通过：`pnpm run typecheck`（当前 Node 24/pnpm 11，存在项目要求不匹配警告）、`pnpm run verify:release`、本轮 6 个源码文件的 Biome 只读 lint、`git diff --check`。
- 未执行：真实 Provider 请求、最新补丁后的安装包重建/安装、ZIP 运行验收和 GitHub CI/Release；用户提供的密钥未写入仓库或日志。

## Current plan — 使用体验与工具完整性（2026-09-20）

- 分级：C2 + R-ui/R-runtime + A0。继承现有产品边界，工具状态必须来自当前执行轮次，工具输出不得破坏原始标题。
- 外部报告已补齐：`<desktop>\mastra-desktop代码审计报告_2026-09-20.md`。以当前源码核对逐项纳入；报告宣称 58 项但仅列出 20 个编号问题，没有代码提交身份/完整复现记录，不把总数、评分、工时或 P0 标签直接作为事实。
- 安全专项、安装包收敛和发布暂缓；用户已授权本地调试与测试，覆盖旧计划中“仅静态检查”的限制。
- 第一批已完成：`chunkDocument` 保留 Markdown 标题/层级且遵守分块大小；`getActiveToolsFromMessages` 不把历史轮次未完成工具计入新轮次。4 项函数测试及类型检查已通过，桌面回归待做。
- 第二批 P1（下一步）：定位重复 key 对应的数据实体与 Maximum update depth 的组件栈；检查后台流 reader 生命周期、取消和断线恢复。复现后定点修复，不先假定 task ID 重复，也不预先在三层添加去重。
- 第三批 P1/P2：无工作区空态与局部失败恢复、文件工具失败语义、脚本执行反馈、Provider 可用性和技能发现。计划批准链路作为暂缓的授权专项保留，不顺手更改权限策略。
- 第四批 P2：终端反复开关/线程切换、浏览器断流与重开、Provider 请求取消，以及大文件树滚动采样；根据测量决定局部隔离、列表虚拟化和状态订阅优化。
- 第五批 P3：仅随相关修复整理类型、日志和组件职责，不以行数阈值启动全库重构。CI/发布、依赖升级和包体裁剪不纳入当前执行批次。
- 验收：第一批采用无网络、无数据库的实际依赖/函数回归测试和类型检查；整机流畅度需后续桌面运行与性能采样，不能用单测代替。

### 独立报告逐项核对与处置

| 报告编号 | 当前源码核对 | 纳入计划的方式 |
| --- | --- | --- |
| 1、2、6、7、8、19、20 | Electron 隔离、Token、SVG、认证策略、环境变量和凭证权限属于安全专项；本次未逐一确认其漏洞定性 | 按用户要求暂缓，保留原始报告引用，不标已修复或已接受风险 |
| 3 reader 泄漏 | `use-browser-session.ts` 已有 `finally { reader.releaseLock(); }`，卸载有 abort/取消动画帧；报告示例与实际不符 | 不采纳为已确认 P0；保留断网、异常帧、切线程的运行回归 |
| 4 无等待无限重连 | `background-task-stream.ts` 已有 1000ms 等待；但 reader 缺少显式 finally 释放，非成功 HTTP 会直接退出订阅 | 改列 P1 流生命周期/恢复待验证；测试 EOF、读异常、服务中断/恢复及 unsubscribe，按状态区分重试和终止 |
| 5 Promise.race | `mcp.ts` 实际竞争授权 URL 和认证完成，无报告所称 timeoutPromise；“两个 reject 必然造成未处理拒绝”不足以成立 | P2 验证 MCP 认证失败、取消、回调先返回后的迟到失败；不直接应用报告 catch 转值补丁 |
| 9、13 大组件/Main | 文件规模是维护线索，不能直接证明卡顿 | P3 随已证实问题做局部拆分；不设机械行数验收 |
| 10 无 Error Boundary | 项目使用 TanStack Router，依赖存在 CatchBoundary/ErrorComponent；仍需核对覆盖和实际恢复能力 | P1/P2 验证聊天/工作区/终端故障能否局部恢复；不称整个应用完全无错误边界 |
| 11 Terminal Map 无清理 | `terminal-session.tsx` 卸载调用 `reportTerminalSession(sessionId, null)`，store 有 delete | 原定性不成立；P2 检查实际卸载/隐藏/切线程时的 Map 和 PTY 生命周期，不添加固定 24h 强制淘汰 |
| 12 包体 2.9GB | 缺少对应产物身份，与历史安装测量不能直接合并 | 暂缓包体工作；不得照报告删除 Provider/字体或改为首次启动下载 |
| 14 Provider timer 未清理 | `providers.ts` 已在 finally 中 clearTimeout | 该位置不作为修复项；P2 回归成功/失败/取消时清理 |
| 15 any、17 console | 工程治理线索，不等于当前用户阻断 | P3 局部收紧类型/错误上下文，不全库替换或隐藏有价值的错误日志 |
| 16 Store 切片 | 建议性重构，缺少收益验证 | P3 根据实际订阅/渲染证据决定，不为架构形式单独拆分 |
| 18 文件树 | 存在递归 TreeRows，但 1000+ 文件卡顿尚无本轮性能测量 | P2 同目录测试展开、折叠、滚动、切换线程，再判断是否虚拟化 |

依赖建议纠偏：报告把 Playwright 1.63 → 1.47 称为升级，实际版本顺序相反；不执行。关于“无关键 CVE”“完全许可合规”“零测试覆盖”也不作为本轮确认结论，已有第一批回归脚本。

### 下一批完成标准

实机反馈优先级覆盖（11:43–11:46）：用户再次复现 Maximum update depth，当前主 blocker 为 React 更新循环，不以已有 14 个函数/流测试代替桌面验收。先获取完整 stack、做最小工具回放；同时新增累计 totalUsage 被当作上下文水位/附件预算的 P1；grep .ps1 过滤与 chunkSize/default-overlap 冲突为已核对 P2，Windows 输出编码为待复现 P2。详细证据见审计文档顶部。暂停全量长回合自动扫工具；安全与包体仍暂缓。

消息展示子项进度：用固定输入复现同一 toolCallId 的 input/output 快照跨 assistant 行被直接拼接，传给 ToolGroup 后造成重复 key。现于 `buildDisplayMessages` 的单个助手消息组内按 toolCallId 更新快照，保留首次位置和最新状态；同时逐条追加到新数组，避免每合并一行复制全部前缀。新增 3 项测试覆盖跨行/单行/dynamic-tool、文本顺序、轮次隔离和冻结输入。两组共 14 项测试通过，typecheck/lint 通过。此为构造输入复现，不是历史 UUID 的现场归因；Maximum update depth 仍待真实组件栈定位。

第二批执行进度：后台流子项已修复并通过 7 项测试，包括本机随机端口真实 HTTP 的 503→恢复 SSE→取消断开；第一次针对性测试为 4 失败/1 通过。实现有上限的 1–30 秒退避，408/429/5xx 重试，其他非成功状态结束订阅；流结束/读异常释放 reader，取消清理 reader/计时器/迟到响应。三套 typecheck 通过。此项不代表真实 Mastra/Electron 端到端或卡顿验收通过。下一项仍为重复 key/更新循环的组件栈取证。

1. 卡顿：捕获组件栈与可重放输入；修复前后在同环境记录错误计数、交互停顿和进程内存，报告观察窗口。缺少样本时保留待定位，不宣称解决。
2. 流与工具：正常结束、读异常、服务恢复、切线程、主动取消均有定点测试；取消后不重连、不向旧会话写状态。历史工具不复活；成功/失败/取消不能永久显示运行中。
3. 空态与错误：无工作区时出现明确引导；局部失败可以重试且不丢失其他区域会话。UI 改动需真实渲染截图与交互检查，截图不替代功能测试。
4. 工具完整性：固定小型测试工作区验证文件读写失败、命令退出码、技能发现、Provider 测试反馈；记录声明能力与实际可用能力差异。
5. 不归因先行：上游/本轮新增问题用基线 diff 与同依赖输入对照判断；源码未改不等于上游已复现。保留现有安全边界和用户数据。

## Runtime freeze triage (2026-09-20，历史记录，以下归因已纠正)

纠正：日志只能证明重复 key 和更新深度错误同时存在，尚不能确定 key 属于任务或轮询导致循环。未修改某文件不能证明缺陷来自上游；需要同依赖、同输入对照。进程证据文件仅保存进程信息，不包含完整错误日志和内存样本。以下旧结论不作为修复依据。

- `pnpm run dev` 启动成功后，日志出现同一 task id 的 React duplicate-key 警告超过 1200 次、`Maximum update depth exceeded`、`ResizeObserver loop` 和 `Thread has no browsable workspace`。
- 采样到的 active dev tree：electron-vite 约 2.17 GB private memory，Mastra 约 0.71 GB，renderer 约 0.55 GB；已保存进 `.agent/runtime-evidence/dev-ui-freeze-20260920.log` 并停止该项目进程树。
- 归因边界：当前测试为 Vite/Electron dev，不是 NSIS 安装包；安装包精简不能解释 React duplicate key 或 update-depth。相关 chat task 文件未出现在当前工作树 diff 中，初步判定为上游任务快照/渲染链路缺陷。
- 下一次修复前置条件：先在 `parseTaskItems`、服务端 display-state 和 task stream 三层做按 id 去重，补唯一 key 与快照稳定性断言，再复现多工具并发场景确认内存是否回落；本轮只完成分类和证据采集，未改任务 UI 代码。

## 2026-09-21 follow-up：当前构建失败后的收敛计划

1. 已完成最小修复：任务/工具快照去重、渲染 key 防冲突、busy 状态相同值不通知；DeepSeek thinking 请求在 provider 边界补齐 `reasoning_content`。
2. 已完成证据：干净 `pnpm run build` 成功；`pnpm run typecheck` 成功；`pnpm run test:regression` 31/31 通过；重启后的 `/health` 与 renderer 根页面均返回 200。
3. 当前不再执行全量长回合自动扫。用户只需在重启后的窗口先做一次“单工具调用”，再做一次“多工具/长任务”；若失败，保存主进程日志中首次 `Maximum update depth`、重复 key 或 provider 400 的时间窗。
4. 通过门槛：单工具调用无 React 更新深度错误；多工具任务结束后任务队列能收敛；DeepSeek 不再出现缺失 `reasoning_content` 的 400；失败时界面仍可继续输入或重试。
5. 若仍失败，下一轮只根据新时间窗做组件栈/数据实体归因，不扩大修复面、不重新打包、不做包体精简。
