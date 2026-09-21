# 工程问题修复当前状态

## 2026-09-21：成果冻结与基线修复（当前阶段）

- Goal：固定当前改进成果，拆分本地可回滚提交，并在同一基线上修复长任务中断/页面卡顿。
- Product core：保留本地优先工作台、Provider、工具链、后台任务和桌面端能力；不以性能修复为由缩减能力。
- Baseline：`origin/main` 与 `HEAD` 均为 `90312644ff0af8d938552207345a416c88f2db9f`。
- Working-tree identity：冻结前 `git diff --binary` SHA-256 为 `352d3931eed2762a7e91c2d0dea9060cc2509cdfb36fb7ee2b760f818d0929ea`。
- Decision：先生成推送概览并做本地里程碑提交；不 push、不 force-push、不重打包。之后只在冻结里程碑上做专项修复。
- Implemented：已创建 `docs/push-overview.md`，明确成果分组、冻结顺序、排除项、已知未闭环问题和推送前门槛。
- Evidence：只读盘点确认 62 个已修改路径、多个新增测试/文档/资源；所有改动仍未提交，未发现远端分支已包含这些成果。
- Blocker：真实桌面长任务的流中断、鼠标/滚动卡顿仍未闭环；CUA/browser-harness 不可用；安装包瘦身和 Release 暂停。
- Next：检查并暂存成果分组，创建本地冻结分支/提交；随后补专项性能/事件频率证据，再实施最小修复和 fresh-context review。

### 专项修复进展

- 已完成：后台 SSE 任务事件在 120ms 窗口批量写入任务卡；不再对每个 output chunk 拉取 display-state；仅终态以 500ms 有界刷新持久化快照。
- 已完成：display-state 回写采用终态单调合并，避免终态 SSE 到达后被尚未落库的 running 快照短暂覆盖。
- 已完成：已完成的 `execute_typescript` / 工作区命令详情默认折叠，运行中 sandbox 自动展开并在完成时收起；普通工具不被强制展开，详情仍可手动打开。
- 证据：Biome、`pnpm run typecheck`、`pnpm run test:regression`（34/34）、`git diff --check` 通过；fresh-context 复核待本次二次调整完成后回报。
- 未闭环：真实桌面窗口中的鼠标/滚动响应和流式中断仍未 TRIAL；当前修复基于源码调用链和专项门禁，不宣称桌面端已完全通过。

## 2026-09-21：批准卡死与长任务停滞修复（待验证）

- 已定位：批准按钮把完整长流 Promise 当作 busy；重连 GET 丢失 `keepUntilIdle`；重放过滤前未计数后台任务；前台流结束后没有持续刷新后台任务快照。
- 已改动：恢复请求 dispatch 后立即释放 busy，失败且仍挂起时恢复交互；GET 流沿用后台保持语义；新增后台任务生命周期追踪与初始快照；后台 SSE 事件触发 display-state 刷新；active run 存在时不覆盖本地实时消息。
- 仍待：类型检查、回归脚本、运行中服务健康检查，以及用户手工长任务/批准回归。未重打包、未安装、未推送。
- 视觉自动化：本轮 CUA 连接失败，未取得新的浏览器截图；不得宣称桌面视觉验收通过。
- 验证更新：Biome 定点检查、`pnpm run typecheck`、`pnpm run test:regression`（34/34）和 `git diff --check` 通过；开发服务 5173 可访问、Mastra `/health` 返回 200。隔离 Chromium 登录冒烟无 pageerror，但授权账号返回 401，未进入真实会话，故长任务/计划按钮仍需用户手测。
- fresh review 追加发现已处理：恢复失败回调加线程守卫；设置刷新与恢复流失败分离；移除不存在的路由层模式跃迁调用，交由已安装 Mastra `ControllerSession` 的 submit_plan 路径处理；订阅先于后台任务快照建立，避免快照竞态；补齐 output/timed-out 任务事件。
- fresh reviewer 最终复核通过：过期 preflight 与 outer catch 的异步线程身份守卫均已补齐，未发现新增阻断。

## 2026-09-21：开发启动故障已恢复

- 现象：重复执行 `pnpm run dev` 时，pnpm 交换依赖失败，无法删除 `node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty`，Windows 返回 `拒绝访问 (os error 5)`。
- 根因：上一轮 `electron-vite dev` 进程树仍在运行并占用项目依赖；不是源码依赖解析或 lockfile 错误。
- 处理：核对命令行后仅终止该项目的 dev 进程树，未删除 `node_modules`、未清理用户数据；随后原命令重新启动成功。
- 证据：renderer `5173` 正在监听，Mastra `4111/health` 返回 HTTP 200。当前 Node24/pnpm11 的 engine warning 仍存在，但不是本次失败原因。

## 2026-09-21：定向体验修复（待用户手工回归）

- 已修复流结束后的服务端状态对账：`useThreadChats` 发出结算信号，`ChatPanel` 用 `activeRunId` 做有限退避，并保留非当前线程的待结算标记；对账前检查本地 Chat 状态，避免旧快照覆盖新一轮流。
- 已修复新会话模式竞态：首条提交把当前 `modeId` 显式传入创建线程请求，兼容原有标题字符串调用。
- 已修复浏览器开发态 `OpenInIde` 对缺失 Electron preload 的误报；Electron 运行时路径不变。
- 证据：`pnpm run typecheck` 通过；`pnpm run test:regression` 32/32 通过；`git diff --check` 通过。隔离 Playwright 简单流式 UI 测试显示最终文本且无 `pageerror`。工具链实测能收到最终文本/工具标记，但一次试验仍有“进行中”残留，故未宣称长任务 UI 完全通过。
- 边界：测试使用隔离 Chromium 和本地开发服务，未附着用户当前 Edge，也未重新构建/安装 Windows 包；需要用户重启开发服务后按 `.agent/PLAN.md` 的 3 步手测回归。

## 当前批次：工具完整性源码修复（partial runtime acceptance）

2026-09-20：grep 39文本探针/单文件/glob已通过；core1.67.0版本固定pnpm补丁覆盖ESM/CJS；Windows显式outputEncoding前后台原始流解码通过。委派无最终文本明确未完成并保留证据索引；审批历史区分批准/否决/修订/未知，恢复submittedPlan字段；技能说明不冒充已安装能力。29回归、三套类型检查、源码门禁通过，CJS额外3项真实工具测试通过。独立review两项发现（patch LF和大文件读取预算）已处理。UI探针连续两次因Vite预编译超时，VISUAL_QA_BLOCKED；未打包/安装/推送，不宣称React崩溃或卡顿已解决。临时core-patch提取目录约62.6MiB位于D盘，清理命令被宿主策略拒绝，已gitignore防误提交。

## 最新检查点：上下文统计修复，登录受阻

本轮以 docs/project-audit/10-context-usage-runtime-followup.md 为准，下方为历史记录。累计计费与最后请求上下文已分离；24 项回归、三套 typecheck、源码门禁通过。独立 React 探针未复现循环，原始会话仍未定位。最新账号登录返回邮箱或密码错误，待确认；未改账号/旧数据，未打包或推送，保留能力。

## 最新状态：测试包已交付，等待桌面验收

2026-09-20：上传清理非阻塞/单飞/节流修复；21回归、3套类型检查通过；fresh reviewer源码及归档检查通过。独立目录dist-review-20260920-1259内已生成未签名0.0.1 setup（655.73MiB），不覆盖旧包。未安装或启动新包；原开发实例已停止。详情与身份见RESULT最新节和docs/project-audit/09-fresh-review-test-build.md。卡顿/React循环、上下文统计、grep/编码仍待处理，不声明整体修复。

## 当前交付：能力恢复第一批（partial）

- 已恢复资料库媒体读取到50MB文件上限及video dataURL路径；仍遵守模型能力和上下文预算，非新增视频聊天支持。
- 内置目录已补原创 workspace-tool-check/windows-terminal；仅加入可安装资源，不修改用户技能，不冒充旧EE技能全量等价。
- 已修chunker小size默认overlap、流式合并短写及Provider纯文本探针指令；20项回归通过，后端类型检查、源码资源检查和两技能校验通过。
- 实机React循环、卡顿、上下文统计、上传清理阻塞、grep和编码仍待处理。没有重打包、安装、发布或桌面验收。
- 本批详细身份及证据见RESULT最新节；下文旧“下一步”冲突时以PLAN当前批次为准。

## 最新进展：体验与工具完整性（2026-09-20）

- 最新实机反馈推翻“已可用于完整工具测试”的任何暗示：Maximum update depth 再现并中断生成。当前阶段回到 DIAGNOSE，完整组件栈未取得（CUA 连接失败、用户终端未附着当前任务）。本轮仅审计，没有增加业务补丁。
- 新增核对项：totalUsage 被当单次上下文水位且影响附件预算；grep 扩展名过滤跳过 .ps1；默认 overlap=160 与 chunkSize=100 冲突已用依赖复现。编码乱码仍待原始输出对照。用户截图反馈 Markdown 标题修复有效。

- 用户要求安全专项暂缓，安装包精简继续暂停；当前允许本地调试测试。
- 用户已补发 Mastra 专项报告；已核对主要稳定性条目并在 PLAN 中映射全部 20 个编号。reader/timer/terminal 清理和无等待重连等报告定性与当前源码不符，不能直接照单修复。
- 第一批已修复：Markdown 切块保留六级标题与元数据、再按大小递归切分；当前工具队列只读取最后一条用户消息后的工具状态，避免旧轮次残留。
- 第二批后台流子项已完成：临时 HTTP 故障恢复、上限 30 秒的重试退避、reader 释放、取消等待/计时器及迟到响应隔离；7 项定点测试通过，含真实本机 HTTP 故障恢复和取消断开。三套 typecheck 通过；未启动整套桌面应用。
- 消息展示子项已修复：合并助手消息时，同一 toolCallId 仅保留最新快照并固定首次位置，避免重复工具卡片 key；新增 3 项回归测试通过。来源为构造输入复现，未确认与历史 UUID 相同，也未证明解决更新循环。当前两组共 14 项通过，typecheck/lint 通过。
- 4 项函数/依赖回归测试由修复前 3 失败变为全部通过；三套 typecheck 通过。测试不访问用户数据库、不调用模型。
- 真实桌面卡顿尚未复验，重复 key 的数据实体与更新循环的组件栈仍待定位；撤回之前直接归因上游任务 ID/轮询的说法。
- 下一步优先重复渲染与后台流生命周期/断线恢复，其后无工作区空态、局部错误恢复、文件工具失败语义与脚本反馈；终端/文件树性能采样随后进行。下文为先前阶段记录，冲突时以本节和 PLAN 最新计划为准。

## Goal

按问题审查结果落实安全、发布、数据清理和资源控制修复。

## Product core

本地优先的 AI 工作台；本轮不改变产品定位，只收紧边界和减少可确认的工程风险。

## Non-goals

不重复进行大规模构建或安装；不删除用户数据；不对未验证的真实运行路径作通过声明。

## Phase

P1-SOURCE-ACCEPTANCE：安装包体积收敛按用户要求暂停；当前等待最新源码重新构建，并由用户手工验证 Provider、Mastra 重启和 20 MB 上传协议。

本轮 fresh-context 审查后进入 Provider/上传正确性修复：先修复内置 registry URL
未传入模型工厂、模型测试错误语义和附件能力不一致，再做静态/类型验证。

## Decision

按 `.agent/DESIGN.md` 的 G0 和五项关键决策执行；同一文件不并发写入，主线程负责整合和最终证据。

## Implemented

- 已建立本轮 DESIGN/PLAN 工件并完成文件 ownership 分配。
- 已完成高优先级修复和低风险配置收敛，详情见 `.agent/RESULT.md`。
- fresh-context review 已完成；已修正打包 builtin-skills 路径和 tag-push Release 门槛。
- 应用桌面图标资源已按用户提供的图像重生成 PNG/ICO/ICNS，并让 Windows/Linux 窗口复用同一资源。
- 侧栏品牌位、登录页品牌区和 favicon 统一引用 renderer public 的 icon.png。
- multipart 和分片上传改为文件路径/流式 hash、复制与合并；文档格式按需读取一次，媒体文件不再在上传入口整体读入内存；资产后处理失败会清理目标文件。
- 媒体上下文增加 8 MB inline 上限，超限在读取前返回可解释提示。
- verify:release 静态发布门禁已接入 PR check 和 tag/manual build；pnpm minimumReleaseAge 恢复为 1440 分钟。
- 新增 `clean:package`/`verify:package` 发布产物门禁；当前旧 dist 已被 verify-package 正确识别为 stale setup。安装现场证据已记录，NSIS 临时目录已清理。
- electron-builder 增加 source map 排除规则；清理后的 `electron-builder --dir` 已成功，`win-unpacked` 约 2.19 GB，source map 为 0，详细数据见 `.agent/package-size-20260919.md`。
- `verify:package` 在目录包上按预期拒绝缺少 setup/blockmap，证明不完整产物不会进入上传阶段。
- 新增并通过 `verify:package:dir`，目录包模式现在会检查 EXE、`app.asar` 和 Chromium 可执行文件；Mastra 入口现位于 `app.asar\\.mastra\\output\\index.mjs`，不再从 `app.asar.unpacked` 启动。
- 新增 docs/release-smoke.md，记录三平台安装、启动、退出、安全边界和大文件验收。
- 修复 build:win 暴露的 17 个 renderer 类型错误及一个遗漏的分片读取导入，`pnpm run typecheck` 已通过。
- 首轮 Windows 安装尝试已记录并清理：约 1.64 GB setup.exe 在约 10.6 分钟内将 Temp 解压到约 7.14 GB、约 20.9 万文件，安装目标仍为空，随后按用户阈值终止。
- 首轮安装后启动失败根因已确认：从 `app.asar.unpacked\\.mastra\\output\\index.mjs` 启动时无法解析 `@mastra/core`；同时发现 sandbox preload 外部依赖未 bundle、`resources/icon.png` 未显式纳入包体。
- 修复内容：Mastra 入口改从 `app.asar` 启动；preload 开启单文件 bundle；electron-builder 显式包含 `resources/icon.png`，并排除 `.mastra/output/node_modules`，避免重复封装依赖树。
- 修复版 NSIS 安装包已完成真实 smoke：setup 约 656.33 MB，安装目录约 2.02 GB；窗口标题 `MastraWork`，4111 `/health` 返回 200，子进程命令行为安装目录下 `resources\\app.asar\\.mastra\\output\\index.mjs`，关闭后进程和端口均清理。
- 当前 clean `win-unpacked` 约 2.18 GB，`app.asar` 约 708.61 MB，`app.asar.unpacked` 约 1.13 GB；主要体积仍是浏览器资源和 native/runtime 依赖，不能直接删除。
- `asarUnpack` 已从 `resources/**` 收敛为浏览器与内置技能目录，避免 `resources/icon.png` 在 asar 与 unpacked 目录重复；`verify:package:dir` 已增加解包目录和重复图标门禁。
- 复核截图后发现 `/settings` 分支将依赖 `useSidebar()` 的 `GlobalCommandPalette` 渲染在 Provider 外；现已改为由主工作台显式注入 `toggleSidebar` 能力，设置页不再调用 `useSidebar()`，避免启动崩溃和隐藏 Provider 的无效切换。
- fresh-context 全库复审后，已修复内置 registry Provider 的 URL 传递、Provider 纯文本连通性探针与上游状态保留、上传错误语义以及聊天附件 allowlist；`pnpm-workspace.yaml` 中的无效 `allowBuilds` 占位值也已改为明确白名单。

## Evidence

- 基线：`main` 与 `origin/main` 同步，当前提交 `90312644ff0af8d938552207345a416c88f2db9f`。
- 问题证据：`docs/project-audit/03-common-issues-severity.md`。
- 项目约束：`AGENT.md`、`DESIGN.md`。
- 本轮验证：`pnpm run typecheck`、`pnpm run verify:release`、针对 6 个本轮源码文件的 Biome 只读 lint、`git diff --check` 均通过。typecheck 在当前 Node 24/pnpm 11 环境完成，但该环境不符合项目声明的 Node 22/pnpm 12，需在标准环境复验。
- 本轮追加静态验证目标：Workspace 淘汰路径不得销毁 `pending`/`initializing`/`ready` 实例；上传完成必须先删除数据库状态，再 best-effort 清理目录；孤儿目录只清理无会话且超过 24 小时的目录；打包目录必须保留浏览器/内置技能解包资源且不得重复解包图标。

## Verification boundary

本轮没有使用用户提供的密钥发起真实请求，也没有重新构建安装包；因此 DeepSeek 登录测试、ZIP 知识库上传、安装后 Electron smoke 和 GitHub CI/Release 仍待标准环境/用户手工验证。安装包仍偏大，后续可单独开展浏览器/native runtime 的精简实验；不能在未做功能归因前直接删除运行时文件。

## Next

1. 在标准 Node 22/pnpm 12 环境重新执行 typecheck、构建和本轮 Provider/上传静态断言。
2. 用户或受控环境用实际 DeepSeek 凭据手工验证 Provider 测试；凭据不写入仓库或日志。
3. 用户启动最新构建，手动验证 `/settings`、Mastra 重启、附件类型和 20 MB 上传协议，并反馈日志/截图。
4. 根据手工结果修复阻断问题；通过后再做干净安装包 Enterprise 扫描。
5. 最后用 GitHub PR、tag 构建和 Release 记录验证 CI/Release 链路。
6. 安装包体积收敛暂缓，不继续删除浏览器/native/runtime 资源。
## 最新诊断：长工具链 React 崩溃防线（2026-09-20）

- 针对长任务中重复任务/工具快照导致 React 重复 key 的可复现风险，新增 `normalizeAgentTasks`：保留首次顺序、使用最新状态，并同时覆盖消息投影和服务端 display-state 投影。
- 工具轨迹的组 key 和组内工具 key 增加位置维度，避免异常/重连数据使用相同 `toolCallId` 时发生重复 key。
- Electron 主进程新增 renderer 退出、无响应/恢复及关键控制台错误诊断；不记录消息内容或凭据。
- `test:regression` 30/30、三套 TypeScript 检查通过。真实 Electron 长任务仍需重启开发实例后复测；当前没有证据把所有崩溃归因到这一个修复，也没有重新打包。

## 2026-09-21：失败回归后的定向修复与重启

- 新证据确认：当前构建在长工具链中出现 `Maximum update depth exceeded`，并伴随重复 key 与 DeepSeek `400 reasoning_content`；此前 32/33 工具报告不代表当前构建的桌面验收通过。
- 已完成定向防线：任务快照按 id 保留最新状态、工具轨迹/队列/工作流步骤使用位置稳定 key、busy store 相同值不再重复通知；DeepSeek registry 仅在 OpenAI-compatible 请求边界补齐 assistant `reasoning_content`，其他 Provider 不变。
- 已新增 DeepSeek request transform 回归用例；`pnpm run typecheck` 通过，`pnpm run test:regression` 现为 31/31 通过。
- 已停止占用 `4111` 的旧 dev server，完成一次干净 `pnpm run build`（成功，保留非致命 Vite dynamic import 与 Node 版本警告），随后重新启动 `pnpm run dev`；当前 `4111/health` 返回 200，renderer `http://[::1]:5173/` 返回 200。
- 仍未宣称真实桌面长任务已通过：CUA/browser-harness 当前不可用，必须由用户在重启后的窗口执行一次最小工具调用和一次长工具链；若再次失败，应以新的主进程日志和错误时间窗继续定位，而不是重复全量扫。
