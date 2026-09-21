# 通用问题与严重度分层

## 2026-09-20 11:43–11:46 实机反馈审计（未实施新修复）

用户截图再次显示 `Maximum update depth exceeded`，生成已中断；此前函数测试不能证明这个主故障已解决。应用内 Agent 的自测叙述仅作线索，不作为独立验收。

| 优先级 | 发现 | 证据/界限 | 下一步 |
| --- | --- | --- | --- |
| P1 | React 更新循环导致生成中断 | 用户 114339 截图直接确认；原工具卡片重复 key 修复没有覆盖本故障。浏览器 CUA 连接失败，当前任务未附着用户终端，因此没有取得现场组件栈 | 暂停整套 33 工具长回合测试，取得完整 Error.stack/组件栈；以最少一次工具调用、工具输出突发和终端面板出现为对照分离触发条件 |
| P1 | 上下文用量口径错误 | `routes/session.ts:615-616` 将 finish.totalUsage 作为 metadata.usage；`routes/chat.ts:451` 又存为 contextUsage；chat-panel.tsx 以 usage.inputTokens 扣减附件预算；context-usage.tsx 将同一 usage 与单模型窗口比较。截图为 5.5M / 1.0M。累计 usage 不能当单次上下文水位 | 分开累计计费与最后模型调用上下文输入；同时核对附件预算，不能仅改 UI 百分比。未捕获实际原始 finish payload，不断言具体 5.5M 的组成 |
| P2 | grep 静默跳过 .ps1 | 已安装 core 的 TEXT_EXTENSIONS 没有 .ps1；实际执行其 isTextFile 得到 ps1=false、txt=true、md=true；grep 分支在直接文件和目录遍历中调用该过滤器 | 制定文本识别/扩展名支持方式，使用 .ps1/.txt 同内容对照，保留二进制排除；不直接手改 node_modules |
| P2 | chunkSize 与默认 overlap 冲突 | rag/tools.ts 独立覆盖 chunkSize 而未约束继承的 overlap，默认 160；真实 MDocument recursive(maxSize=100,overlap=160) 报 `Chunk overlap (160) must be smaller than chunk size (100).` | 只在未显式指定 overlap 时归一化到有效范围；显式无效组合给明确参数错误。验证省略/显式/size=1 等边界 |
| P2 | Windows 命令输出乱码 | 用户截图显示 cmd 输出乱码，依赖解码路径尚未完成端到端核对 | 原始字节和系统代码页对照 CP936/UTF-8，区分普通命令工具与 PTY；不全局切换代码页或用错误解码掩盖 |
| 已有用户反馈 | Markdown 标题修复有效 | 用户 114621 截图显示标题保留、Header 1/2 元数据存在；这是用户提供的验收反馈 | 保留既有回归测试；本次 overlap 是不同缺陷 |

资源采样：运行中项目 PID 42448（Vite）PrivateMemory 2206MB，PID 48088（renderer）776MB，PID 49296（Mastra）936MB，CLI 710MB、GPU 348MB、主进程96MB、网络16MB。单次采样不证明泄漏；CPUSeconds 为进程累计 CPU 时间，不是当前 CPU 占用率。采样不等于截图瞬间，未停止进程、未修改用户数据或业务代码。

归因：本次所查 session.ts、chat-panel.tsx、rag/tools.ts 在工作树未改，提示既有代码路径，但没有同环境完整上游回放，不能宣称全部是上游问题。已做消息/流修复仍不足以通过桌面验收。

> 2026-09-20 体验修复更新：用户已补发 Mastra 专项审计，全部 20 个编号条目的核对与处置见 `.agent/PLAN.md`。报告称 58 个问题但未给出完整明细，不沿用其问题总数和评分。已用实际函数/依赖复现并修复 Markdown 标题破坏、历史工具状态带入新轮次两项问题；4 项回归测试通过，完整 typecheck 通过。桌面性能尚未复验。后文历史条目的“上游归因”如无基线对照仅为假设。

> 审查快照：`main` / `9031264`。本篇只记录当前仓库能够回溯到源码、配置或命令结果的问题；本轮最新 Provider/上传补丁尚未重新启动应用或打包，因此“已确认”不等于“已在所有平台复现”。此前修复版 Windows 安装 smoke 的证据保留在 `.agent/RESULT.md`，不与本轮补丁混为一谈。路径和行号以当前工作树为准。

> 并发复审补充：以下 `A-*` 条目来自本轮三个只读 agent 的 fresh-context 审查和主线程静态整合；最新补丁只完成静态/类型验证，故“源码已修复”仍不等于运行时已验证。

## 1. 分级与判定标准

严重度描述影响，等级描述处理优先级。两者分开，避免把“很容易修”误判成“影响很小”。

| 等级 | 名称 | 严重度判定 | 处理要求 |
| --- | --- | --- | --- |
| **P0 / 阻断** | 发布或安全红线 | 违反许可证/安全边界，可能导致发布不可合法进行、数据不可逆丢失，或核心能力在默认路径必然失败 | 暂停发布；先关闭根因，再做定点复核和发布前审计 |
| **P1 / 高** | 主要路径或资源风险 | 正常用户路径经常失败，或会造成明显的磁盘/内存/进程/供应链风险；虽可能有绕过方式，但不能依赖用户自行规避 | 当前迭代优先修复；至少补针对性自动检查或真实运行证据 |
| **P2 / 中** | 可靠性与工程风险 | 在特定平台、输入规模或维护动作下会失败、变慢、积累脏数据，或使 CI/升级难以信任 | 纳入近期计划；补验证、限额、监控或文档约束 |
| **P3 / 低** | 可维护性与体验债务 | 不立即阻塞使用，但会增加理解成本、误操作概率或后续改动成本 | 与相关模块改动合并处理，不单独扩散抽象 |

结论状态采用 `已确认`、`已验证`、`风险提示`、`待验证`：

- **已确认**：源码/配置直接证明现状，不需要猜运行结果。
- **已验证**：除源码外已有针对性命令、构建或真实运行证据；本轮没有运行测试，所以不滥用此标签。
- **风险提示**：机制上存在可解释风险，但影响大小仍依赖平台、数据或攻击模型。
- **待验证**：必须通过运行、安装、CI 或真实用户路径才能定论。

## 2. 优先级总览

| 编号 | 等级 | 领域 | 状态 | 一句话结论 |
| --- | --- | --- | --- | --- |
| I-01 | P0 | 许可证/发布 | 已确认；发布影响待验证 | 内置技能路径直接指向 `@mastra/editor` 的 `ee/` 内容，并复制到用户目录；项目自己的许可证盘点已把它标为发布前必须移除的开放项 |
| I-02 | P1 | CI/回归 | 已确认 | PR 工作流只监听发布配置文件，绝大多数 `src/**` 改动不会触发任何构建检查 |
| I-03 | P1 | 上传资源 | 已确认 | 完成分片上传时同时保留所有 chunk 和合并后的完整 buffer，50 MB 文件会产生至少一倍额外内存峰值 |
| I-04 | P1 | 本地磁盘 | 已确认 | 上传会话写入 24 小时过期时间，但在当前仓库可见调用链中没有发现过期清理路径；中断上传留下的 chunk 文件可能持续积累 |
| I-05 | P2 | Electron 安全 | 风险提示；攻击路径待验证 | `BrowserWindow` 显式关闭 sandbox；若 renderer 出现可利用的 XSS，主进程能力隔离面会更弱 |
| I-06 | P1 | 测试/发布 | 已确认；Windows 安装失败已复现 | 没有 `test`/E2E 脚本，发布 CI 只做构建和打包；本次 Windows 安装器超过 10 分钟仍停留在临时解压，未写入安装目标 |
| I-07 | P2 | 供应链 | 部分修复；供应链审计待验证 | 已移除全局构建脚本放行并恢复 1440 分钟 minimumReleaseAge；逐包 allowBuilds 白名单仍需随依赖升级复审 |
| I-08 | P2 | 启动/构建 | 已确认；网络故障影响待验证 | `dev`、`start`、`build` 每次都先执行 Chromium 安装命令，可能触发 CDN/代理检查或下载 |
| I-09 | P2 | 运行时缓存 | 风险提示；长会话待验证 | Workspace 按 scope/thread 无限放进内存 Map，只有删除线程或重配置才销毁，没有容量或空闲淘汰 |
| I-10 | P2 | API 边界 | 风险提示；威胁模型待验证 | 本地 Mastra 服务 CORS 为 `origin: "*"`，并允许所有方法和请求头，暴露面大于桌面内部调用所需范围 |
| I-11 | P2 | 环境一致性 | 已确认 | README 要求 Node 22，但 `package.json` 没有 `engines` 约束；本地错误 Node 版本会延迟到安装/构建阶段才失败 |
| I-12 | P2 | 数据流/网络 | 部分修复；运行影响待验证 | 资产上传和媒体上下文已增加流式路径与 8 MB inline 门槛；文档抽取和小媒体仍会按需读入内存 |
| I-13 | P3 | 命令语义 | 已确认 | `pnpm lint` 使用 `biome check --write .`，所谓 lint 会修改整个工作树，不适合作为只读 CI 检查 |
| I-14 | P3 | 审计可复现性 | 已确认 | 许可证审计脚本放在被 `.gitignore` 忽略的 `.vscode` 下，干净 checkout 无法复跑同一审计 |
| I-15 | P3 | 模块维护 | 已确认 | 关键运行模块体积过大：主进程、聊天路由、多个页面/组件达到数万字节，变更容易形成高耦合回归面 |
| I-16 | P1 | Windows 打包 | 已确认；安装后启动未验证 | 安装包约 1.64 GB，NSIS 临时解压超过 7 GB、约 20.9 万文件；目标目录仍为空，且 setup.exe 时间戳早于最新 `.nsis.7z` |

## 2.1 本轮实施后的状态

以下状态基于当前未提交工作树和静态检查；没有把未运行的应用、安装器或 GitHub CI 当成“已验证”。

| 条目 | 当前状态 | 还需要什么 |
| --- | --- | --- |
| I-01 Enterprise 内容 | 源码路径已移除，改用 `resources/builtin-skills/`，并加入打包排除规则 | 干净构建后做安装包/许可证扫描 |
| I-02 CI 回归 | 已补源码 PR 的 lint/typecheck 门禁，并保留 tag 发布 | 用仅改 `src/**` 的真实 PR 验证 GitHub check UI |
| I-03 上传峰值 | 已改为文件路径/流式 hash、复制与分片合并；文档抽取仍按需读取一次，后处理失败会清理目标文件 | 手动测量 50 MB 并发峰值，后续再评估端到端解析流 |
| I-04 过期上传 | 已在初始化和会话创建路径清理过期行及 chunk 目录，失败会保留待重试 | 长时间中断上传的磁盘回收实测 |
| I-05 Electron 隔离 | 已恢复默认 sandbox，并加入 CSP、可信导航和外链限制 | 运行时安全回归，尤其是 preload/XSS 路径 |
| I-06 安装后验收 | 缺少自动验收；Windows 安装器已实测在 10.6 分钟后终止 | 先缩减发布内容并补产物新鲜度/退出码门禁，再做三平台启动/退出 smoke |
| I-07 供应链安装 | 已移除全局构建脚本放行，恢复 1440 分钟 minimumReleaseAge，保留逐包白名单 | 评估白名单是否还能继续收缩，并在依赖升级时复审 |
| I-08 Chromium 启动 | 已增加已安装检测和 `INSTALL_BROWSER_SKIP=1` | 离线/代理环境下验证重复启动不触网 |
| I-09 Workspace 缓存 | 已保守改为只回收 `error`/`destroyed` 终态实例；活跃实例不因容量上限直接销毁 | 长会话、多 scope 和 in-flight 压测 |
| I-10 CORS | 已收紧为本地 renderer 来源和必要方法/请求头 | 跨源调用的运行时回归 |
| I-11 Node 约束 | 已加入 Node 22.x `engines` | 在干净环境验证安装阶段提示一致 |
| I-12 大文件媒体 | 文本附件避免无条件整文件读取；媒体超过 8 MB 不再读取并转 base64 | 手动确认大媒体被拒绝时的用户提示和内存峰值 |
| I-13 lint 语义 | 已改为只读 `biome check .`，另提供 `lint:fix` | 在 CI 和贡献说明中统一命令名 |
| I-14 审计复现 | 尚未实施 | 将许可证审计脚本移入受版本控制的 `scripts/` 并接入 CI |
| I-15 模块维护 | 尚未实施 | 结合测试和调用图做按领域拆分，避免机械拆文件 |
| I-16 Windows 打包 | 已完成第一处安全裁剪：`asarUnpack` 仅保留浏览器/内置技能目录，避免图标重复解包；大体积根因仍在 | 干净构建后通过 `verify:package:dir`；若要削减数百 MB，先决定按需浏览器或远程 embedding，再做运行时拆分 |

图标专项：已按用户提供的图像重新生成 `resources/icon.png`、`build/icon.png`、`build/icon.ico` 和 `build/icon.icns`，并让 electron-builder 显式使用 `build/icon`；Windows/Linux 窗口、侧栏、登录品牌区和 favicon 已复用该资源。已有快捷方式可能需要重建才能刷新 Windows 图标缓存。

## 2.2 并发复审补充（当前工作树）

| 编号 | 等级 | 状态 | 证据与结论 |
| --- | --- | --- | --- |
| A-01 | P1 | 源码已修复；运行待验证 | `/settings` 的 `GlobalCommandPalette` 不再直接调用 `useSidebar()`；主工作台通过 `MainGlobalCommandPalette` 注入真实能力，设置页省略该能力（`src/renderer/src/app/app-shell.tsx:52-55,156-163,215`；`src/renderer/src/features/command-palette/command-palette.tsx:92-100,711-730`）。 |
| A-02 | P1 | 源码已修复；运行待验证 | Mastra 崩溃重启在 `stopMastra()` 后复位 `isMastraStopping`，避免新进程退出被静默忽略（`src/main/index.ts:571-579,713`）。 |
| A-03 | P1 | 源码已修复；协议待验证 | 上传会话默认分片与路由流式解析上限统一为 20 MB，错误消息从常量生成（`src/mastra/rag/types.ts:39-42`；`src/mastra/routes/library.ts:59-67`）。 |
| A-04 | P2 | 源码已修复；运行待验证 | 删除 renderer 静态 CSP，主进程按实际 `ELECTRON_RENDERER_URL` 注入 websocket/origin，避免端口回退后残留 `5173` 白名单（`src/renderer/index.html:8-10`；`src/main/index.ts:285-311,771-788`）。 |
| A-05 | P2 | 源码已保守修复；运行待验证 | Workspace 缓存只允许淘汰 `error/destroyed` 终态实例；`pending/initializing/ready` 实例不因容量上限被 destroy（`src/mastra/workspace/index.ts:385-414,558-560`）。Mastra 未提供公开 in-flight 计数，仍需并发压测。 |
| A-06 | P2 | 源码已保守修复；故障注入待验证 | 上传完成先删除数据库会话/分片记录，再 best-effort 清理目录；超过 24 小时且无数据库会话的专用孤儿目录才会被回收（`src/mastra/rag/storage/upload.ts:226-251`；`src/mastra/rag/storage/db.ts:26-70`）。仍需模拟 DB/文件删除失败和重试。 |
| A-07 | P2 | 源码已修复；运行待验证 | 设置页 Provider 关闭 `Ctrl+B` 全局监听，命令菜单在没有 `toggleSidebar` 能力时不展示该动作，避免隐藏 Provider 无效切换（`src/renderer/src/pages/settings/ui/settings-page.tsx:228-233`；`src/renderer/src/shared/ui/sidebar.tsx:48-99`；`src/renderer/src/features/command-palette/shortcut-menu.ts:453-456,589-593`）。 |

本轮静态证据：`git diff --check` 通过，命令面板源码不再直接引用 `useSidebar`，Workspace 淘汰和上传清理路径符合保守策略。A-01/A-02/A-03/A-04/A-05/A-06/A-07 仍需在重新构建后由用户手工 smoke 或故障注入，再更新为“已验证”。

## 2.3 最新 fresh-context 复审与针对性修复

本节由独立 fresh agent 扫描后，主线程逐条核对源码、依赖注册表和当前工作树；不把 agent 报告本身当作运行证据。

| 编号 | 等级 | 结论 | 当前处理状态 |
| --- | --- | --- | --- |
| A-08 | P0 | 内置 Provider 只保存 `registryId + credential`，模型工厂未使用 Mastra registry 的 `url`；`deepseek` 会落到 `api.openai.com`，同类风险覆盖大量带自定义 URL 的供应商 | 已修复：内置解析和 WorkbenchGateway 统一使用 registry URL；显式 custom `baseUrl` 仍优先。`typecheck` 已通过，真实 Provider 请求待手工验证 |
| A-09 | P1 | Provider 测试把所有异常返回 HTTP 400，并强制结构化输出，认证错误、余额不足和“不支持结构化输出”无法区分 | 已修复：连通性探针改为纯文本；保留上游 401/402/429/5xx 状态和 `upstreamStatus` |
| A-10 | P1 | multipart、分片、完成和重索引错误被统一伪装为“文件过大”或通用 400 | 已修复：保留既有 `WorkApiError`；尺寸错误才使用 413，其余使用上传失败语义 |
| A-11 | P1 | 聊天附件白名单少于后端可提取的文本扩展名，导致 `.htm/.scss/.less/.c/.cpp/.h/.hpp/.sh/.ps1/.log` 被前端提前拒绝 | 已修复：补齐聊天 allowlist；ZIP 仍不进入聊天模型链路 |
| A-12 | P2 | ZIP 可在知识库保存和预览，但不会解压或建立索引，最终状态为 `unsupported` | 已确认产品边界：如需 ZIP 内容检索，必须另做安全解压、路径穿越和压缩炸弹防护；本轮不直接放开 |
| A-13 | P2 | WorkbenchGateway 原先未把资源级 Provider 配置和 registry URL 一致带入 Studio/model-router | 已随 A-08 修复；跨 resource 运行时仍待验证 |
| A-14 | P1 | pnpm `allowBuilds` 中出现 `set this to true or false` 占位值，导致依赖重建后 `ERR_PNPM_IGNORED_BUILDS`，遮蔽代码验证 | 已修复：明确放行 `electron-winstaller/esbuild/node-pty`；当前环境 `typecheck` 已通过。Node 24/pnpm 11 与项目 Node 22/pnpm 12 要求不一致，仍需标准环境复验 |

### 2.4 用户实机运行复核：卡顿与页面流畅度

本节依据 2026-09-20 开发桌面进程的实际日志，不把安装包体积猜测成 renderer 性能结论。运行的是 `pnpm run dev`，不是 NSIS 安装包。

| 编号 | 等级 | 分类 | 证据 | 与上游/本轮改动的归因 |
| --- | --- | --- | --- | --- |
| A-15 | P1 | Renderer 重复 key | Vite 客户端反复报告相同 key，尚未确定该 UUID 对应消息、任务或其他实体。 | 待组件栈和数据取证；未修改某个文件不能证明属于上游缺陷。 |
| A-16 | P1 | Renderer 更新循环 | 同一运行会话出现 `Maximum update depth exceeded`。 | 尚未确认触发组件，也未建立与重复 key、轮询的因果关系；需复现后定点修复。 |
| A-17 | P2 | 布局/观察器 | Vite client 多次报告 `ResizeObserver loop completed with undelivered notifications`。 | 更像现有队列卡片/布局观察器在高频任务更新下的开发期警告；需在基线与修复分支各做一次同场景回放，当前不能归因给安装包精简。 |
| A-18 | P1 | 运行时资源 | 当前 dev 进程采样：`electron-vite dev` 约 2.17 GB private memory、约 1.05 GB working set；Mastra 子进程约 0.71 GB，renderer 约 0.55 GB。 | 这是开发模式下 Vite/Mastra/任务数据共同占用，和 NSIS 产物裁剪不是同一层；仍需确认是否由异常渲染循环导致增长。停止本次项目进程树后 4111/5173 均释放。 |
| A-19 | P2 | Provider 外部服务 | 日志显示 `https://tokenrhythm.studio/v1/responses` 返回 HTTP 402 `INSUFFICIENT_BALANCE`。 | 网关余额问题，不是安装包精简或 DeepSeek registry 修复回归；应换有余额的网关或直连 DeepSeek。 |
| A-20 | P2 | Workspace 体验 | 日志出现 `Thread has no browsable workspace`。 | 当前线程未绑定可浏览工作区时的错误处理问题，和打包体积无直接关系；应改为空态/可解释提示，而不是未处理 rejection。 |

进程信息文件：`.agent/runtime-evidence/dev-ui-freeze-20260920.log`，仅保存进程身份/命令行，不包含上述完整错误日志或内存样本。错误和内存信息来自当时工具输出。本次仅停止了 PID 49328 的项目开发进程树。

#### 归因结论

打包排除规则不参与本次 dev renderer 的执行路径，目前没有证据直接指向安装包裁剪。但尚未完成同依赖、同输入的上游/改进版对照，不能排除其他源码改动的影响。撤回“已确认重复 task ID 导致更新循环”的旧结论。

#### 建议修复顺序

1. **P1-A-15/A-16**：先捕获重复 key 的组件栈与输入，定位真实重复实体；禁止在未复现前同时修改三层去重逻辑。
2. **P1-A-16**：复现“多工具并发 + 任务快照轮询”场景，记录 renderer/mastra 内存和每分钟 render 次数；确认更新深度错误消失后再评估是否需要降低轮询频率。
3. **P2-A-17/A-20**：把 ResizeObserver 作为布局回归项；把无 workspace 线程改为空态或引导，不抛未处理 rejection。
4. **P2-A-18**：在无任务、单任务、多任务三种基线下采样开发模式内存；不要用安装包精简替代 renderer 性能修复。

### 2.5 用户工具测试报告的分类

以下条目来自用户粘贴的工具测试结果；已与当前仓库源码和 `git status` 交叉核对。它们不能全部归因于本轮 Provider、上传或安装包改动。

| 条目 | 等级 | 当前判断 | 归因/处理 |
| --- | --- | --- | --- |
| `submit_plan` 返回“Plan approved”但用户未点击批准 | P1 安全/授权 | **需要复现确认**。仓库默认将 `submit_plan` 设为允许，但真正的计划工具还应通过挂起/恢复链路等待用户；当前相关模式、路由和 UI 文件均未被本轮修改。 | 初步属于上游审批链路风险；必须用新线程做“提交计划→不点击批准→确认是否进入 build”回归，不可凭一条工具报告下定论。 |
| 子代理输出编造或混入主线程上下文 | P1 可信度 | 工具输出是外部不可信数据；当前代码已有“fresh-context review”约束，但没有自动 provenance 校验。 | 属于 Agent 编排/上下文隔离问题，不是安装包裁剪；后续增加 agent 输出来源、线程和证据引用校验。 |
| AGENTS.md 要求 `browser-harness`，当前环境没有该技能 | P2 工程环境 | 已确认是环境/指令漂移：`%USERPROFILE%\AGENTS.md` 引用不可用工具，仓库本身不依赖它。 | 不属于产品运行时；应修正环境说明或提供可用的截图工具，不能把未执行截图伪报为完成。 |
| 文件工具失败只有纯文本，没有 `error` 标记 | P2 API 语义 | 报告显示确有可误判空间，但当前未在本轮复现响应 schema。 | 先在 workspace 工具路由补统一错误 envelope 和前端判定，再与上游工具协议逐项比较。 |
| `library_document_chunker` Markdown 标题被改写、metadata 为空 | P2 数据正确性 | 当前 `src/mastra/rag/tools.ts` 未被本轮修改，逻辑直接透传 Mastra MDocument 结果。 | 初步是上游/依赖行为；需补固定输入的回归样例，确认应保留原始 Markdown 标题还是接受分块规范化。 |
| `execute_typescript` 的 ESM warning | P3 开发体验 | 非失败，不影响功能；更像 Node module type 声明缺失。 | 上游/运行环境问题，后续加 `type: module` 或显式 loader，避免把 warning 当错误。 |
| Windows `cmd` 不认 `;` | P3 文档体验 | 这是 cmd 语法与 Unix shell 语法差异，不是命令执行器损坏。 | 补 shell-aware 命令说明；Windows 使用 `&`/`&&` 或 PowerShell，不改业务逻辑。 |

### 2.6 当前归因总表

| 分类 | 代表问题 | 是否由安装包精简造成 |
| --- | --- | --- |
| 运行链路待归因 | duplicate key、Maximum update depth、工具错误 envelope、计划审批需复现 | dev 未经过打包规则；源码层因果仍待对照 |
| 本轮已修复 | registry Provider endpoint、Provider 状态码、上传错误分类、附件 allowlist、allowBuilds 占位值 | 否；这些是源码逻辑修复 |
| 发布/打包层 | NSIS 临时解压、浏览器/native runtime 体积、安装后依赖解析 | 属于打包层；不解释 dev renderer 卡顿 |
| 外部环境/服务 | 402 余额不足、Node/pnpm 版本漂移、缺失 browser-harness、cmd 语法差异 | 否 |

### 复审纠偏

独立比较报告把“视频附件回归”列为高优先级，但源码核对发现：基线的 processor 能力声明和注入分支本来就只支持 image/audio，视频虽曾在资产上下文读取分支中出现，实际不会注入模型。因此该项不作为本轮确认的新增回归；当前去掉视频读取反而避免无效的内存驻留。后续若产品要支持视频，应单独增加模型 capability、token 预算和端到端协议测试。

### 当前验证边界

- 已通过：`pnpm run typecheck`（依赖允许脚本后，在当前 Node 24/pnpm 11 环境完成）；`pnpm run verify:release`；针对本轮 6 个源码文件的 Biome lint（关闭 formatter，仅做只读 lint）；`git diff --check`。
- 未宣称通过：真实 DeepSeek API 请求、登录后的 Provider 测试、知识库 ZIP 上传/索引、安装后 Electron smoke、GitHub CI/Release。上述需要标准 Node 22/pnpm 12 环境和用户提供的真实运行反馈。

## 3. 详细问题

### I-01 — P0：Enterprise Edition 内容进入内置技能路径

**现状与证据**

- `src/mastra/routes/skills.ts:37-39` 把 `@mastra/editor` 的 `ee/workspace/skills` 解析成内置技能根目录。
- `src/mastra/routes/skills.ts:183-224` 枚举并对外返回该目录中的内置技能；`src/mastra/routes/skills.ts:488-505` 还把选中的目录复制到用户技能目录。
- `THIRD-PARTY-NOTICES.md:45` 记录 `@mastra/editor` 的 `ee/` 使用 Enterprise Edition License；`THIRD-PARTY-NOTICES.md:53-57` 明确写出该路径是开放合规项，禁止复制/发布/分发，并要求发布前移除。

**影响与建议**

这不是普通依赖版本风险，而是当前功能调用链直接触达受限内容。应在发布前移除 `ee/` 路径依赖，改用明确授权且可再分发的技能来源；若必须保留，应先取得书面许可并让打包清单、许可证说明和 CI 检查与许可范围一致。补一个干净安装包扫描，确认最终 artifact 中没有该目录或其复制结果。

**状态**：源码路径和项目许可证盘点已确认；最终安装包是否实际携带全部 `ee/` 文件仍待在干净构建中验证。

### I-02 — P1：源码变更不触发 CI 回归

**现状与证据**

`.github/workflows/release.yml:7-14` 的 `pull_request.paths` 只包含 workflow、`electron-builder.yml`、`package.json`、两个 pnpm 配置/锁文件；当前 `.github/workflows` 只有 `release.yml` 和定时清 artifact 的 `remove-old-artifacts.yml`。因此修改 `src/main/**`、`src/mastra/**` 或 `src/renderer/**` 的普通 PR 不会触发构建工作流，也没有另一条源码 CI 兜底。

**影响与建议**

类型错误、打包入口变化、renderer 回归可能直到打 tag 才暴露。把轻量 typecheck/lint/构建验证拆成不受这些路径限制的 PR CI；发布矩阵只保留 tag 或发布相关配置变更，避免每个普通源码 PR 都做全平台打包。

**状态**：触发条件和工作流清单已确认；需要在 GitHub 上用一个仅改 `src/` 的测试 PR 验证最终 check UI 行为。

### I-03 — P1：分片上传完成阶段的内存峰值翻倍

**现状与证据**

- `src/mastra/rag/types.ts:33-39` 允许单文件 50 MB、单请求 100 MB、单 chunk 最大 20 MB。
- `src/mastra/rag/storage/upload.ts:183-191` 把每个 chunk 全部读入 `parts`，同时累计总大小。
- `src/mastra/rag/storage/upload.ts:193-204` 再分配完整 `merged` buffer，将所有 part 复制进去后交给 `uploadAsset`。
- `src/mastra/rag/storage/assets.ts:26-45` 和 `:67-76` 继续基于完整 `Uint8Array` 做 hash、落盘和文本提取。

**影响与建议**

一个 50 MB 文件在完成时至少同时存在 chunks、merged 以及后续处理所需的对象，多个并发上传时峰值继续叠加。应改成流式合并/哈希/落盘，或把合并结果直接写临时文件后按流处理，并为并发上传设置预算和背压。

**状态**：内存保留关系由源码直接确认；实际峰值和并发阈值待在 Windows/macOS/Linux 各跑一次大文件场景测量。

### I-04 — P1：当前调用链没有过期上传会话清理

**现状与证据**

- `src/mastra/rag/storage/upload.ts:62-82` 给上传会话写入 24 小时后的 `expiresAt`。
- `src/mastra/rag/storage/db.ts:97-123` 建立会话和 chunk 表，但只记录 `expires_at`，未定义级联或定时清理。
- `src/mastra/rag/storage/upload.ts:103-121` 查询会话时没有 `expires_at > now` 条件；`:228-250` 只在客户端显式取消时删除 chunk 目录。
- 本轮 `rg` 未找到针对 `library_upload_sessions` / `_chunks` 的过期 sweep；完成路径 `:209-223` 只清理成功完成的会话。这里的结论限定为当前仓库可见调用链，框架或外部运维清理仍待验证。

**影响与建议**

在当前仓库可见调用链中，浏览器关闭、网络中断或用户放弃后，数据库行和 `_chunks/<sessionId>` 文件可能持续保留。单个文件最多 50 MB，重复失败上传可能吃满用户磁盘。应在读取/创建时清理过期行，并删除对应目录；再加启动时或定时 sweep，记录清理失败而不是静默吞掉。

**状态**：缺少清理调用链已确认；长时间重复中断上传后的实际磁盘增长待运行验证。

### I-05 — P2：Electron renderer 关闭 sandbox

**现状与证据**

`src/main/index.ts:723-736` 创建 `BrowserWindow` 时显式设置 `webPreferences.sandbox: false`。同一窗口还加载开发环境的 `ELECTRON_RENDERER_URL`（`:819-824`），并通过 preload 暴露本地能力。

**影响与建议**

关闭 sandbox 并不等同于已经存在漏洞，但会减少 renderer 被攻陷后的隔离层。应确认是否确实依赖非 sandbox 能力；若不依赖，恢复 sandbox，并为 renderer CSP、导航来源和 preload API 做安全回归。若必须关闭，需记录威胁模型、允许的远程内容和可暴露 API，并做 XSS 到本地能力的定点测试。

**状态**：配置事实已确认；是否存在可利用的 renderer 输入到 XSS/本地能力链路待安全测试。

### I-06 — P2：没有测试脚本或安装后验收

**现状与证据**

- `package.json:17-27` 只有 format、lint、typecheck、start/dev/build/package 脚本，没有 `test`、E2E 或 smoke 脚本。
- `.github/workflows/release.yml:86-100` 的 CI 步骤只有依赖安装、`pnpm run build`、electron-builder 打包和 artifact 上传；没有安装、启动、健康检查或核心用户路径。
- README 仅要求贡献者运行 `pnpm typecheck` 和 `pnpm lint`（`README.md:63-69`、`:97`）。

**影响与建议**

当前绿色只能说明某个 runner 生成了文件，不能证明安装后 Electron 能启动、Mastra 服务能健康退出、登录/聊天/终端/上传链路可用。至少为共享 contract、认证、工作区路径和上传清理补单元/集成测试；发布前在每个平台做最小安装后启动与退出 smoke，并把结果作为 artifact/日志。

**状态**：缺少脚本和 CI 步骤已确认；Windows 安装器超时已在本机复现，安装后启动仍未验证。

### I-16 — P1：Windows 安装器在临时解压阶段超时

**现状与证据**

- `dist/win-unpacked/resources/app.asar` 约 `1.07 GB`，`app.asar.unpacked` 约 `1.93 GB`；其中 `.mastra/output/node_modules` 约 `0.80 GB`、`resources/browsers` 约 `0.69 GB`、未打包 `node_modules` 约 `0.44 GB`。
- `dist/win-unpacked/resources/app.asar.unpacked/.mastra/output/node_modules` 有约 `32,455` 个文件；整个 unpacked 目录约 `36,576` 个文件。
- 安装 `dist/mastra-desktop-0.0.1-setup.exe` 时，NSIS 进程运行约 `10.6` 分钟仍响应；`%TEMP%\\nssBC21.tmp` 达到约 `7.14 GB`、约 `209,130` 个文件，安装目标仍为 `0` 个文件，随后按阈值终止。
- 历史失败产物使用过宽的 `asarUnpack: resources/**`，并把部署树、浏览器运行时和大量小文件都交给 NSIS 处理；当前配置已将解包范围收敛为 `resources/browsers/**` 与 `resources/builtin-skills/**`，同时排除 `.mastra/output/node_modules/**` 的重复部署树。
- 本轮第一处体积修复只消除确定的图标重复，主要浏览器/native/runtime 体积仍未改变；因此当前证据仍支持“上游既有打包结构过大，本轮真实安装暴露问题”，而不是图标、CI 或上传修复直接造成。
- `setup.exe` 最后修改时间为 `2026-09-18 20:34:45`，而最新 `.nsis.7z` 为 `2026-09-19 13:03:08`；本地构建没有产物新鲜度检查，存在拿旧 setup.exe 做验收的风险。

**原因解释**

源码构建成功只证明 Vite/Mastra/Electron 输出能生成；electron-builder 还会把运行时依赖、Mastra deploy 输出和浏览器资源一起封装。NSIS 安装时先把压缩包完整展开到 Temp，再复制到目标目录，所以磁盘峰值和文件数远高于最终安装目录。历史产物中的 `.mastra/output/node_modules` 与应用包内依赖形成明显重复；当前已排除该目录，但浏览器/native runtime 和跨平台 optional 依赖仍会增加体积与小文件数量。

**状态**：安装器超时和产物时间线已真实记录；桌面端直接启动、安装后启动和精简后的体积仍待验证。

### I-07 — P2：依赖安装允许过宽的构建脚本和零年龄保护

**现状与证据**

- `pnpm-workspace.yaml:2` 设置 `dangerouslyAllowAllBuilds: true`，`:6-13` 又对白名单放行多个原生/网络相关包的构建脚本。
- `pnpm-workspace.yaml:14-15` 将 `minimumReleaseAge` 设为 `0`。
- 发布 CI 还在 `.github/workflows/release.yml:57-62` 通过环境变量启用 `dangerously_allow_all_builds`。

**影响与建议**

这可能是为了让 Mastra deploy 和原生依赖构建成功，但会扩大安装阶段执行任意生命周期脚本的供应链影响面，并放弃新包缓冲窗口。保留最小、逐包的 `allowBuilds`，移除全局允许；对必须执行的包固定来源和版本，恢复非零发布年龄或在 CI 中使用经过审核的内部缓存，并在依赖升级时复审放行名单。

**状态**：配置事实已确认；具体恶意包/受污染 registry 的攻击路径待威胁模型和供应链扫描验证。

### I-08 — P2：每次 dev/start/build 都依赖 Chromium 下载检查

**现状与证据**

- `package.json:21-27` 的 `start`、`dev`、`build` 以及三个平台打包脚本都间接调用 `scripts/install-browser.mjs`。
- `scripts/install-browser.mjs:18-25` 每次执行 Playwright `install chromium`；`:48-58` 先访问镜像，失败后再访问官方源。
- README 也明确说明 `pnpm dev` 启动前会确保 bundled Chromium（`README.md:42-50`）。

**影响与建议**

即使浏览器已经存在，启动仍会执行安装命令，可能经过外部 CDN/代理检查或下载；离线、镜像变更、代理配置错误可能让开发启动和打包失败。给下载器增加已安装版本检测、显式 `--skip-browser-install`、可配置缓存位置和 CI 缓存命中日志；把首次下载与日常启动分开。

**状态**：调用链已确认；重复执行是否真的产生网络流量、不同平台失败行为待实机验证。

### I-09 — P2：Workspace 实例缓存无容量或空闲淘汰

**现状与证据**

- `src/mastra/workspace/index.ts:369-389` 为每个 resource scope 持有永久 `runtimeByScope`，每个 runtime 有一个 `cache: Map<string, Workspace>`。
- `src/mastra/workspace/index.ts:445-524` 以 workspace path、threadId、resourceId 组成 key；命中后永久返回并写回 Map。
- `src/mastra/workspace/index.ts:532-562` 只有删除线程或相关配置变更才销毁实例；未看到容量上限、LRU 或空闲 TTL。

**影响与建议**

长期创建线程、切换用户或启用 BM25/LSP 时，内存中的 Workspace、索引和子进程可能随历史规模增长。先补 runtime 指标（cache size、workspace destroy、LSP client 数），再根据真实使用量设置空闲淘汰；淘汰前必须调用 `destroy()`，不能只删 Map 条目。

**状态**：无界 Map 事实已确认；实例实际占用和是否持有外部子进程待长会话压测。

### I-10 — P2：本地服务 CORS 范围大于内部调用需要

**现状与证据**

`src/mastra/index.ts:149-163` 为服务配置 `cors.origin: "*"`、`allowMethods: ["*"]`、`allowHeaders: ["*"]`。服务由 main 进程启动在 localhost，renderer 的客户端地址固定为 `http://localhost:4111`（`src/renderer/src/shared/api/client.ts:4-12`）。

**影响与建议**

桌面端内部只需要允许受信 renderer 来源和必要方法/请求头；通配 CORS 会让任意本地网页更容易探测或调用服务接口，扩大 CSRF/本地恶意页面的分析面。收紧到开发/生产两套明确 origin，并配合认证、`Origin`/`Host` 检查和定点跨源测试。不要把“只监听 localhost”当成完整访问控制。

**状态**：配置事实已确认；是否能结合当前 token/cookie 设计形成实际越权路径待威胁模型验证。

### I-11 — P2：Node 版本要求没有机器可执行的约束

**现状与证据**

- README 要求 Node.js 22 或更新版本（`README.md:37-40`）。
- `package.json:16` 只声明 pnpm packageManager，没有 `engines.node`；源码和工作流因此无法在安装前统一阻止旧 Node。
- CI 明确使用 Node 22（`.github/workflows/release.yml:75-79`），但本地环境没有同等门禁。

**影响与建议**

不同 Node 版本可能在原生依赖、Electron、TypeScript 或 `node:` API 处产生延迟失败。加入 `engines.node`，补 `.nvmrc`/mise/asdf 之一，并在 `pnpm install` 或 CI 先输出版本检查；README 保留人读说明。

**状态**：约束缺失已确认；各受支持 Node 版本的实际兼容矩阵待验证。

### I-12 — P2：大文件读取与媒体上下文整体驻留内存

**现状与证据**

- `src/mastra/rag/storage/assets.ts:210-228` 的 `readAssetBytes` 使用 `readFile` 把整个资产读成 buffer。
- `src/mastra/rag/storage/assets.ts:299-316` 对图片、音频和视频再把完整 bytes 转成 base64 `data:` URL。
- 单文件上限为 50 MB（`src/mastra/rag/types.ts:33-39`）。
- 下载接口也用 `Buffer.from(result.bytes)` 返回完整内容（`src/mastra/routes/library.ts:358-369`）。

**影响与建议**

多个并发预览或把媒体作为上下文时，单个文件会有二进制、base64 和响应缓冲的叠加峰值；base64 还会增加约三分之一体积。改为文件流/Range、限制同时读取数量，并给 Agent 上下文设置明确媒体字节预算。大文件路径需要运行时内存采样而不是只看类型检查。

**状态**：读取方式和上限已确认；真实峰值、GC 延迟和 UI 预览行为待运行验证。

### I-13 — P3：lint 命令包含全仓库写操作

**现状与证据**

`package.json:17-20` 将 `lint` 定义为 `biome check --write .`，而 README 将它列为贡献者在提交前运行的检查（`README.md:63-69`、`:97`）。

**影响与建议**

执行一个通常被理解为只读质量检查的命令，会自动改动源码、文档和配置，且可能把无关格式变化混入 PR。拆分为只读 `lint:check` 与明确的 `format`/`lint:fix`；CI 只能调用只读检查，开发者手动选择修复命令。

**状态**：命令语义已确认；实际会改动的文件范围可用一次临时副本运行验证。

### I-14 — P3：许可证审计不可由干净 checkout 重复

**现状与证据**

- `THIRD-PARTY-NOTICES.md:5-7` 声称审计脚本在 `.vscode/aic/_txt/`，并以该脚本作为依赖许可证扫描依据。
- `.gitignore:7` 忽略整个 `.vscode`，因此这些脚本不在默认版本控制范围内。

**影响与建议**

许可证结果、直接依赖映射和“无强 copyleft”声明无法由其他贡献者在干净 clone 中复核，依赖升级后也容易产生文档漂移。把最小审计脚本移到受版本控制的 `scripts/license-audit/`，锁定输出格式，在 CI 里检查 lockfile 与 notices 的差异；若脚本含本机工具痕迹，先清理路径和环境依赖。

**状态**：文档路径和忽略规则已确认；审计脚本是否存在于未跟踪本机目录、能否无状态运行待补可复现性验证。

### I-15 — P3：关键模块体积使回归面持续扩大

**现状与证据**

只读文件盘点显示：`src/main/index.ts` 约 50 KB、`src/mastra/routes/chat.ts` 约 43 KB、`src/renderer/src/widgets/chat-panel/ui/chat-panel.tsx` 约 77 KB、`src/renderer/src/pages/skills/ui/skill-hub-page.tsx` 约 110 KB；当前代码没有测试脚本为这些高变更模块提供局部安全网（`package.json:17-27`）。这些数值来自本轮 `Get-ChildItem src -Recurse -File | Sort-Object Length -Descending` 命令结果。

**影响与建议**

大文件本身不是缺陷，但当进程生命周期、路由编排、状态变换和 UI 交互持续叠加在同一文件时，评审难以定位不变量，局部修改容易影响不相干路径。按已有领域边界提炼 cohesive 模块（不是机械拆小文件），并先为关键状态转换补测试/调用图。

**状态**：文件规模已确认；耦合度和单次变更回归概率需要结合依赖图与真实缺陷记录验证。

## 4. 建议处理顺序

1. **先挡发布**：处理 I-01，清理 `ee/` 使用并重新做依赖/安装包许可证扫描。
2. **补 CI 信号**：处理 I-02 和 I-06，给普通源码 PR 增加轻量检查，发布前增加平台安装后 smoke。
3. **止住资源风险**：处理 I-03、I-04、I-09、I-12，优先用流式处理、过期清理、容量/并发上限和运行指标。
4. **收紧边界**：评审 I-05、I-07、I-10 的威胁模型，最小化 sandbox、CORS 和依赖构建脚本权限。
5. **降低维护成本**：处理 I-08、I-11、I-13、I-14、I-15，保证启动/环境/审计/命令语义可复现。

本清单不把“静态源码审查通过”当作用户路径通过。任何标记 `待验证` 的条目，在修复或发布前都应补上对应的运行、CI、安装或安全测试证据，并更新本文件中的状态和行号。

导航：[项目审查索引](README.md) · [审查方法](04-review-method.md)
