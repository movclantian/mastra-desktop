# 工程问题修复结果

## 2026-09-21：第一次推送候选已记录

- State：第一次推送候选已固定在 `codex/freeze-audited-results`；基线为 `origin/main@9031264`，当前基线前进 9 个本地提交。
- Recorded：已记录技能迁移、Electron/媒体/上传边界、回归测试抽取器、长任务限频与快照合并的引入原因、后果和未归因现象；完整复核见 `docs/project-audit/11-first-push-review.md`。
- Verification：`pnpm run typecheck` 通过；`pnpm run test:regression` 为 34/34；`pnpm run verify:release` 通过；基线 `origin/main` 已 fetch 且当前分支无落后提交。
- Push boundary：只允许推送当前分支，不改写 `origin/main`，不执行 force-push、不发布 Release；`tests/shots/` 仅为本地截图证据，不进入推送快照。
- Limitation：上游没有本次新增回归脚本，不能把历史 2/14 vs 14/14 当作可复现 A/B；真实桌面长任务、云端 CI/Release 和最新安装包仍未宣称通过。

## 2026-09-21：成果冻结准备（进行中）

- State：未推送；当前 `HEAD`/`origin/main` 为 `9031264`，改进成果仍在工作树。
- Changed：创建 `docs/push-overview.md`，明确成果分组、冻结顺序、排除项、已知未闭环问题和推送前门槛；未改业务逻辑。
- Verification：已完成 `git status`、基线/远端、diff 路径和工作树指纹盘点；正式冻结提交前仍需逐组确认 staged 清单。
- Runtime evidence：本节不宣称桌面端长任务通过；流中断和页面卡顿保留为下一批专项问题。
- Known issues：后台 SSE 输出事件会进入前端状态刷新路径；消息列表和工具输出可能形成高渲染负载；这只是待验证根因，不是已修复结论。
- Evidence refs：`docs/push-overview.md`、`.agent/PLAN.md`、`.agent/CURRENT_STATE.md`。

## 2026-09-21：长任务卡顿/中断专项修复（待桌面 TRIAL）

- State：修复已完成，尚未推送；在冻结提交 `0b42216` 之后形成独立工作树改动。
- Changed：后台任务 SSE output 不再逐事件调用 `reloadDisplayState()`；任务卡状态以 120ms 批量刷新；终态以 500ms 有界持久化刷新；终态状态对 stale running snapshot 单调保护；完成的 sandbox 工具详情默认收起、运行中保持可见。
- Follow-up：合并持久化快照时保留当前 SSE 已观察但快照暂缺的任务，覆盖分页/落库竞态，避免终态任务在刷新后消失。
- Verification：Biome 通过；`pnpm run typecheck` 通过；`pnpm run test:regression` 34/34 通过；`git diff --check` 通过；本机 5173 renderer 和 4111 `/health` 均返回 200。
- Runtime evidence：当前没有可附着的用户桌面浏览器/长任务时间窗；CUA/browser-harness 不可用，因此只能标记 partial，不能声称鼠标卡顿或流中断已在真实桌面消失。
- Review：fresh-context spot check 确认终态 SSE 不会被 stale running 快照覆盖，分页/落库延迟时本地已观察任务不会从 UI 消失；未发现剩余 P1/P2。
- Known issues：长消息投影和富文本渲染仍可能是第二级负载来源；若用户复测仍卡顿，下一轮只针对该调用链取证，不回退到全库盲改。

## 2026-09-21：批准卡死与长任务记录停滞（验证中）

根因已由 fresh-context review 与源码调用链交叉确认：UI busy 生命周期错误、重连流生命周期参数丢失、后台任务重放计数缺口，以及前台流结束后的任务快照刷新缺口。当前工作树已完成最小定向修复；测试结果将在本节追加。此批不包含安装包、推送或安全/体积改动。

- 修复：恢复请求派发后立即释放按钮 busy；失败且服务端仍挂起时恢复交互，并移除 detached Promise 未处理拒绝。
- 修复：重连 GET 流传递 `keepUntilIdle`；任务管理器快照补种 pending/running；重放过滤前计数后台任务开始/结束事件；后台 SSE 事件触发 display-state 刷新。
- 补充：前端补齐 `background-task-timed-out` 到终态映射，避免超时任务被永久当作 running，进而让轮询和任务卡片长期不收口。
- 修复：active run 存在时不重载落后消息历史；后台任务运行期间继续轮询任务快照；路由边界同步批准后的模式上下文。
- 证据：定点 Biome 检查、`pnpm run typecheck`、`pnpm run test:regression`（34/34）和 `git diff --check` 通过；开发服务 5173/4111 健康。隔离 Chromium 登录页渲染无 pageerror，但授权账号返回 401，未进行真实模型/长任务请求。
- 限制：CUA/browser-harness 连接失败；没有当前用户桌面会话的视觉和长任务证据。需要用户重启/刷新当前页面后手测批准一次、继续观察长任务记录，不应把本批静态与隔离结果写成完整桌面验收。
- fresh review 追加的 4 个阻断项已闭环：跨线程异步状态污染、设置刷新误报、路由层模式跃迁 no-op、快照/订阅竞态；并补上 output/timed-out 生命周期。复跑门禁仍为 34/34。
- fresh reviewer 最终复核通过：过期 preflight 与 outer catch 的两处异步线程身份守卫均已补齐，未发现新增阻断。

## 最新结果：开发服务重启故障（2026-09-21）

- `pnpm run dev` 首次失败的直接原因是 pnpm 无法替换被旧 `electron-vite dev` 进程占用的 `node-pty@1.1.0` 目录，错误为 Windows `拒绝访问 (os error 5)`。
- 已核对并终止仅属于本项目的旧 Electron/Mastra 进程树；没有删除依赖目录、用户数据或工作区文件。
- 原命令随后启动成功：Vite renderer `http://localhost:5173/` 已监听，Mastra `http://localhost:4111/health` 返回 200。
- Node24/pnpm11 的 engine warning 仍是环境提示，不是本次启动失败根因。

## 最新结果：定向体验修复（2026-09-21，待用户手工回归）

- **流式状态**：`useThreadChats` 在结束、不可重试错误、重连耗尽和恢复分支发出结算通知；`ChatPanel` 以 `activeRunId` 做最多 4 次短退避，补拉消息与 display-state。非当前线程的结算会排队到切回时处理；对账前检查本地 `submitted/streaming`，避免上一轮快照覆盖下一轮新流。
- **新线程模式**：创建线程支持可选 `modeId`；首条消息提交时从 store 读取模式快照，解决“执行”回落为“计划”的竞态，原有字符串标题调用保持兼容。
- **开发态宿主保护**：`OpenInIde` 在缺少 Electron preload 的浏览器环境直接跳过 IDE 探测，Electron 环境行为不变。
- **验证**：`pnpm run typecheck` 通过；`pnpm run test:regression` 32/32 通过；`git diff --check` 通过。隔离 Playwright 简单流式测试在不导航的情况下显示最终文本且无 `pageerror`。工具链测试收到最终文本和工具标记，但有一次出现旧“进行中”残留，长任务 UI 仍需用户手测确认。
- **限制**：本批没有重新构建或安装包验收，没有附着用户当前 Edge，也没有使用真实凭据写入项目或报告。当前工作树仍为 dirty，未提交、未推送。
- **下一步**：用户重启 `pnpm run dev` 后，按 `.agent/PLAN.md` 验收新会话模式、单次工具任务和连续两轮消息；若仍卡住，提供时间戳、截图及主进程/renderer 日志，再继续定位。

## 当前结果：工具完整性修复

状态：源码与工具层验证通过，整应用验收未完成。基线HEAD 90312644ff0af8d938552207345a416c88f2db9f，dirty工作树；本批依赖补丁SHA256 405aa5429f8870ca1a11d0cd6d2fa6aa0b2f02abee59d4ee250b172de976906f（lock及verify:release门禁一致）。

- grep按内容检测而非扩展名；39探针全命中，单ps1/glob/README通过。8MiB默认读取预算防大二进制OOM，支持显式提高；跳过明确提示结果不完整。
- Windows命令显式outputEncoding在原始字节层生效，独立stdout/stderr有状态解码；前台、后台、单字节分块GBK/UTF8、原退出码和实际工具schema链路通过。不是自动识别任何程序编码。
- 子代理空总结明确未完成、结束原因和最多12条工具证据索引，结构化结果保留；不猜测步数耗尽。
- 审批历史恢复submittedPlan内容、标题、路径，区分批准/否决/需修订/未知，不改变后端审批授权。
- 补技能缺失说明；未安装或伪造browser-harness，不更改用户全局AGENTS.md。
- 29项回归、三套typecheck、verify:release、git diff --check通过；另用CJS入口复跑3项真实工具测试通过。Node24/pnpm11环境非项目声明Node22/pnpm12，仍待标准环境复验。
- 独立review提出patch换行与大文件全读风险，已修复并定点复核。UI探针两次依赖预编译超时，无截图通过声明。现有安装包不含本批，standalone .mastra/output不保证保留补丁（见patches/README.md）。未打包、安装、commit或push。
- 清理临时提取目录被宿主策略拒绝；D盘.agent/core-patch约62.6MiB仍在，已排除Git。保留用户数据。

## 最新结果：上下文统计与费用未知态（未打包）

2026-09-20：按 dev-loop 的协议边界验证，分开最后请求 contextUsage 与累计 usage/totalUsage，旧记录显示未知。24 项回归、三套类型检查、源码发布门禁通过；fresh reviewer 8 场景真实 React 渲染及截图复核通过（隔离组件，不含完整应用样式）。高密度工具 React 探针未复现崩溃，不算原会话修复。最新账号认证失败，登录后全线验收待用户确认邮箱。现有安装包不含此改动；未安装、推送或削减能力。详见 docs/project-audit/10-context-usage-runtime-followup.md。

## 最新交付：fresh review + Windows测试安装包

上传维护后台单飞/5分钟节流已修复；21项回归、三套typecheck、源码和产物检查通过。fresh agent独立源码/归档审查未发现测试包阻断项。构建与安装验收严格分开：新包已生成，但未安装/启动验证；React崩溃仍未闭环。

完整代码身份、review范围、命令、警告、校验值见 `docs/project-audit/09-fresh-review-test-build.md`。产物 `dist-review-20260920-1259/mastra-desktop-0.0.1-setup.exe`，655.73MiB，未签名，SHA256 `8FAF72480B7A55C52176B6F68E601C7BA101EE5CBF462DF11813E5B2D3757EA8`。旧包保留，开发实例已停止；无发布推送。

## 最新交付：能力恢复第一批（2026-09-20，partial）

- code_identity：HEAD `90312644ff0af8d938552207345a416c88f2db9f` + 本批关键8文件内容指纹 `6acaa32359cd865785de85668fcd052d6d3df4bf91d6629e9c1f53daf2ef9597`。指纹按路径+文件字节依次SHA256：rag/types.ts、rag/tools.ts、rag/storage/upload.ts、rag/storage/assets.ts（均在src/mastra）、src/mastra/routes/providers.ts、两项builtin SKILL.md、scripts/test-capability-regressions.mjs。不是整个工作树指纹。
- 修复：取消我们新增的8MB限制（与50MB上传上限统一），恢复资料库video读取；保留模型能力/预算判断。媒体测试用元数据边界和小字节fixture，不是50MB真实内存验收。
- 新增原创内置工作区工具检查和Windows终端指导技能，走现有目录/安装机制；并非浏览器工具或旧EE集合的等价替代。未替用户安装。
- 修复chunker省略overlap时的小size默认值，保留显式合法参数、非法显式值报错；真实MDocument测试1/100/160/200/1200大小。
- 修复流式合并短写，测试部分写/零写/磁盘错误；没有故障注入真实用户数据库。
- 清除Provider测试残留结构化指令。未调用付费模型。
- 验证：三测试脚本20/20；直接运行typescript/bin/tsc --noEmit -p tsconfig.mastra.json通过；verify-release-source通过；两技能quick_validate以Python -X utf8通过（首次默认GBK读取失败，调整验证器编码后通过）；git diff --check通过。
- 新增test:regression和PR检查步骤；云端CI未运行。本机Node24.19，不是声明的Node22标准环境。
- 未做：桌面启动/交互验收、React崩溃根因修复、上下文统计、上传清理阻塞、grep/编码、包体积与安全专项。无提交推送。

## 最新交付：助手消息工具快照合并（2026-09-20）

- State: 消息合并缺口已复现并修复，整机性能仍待验收。
- 触发：固定输入中，相邻助手行包含同一调用的 input-available 和 output-available，旧 `buildDisplayMessages` 直接拼接；ToolGroup 使用 toolCallId 作为 key，因而生成重复卡片。
- 修复：在一个连续助手消息组内按 toolCallId 保留首次位置/最新快照，用户轮次之间不去重；保留文本和原始数据。逐条 push 到独立展示数组，避免逐行重拷贝累计 parts。
- Evidence: 新增前两项测试修复前失败，修复后全部通过；再补单行 dynamic tool/重复文本/冻结输入测试。体验脚本 7 项、后台流脚本 7 项均通过，三套 typecheck 和定点 Biome/diff 检查通过。
- Boundary: 使用构造输入调用实际源码函数，没有重放用户数据库、渲染桌面或取得历史 UUID 的组件栈；不宣称该项就是历史卡顿根因，不宣称 Maximum update depth 已解决。源码修复不涉及 JSX/布局。
- code_identity: HEAD `90312644ff0af8d938552207345a416c88f2db9f` + 未提交工作树；`display.ts` SHA256 `325345FCA214A1B0676C8140732C85BCAA8B93D7C456B47915A3162ADDE98032`；体验测试 SHA256 `D6C4B3977076A5E72ED5FC699199BFC27D9C69F92D7F8E6FDBDAE1686260ECC5`。
- Next: 桌面复现实测及组件栈采集；无工作区目录刷新/目录加载仍有未处理拒绝的源码线索，待下一批定点测试。安全与包体继续暂缓。

## 最新交付：后台工具流恢复与取消（2026-09-20）

- State: 后台流子项已实现并验证；页面卡顿/重复 key 仍待定位。
- Changed: `background-task-stream.ts` 对 408/429/5xx 重连并采用 1–30 秒退避；EOF/读异常释放 reader；unsubscribe 取消活动 reader、定时等待并隔离迟到响应/事件。认证等非重试错误结束订阅。
- Verification: 新测试修复前 4 失败/1 通过；修复后 7 项通过。上一批 4 项也通过。完整 typecheck、两文件 Biome、定点 diff check 通过。
- Runtime evidence: `scripts/test-background-task-stream.mjs` 使用本机随机端口 HTTP 服务实际返回 503，第二次连接发送 SSE，实际 fetch 收到 completed，取消后服务端观察到连接关闭；该项约 1.1 秒通过。其他分支使用原生 ReadableStream 与可控计时器。服务在 finally 关闭，不留下后台进程。
- Limit: HTTP 试验使用测试服务，替换了 apiFetch，不覆盖真实鉴权、Mastra 服务和 Electron UI；不能宣称完整桌面验收或卡顿解决。仍为 Node 24/pnpm 11 环境，标准环境复验待做。
- code_identity: 基于 HEAD `90312644ff0af8d938552207345a416c88f2db9f` 的未提交工作树；本批 SHA256：源码 `A1AA59B840847C3414D7940E22C03319D128ED71F135BA8F2756E7740093A823`；测试 `9580FC2465F784B32E7024C62321E991807E6E07B71173F450033B980A677879`。
- Next: 获取重复 key/更新循环的真实组件栈和输入，再决定定点修复；安全/包体工作继续暂缓。

## 最新交付：体验/工具第一批（2026-09-20）

- State: 两项局部修复已实现并通过函数回归；整机卡顿与界面验收仍未完成。
- Plan: `.agent/PLAN.md` 的 Current plan。用户要求暂缓安全专项与安装包收敛。
- Markdown：实际 MDocument 默认 Markdown 路径复现标题被改为 `#{1,6}`；显式六级标题切分、保留标题，再递归按大小切分，保留层级元数据。此函数在当前 HEAD 基线中同样使用默认路径。
- 工具队列：仅投影最近用户轮次内的工具，避免历史中断工具在新轮次重新显示运行中；保留同轮跨 assistant 消息的完成/失败/拒绝终态处理。
- Evidence: `node --test scripts/test-experience-regressions.mjs` 修复前 3 失败/1 通过，修复后 4 通过；三套 `pnpm run typecheck` 通过；3 个变更文件 Biome 检查通过；`git diff --check` 通过。
- 测试边界：测试提取实际纯函数并调用实际 Mastra/AI SDK 依赖，不初始化 UI、数据库或模型请求；不代表桌面 E2E、性能、上游独立安装对照通过。环境仍为 Node 24.19/pnpm 11.19，不符合项目声明的 Node 22/pnpm 12，标准环境需复验。
- code_identity: HEAD `90312644ff0af8d938552207345a416c88f2db9f` + 未提交工作树；本批 SHA256：
  - `src/mastra/rag/document/indexing.ts`: `334DCB5D1B00D26E98CC47FB3E754EDCFEC53735EA5D86ED63AE7A8DB2EC435D`
  - `src/renderer/src/widgets/chat-panel/model/types.ts`: `67BD2651858681C60BEF75BAD0435000B1E1C8A6720D79C9CEB655B8D86E86B1`
  - `scripts/test-experience-regressions.mjs`: `DC791F14AB5E9CA5AA00F65689E197B915BCB0E5FF741A975521755F1DF8971C`
- 新附件实际审计 Java/IdeaProjects，不能采纳为本项目的 73 项问题。待正确附件补充。
- 下文为先前阶段的交付，不能作为本批修复的运行证据。

## State

implemented/partially verified：源码和配置修复已完成；首轮 Windows 安装失败已复现并定位，修复版 NSIS 安装包已完成安装、启动、健康检查和退出验收。最新的资源边界收敛尚未重新构建，图标去重和体积变化仍待用户/CI 验收；安装包其余大体积精简属于后续独立 P1 工作。

## Changed

- 技能运行时改用 `resources/builtin-skills/`，按 `PLAYWRIGHT_BROWSERS_PATH` 定位开发/打包资源，并在 electron-builder 中排除 `@mastra/editor` 的 `ee/` 路径。
- PR 工作流新增轻量 lint/typecheck，普通 PR 不再执行全平台打包；tag/workflow_dispatch 保留打包，Release 仅由 tag push 发布并保留写权限。
- pnpm 移除全局构建脚本放行，保留显式 allowBuilds；Node 约束为 22.x；lint 改为只读并增加 `lint:fix`。
- Chromium 安装脚本增加已安装版本检测和 `INSTALL_BROWSER_SKIP=1`。
- 分片上传增加启动/创建会话时过期清理、过期索引、失败可重试的临时目录清理，并改为顺序合并。
- Electron 恢复 sandbox 默认值，增加可信 renderer 的 CSP/导航限制；Mastra CORS 收紧到本地 renderer 来源和必要方法/请求头。
- Workspace runtime/cache 增加 scope 和实例上限及 LRU 淘汰；文本附件不再在注入上下文前无条件读取完整文件。
- 应用图标统一替换为用户提供的蓝紫渐变图：更新 `resources/icon.png`、`build/icon.png`、`build/icon.ico`、`build/icon.icns`，并让 electron-builder 显式使用 `build/icon`；Windows/Linux 开发窗口也复用该资源。
- 侧栏、登录页品牌区和 renderer favicon 改用同一份 src/renderer/public/icon.png，保留登录/导航语义图标；gitignore 已显式放行该 renderer 资源，发布门禁会检查它。
- multipart 上传、分片合并和资产落盘改为文件路径/流式处理；媒体上传不再在请求入口读成完整 Buffer；资产抽取或入库失败会清理已复制的目标文件，数据库写入完成后索引设置读取失败不会删除已持久化资产，避免文件/记录不一致。
- 媒体上下文增加 8 MB inline data URL 上限，超过上限在读取文件前返回明确提示。
- pnpm 恢复 1440 分钟 minimum release age；新增 scripts/verify-release-source.mjs 和 verify:release CI 门禁。
- 新增 docs/release-smoke.md，把安装后验收从“未定义”变成可执行手工清单。
- 新增 `clean:package` 和 `verify:package`：发布前清理 `dist`，校验目标平台产物、blockmap、未安装目录可执行文件和 Windows setup 新鲜度；tag/manual workflow 已接入门禁。
- electron-builder 增加 source map 排除规则，避免把开发调试映射重复封装进 app.asar 和 Mastra deploy 输出；修复后 `electron-builder --dir` 的 `win-unpacked` 约 2.18 GB、`app.asar` 约 708.61 MB、source map 为 0，详见 `.agent/package-size-20260919.md`。
- 修复安装后运行时边界：Mastra 入口从 `app.asar` 启动以保留 app-level ESM 依赖解析；preload 改为单文件 bundle；显式纳入 `resources/icon.png`；排除 `.mastra/output/node_modules`，避免把 deployer 依赖树重复放入 `app.asar.unpacked`。
- 追加修复路由上下文边界：`GlobalCommandPalette` 不再直接读取 `useSidebar()`；主工作台显式注入真实侧栏切换能力，`/settings` 分支省略该能力，避免 `useSidebar must be used within a SidebarProvider` 阻断设置页。
- 追加修复命令能力边界：主工作台才注入真实 `toggleSidebar`；设置页不再挂载隐藏 Provider、重复注册 `Ctrl+B`，也不再展示无效的“切换主导航侧边栏”命令。
- 修复 Mastra 崩溃重启时的 stopping guard 复位，并统一上传会话默认分片与路由上限为 20 MB。
- 移除 renderer 内静态 CSP，统一由主进程按实际 renderer/Vite 端口注入，避免端口回退后残留 `ws://localhost:5173` 白名单。
- 追加安全收敛：Workspace 缓存只淘汰明确处于 `error`/`destroyed` 终态的实例，不再为了容量上限直接销毁活跃工作区；上传完成先删除数据库会话/分片记录，磁盘目录清理失败不再把已落盘资产报告为失败，并增加超过 24 小时且无数据库会话的孤儿目录清理。

## Verification

- `node --check scripts/install-browser.mjs` 通过。
- `package.json` JSON 解析通过。
- `.github/workflows/release.yml` YAML 解析通过。
- Release workflow 静态断言通过：PR check、tag/manual build、tag-push release 和 `contents: write` 权限均存在。
- `git diff --check` 通过；未跟踪工件另做空白检查通过。
- Enterprise 技能运行时路径扫描未发现 `@mastra/editor/ee` 的执行路径。
- `pnpm@12.4.1` Windows shim 已重新链接原生可执行文件；同一 shim 执行 `pnpm run verify:release` 成功。
- 修复命令面板导入、快捷键事件类型和 workspace 面板联合类型后，`pnpm run typecheck` 通过。
- fresh-context Provider/上传 follow-up 补丁已执行 `pnpm run typecheck`、`pnpm run verify:release`、针对 6 个源码文件的 Biome 只读 lint 和 `git diff --check`；未用真实密钥发请求，也未重新构建安装包或执行最新工作树的安装后 smoke。

## Known issues / runtime evidence

- `pnpm run typecheck` 已通过（当前 Node 24/pnpm 11，和项目声明的 Node 22/pnpm 12 不一致）；`verify:release` 与本轮 6 文件只读 lint 已通过。此前修复版 NSIS 的启动/健康/退出 smoke 证据仍保留，但不代表本轮 Provider/上传补丁已重新打包验收；完整 lint、核心用户路径和跨平台 smoke 仍未完成。
- Windows 安装证据：`mastra-desktop-0.0.1-setup.exe` 约 1.64 GB；安装器运行约 10.6 分钟仍停留在 `%TEMP%\\nssBC21.tmp`，临时目录约 7.14 GB、约 209,130 个文件，安装目标为 0 个文件，随后终止；终止后临时目录约 7.54 GB，证据记录完成后已清理。
- packaged smoke 证据：停止确认属于项目的开发态进程树后，以 `dist/win-unpacked/mastra-desktop.exe --user-data-dir=%TEMP%\\mastrawork-packaged-smoke-20260919` 启动；主进程 PID `24284`，窗口标题 `MastraWork` 且有窗口句柄；Mastra 子进程 PID `26828` 的命令行来自 `dist/win-unpacked/resources/app.asar.unpacked/.mastra/output/index.mjs`；4111 监听归属该子进程，`/health` 返回 200；关闭窗口后 Electron、Mastra 和 4111 均退出。
- 上述目录包 smoke 是修复前证据，曾证明目录包能运行但不能代表安装后依赖解析正确；首轮 NSIS 安装后启动则复现 `ERR_MODULE_NOT_FOUND: @mastra/core`，原因是入口从 `app.asar.unpacked` 启动。
- 修复版目录包与 NSIS 安装 smoke 均通过：修复版 setup 约 656.33 MB（SHA-256 `A1A6DD9CABFE513C81C128A5211FEB2787AECA92095DFB549F0D4B5D22A8A3A5`）；安装目录约 2.02 GB；窗口标题 `MastraWork`，4111 `/health` 返回 200；安装后的 Mastra 子进程命令行来自 `resources\\app.asar\\.mastra\\output\\index.mjs`；关闭后 Electron、Mastra 和 4111 均退出。
- 安装后的 `app.asar` 静态检查通过：包含 `.mastra\\output\\index.mjs`、`resources\\icon.png` 和 `node_modules\\@electron-toolkit\\preload`，不包含 `.mastra\\output\\node_modules`。这是此前修复版安装包的证据，不是本轮 Provider/上传补丁的重新构建证据。
- 浏览器资源实验：临时隐藏 `chromium_headless_shell-1243`、`ffmpeg-1011`、`winldd-1007` 后，Playwright headless 启动明确报缺少 `chromium_headless_shell`；恢复目录后相同启动 smoke 成功。headless shell 不能直接删除，ffmpeg/winldd 未据此判定可删。
- 历史失败产物的体积拆分显示：`resources/app.asar` 约 1.07 GB、`app.asar.unpacked` 约 1.93 GB，其中 `.mastra/output/node_modules` 约 0.80 GB、`resources/browsers` 约 0.69 GB、unpacked `node_modules` 约 0.44 GB；这是安装器慢和磁盘峰值的主要证据。当前 clean `--dir` 产物约 2.18 GB，不能把两次构建的差值全部归因于 source map 排除。
- `setup.exe` 最后修改时间早于最新 `.nsis.7z`，本地构建没有 clean dist 和产物新鲜度门禁；后续必须校验 setup/blockmap/版本与当前 `win-unpacked` 同一构建身份。
- 新增的 `node scripts/verify-package-artifacts.mjs` 已对旧 `dist` 正确报错（setup 比 `win-unpacked` 旧超过允许偏差），证明它能拦截 stale artifact；随后以 clean dist 生成新目录包和 setup，并通过 `verify:package`。
- `verify:package:dir` 已通过，目录包模式检查 EXE、`app.asar` 和 Chromium 可执行文件；`verify:package` 已通过，确认 setup/blockmap/目录包属于同一份新鲜产物，避免把目录包误当成完整安装包。
- 开发态和修复版目录包均观察到窗口标题 `MastraWork`、Mastra `/health` 返回 200；修复版 NSIS 安装也完成同样的启动/退出验收。
- CSP、sandbox preload、CORS 的完整用户路径和跨平台行为仍待手动验证；本次安装启动未再出现 preload module-not-found。
- 截图中的 `useSidebar` 错误已通过静态调用树定位并修复；需用户重新启动并打开 `/settings` 实际确认页面恢复。
- 并发审查发现的两个 P2 风险已做保守源码修复：活跃 Workspace 不再被 LRU 直接 destroy；上传完成改为数据库状态优先、磁盘清理 best-effort，并增加孤儿目录宽限清理。in-flight 并发行为、故障注入和大文件磁盘回收仍需真实运行验证。
- Windows 快捷方式、安装包资源和开发窗口图标需要在本机重新构建/启动后手动确认；桌面或任务栏已有快捷方式可能需要重建以刷新 Windows 图标缓存。
- 侧栏、登录页品牌区和 favicon 已改为新图标，但需要实际启动 renderer 截图确认尺寸、裁切和 favicon 缓存。
- 安装包最终是否完全排除 `ee/` 内容仍需对干净构建产物做许可证扫描。
- 上传流式改动和媒体预算尚未通过 50 MB/大媒体真实运行测量；文档/PDF 抽取仍会按需读入内存，这是本轮保留的解析器边界。
- verify:release 已在当前工作树执行通过，但 GitHub runner 上的 pnpm 安装、PR check 和 tag 发布链路仍待真实 CI 运行。
- 许可证审计脚本的可复现化和超大模块拆分未在本轮实施，保留为后续 P3 任务。
- Windows 安装器体积精简和发布产物一致性仍是后续 P1；本轮已将 `asarUnpack` 收敛为浏览器/内置技能目录并在 `verify:package:dir` 增加重复图标门禁，预计只消除约 0.7MB 的确定重复；当前主要体积来自内置浏览器资源和 native/runtime 依赖，而不是本轮图标/CI/上传改动。
- 当前已完成发布门禁、source map 排除、入口/预加载修复和 NSIS 安装 smoke；浏览器资源和 native runtime 仍占主要体积，下一轮需要基于真实消费者做拆分，不能把当前安装包宣称为体积已达标。
- fresh-context 复审确认：DeepSeek/同类 registry URL 传递、Provider 测试错误语义、上传错误分类和聊天文本附件白名单已在源码修复；真实 DeepSeek 请求、ZIP 知识库行为、标准 Node 22/pnpm 12 构建、GitHub CI/Release 仍是下一步验收项。

## Evidence identity

- 基线：`main` / `origin/main`，提交 `90312644ff0af8d938552207345a416c88f2db9f`。
- 计划：`.agent/PLAN.md`。
- 设计：`.agent/DESIGN.md`。
