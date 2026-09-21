# 第一次推送复核：上游差异、成果归类与数据证据

日期：2026-09-21  
目标：为第一次 PR/推送准备一份可审查的成果清单。本文不执行远端推送，也不替代真实桌面验收。

## 1. 代码身份与范围

| 项目 | 结果 |
| --- | --- |
| 上游基线 | `origin/main@90312644ff0af8d938552207345a416c88f2db9f` |
| 当前分支 | `codex/freeze-audited-results` |
| 基线差异 | 93 个文件，+5335 / -467 行 |
| 本地提交 | 12 个，已推送到功能分支 |
| 未跟踪内容 | `tests/shots/` 本地截图证据，不纳入第一次推送 |
| 远端动作 | 已推送功能分支并 fast-forward 合并到 `origin/main@fccc9ac`；未执行 force-push、未发布 Release |

当前提交顺序见 [`docs/push-overview.md`](../push-overview.md)。它是本次推送的交接入口，不表示远端已经接受这些提交。

## 2. 成果拆分

### A. 直接产品修复

这些改动针对已观察到的故障或上游行为缺口：

- `/settings` 不再在缺少 `SidebarProvider` 时调用 `useSidebar`，修复设置页崩溃路径。
- Mastra 重启时复位 stopping guard，避免重启后进程不能再次启动。
- Provider 使用 registry/custom base URL，测试保留真实 HTTP 状态；DeepSeek 思考模型补回 `reasoning_content`。
- 上传会话、20MB 分片上限、失败清理、短写处理和孤儿目录清理统一协议。
- Markdown 分块保留标题和 metadata；小 chunkSize 未显式传 overlap 时使用合法默认值。
- 后台流处理 408/429/5xx 重连、退避、EOF/异常 reader 释放和取消竞态。
- 工具消息按 `toolCallId` 合并最新快照，避免同一调用重复渲染。
- 长任务 UI 取消逐 SSE 事件刷新，改为 120ms 任务状态批处理、500ms 终态刷新，并保护终态不被旧快照覆盖。
- 任务详情在运行时展开，完成后折叠，降低长任务 DOM 和渲染压力。

### B. 工程与发布门禁

- 增加 `typecheck`、回归测试、源码发布检查和产物新鲜度检查。
- 增加工具完整性测试：grep 扩展名、Windows 编码、后台进程、上传短写、工具快照、上下文统计等。
- Release workflow 区分 PR 检查、tag 构建和 Release 发布；普通 PR 不再强制完整打包。
- Electron 入口、preload、CSP、sandbox、asar/asarUnpack 和图标资源统一。

### C. 审计与交接资料

- `docs/project-audit/01–11`：品味、设计原则、严重度、方法、上游对比、fresh review、第一次推送复核。
- `.agent/PLAN.md`、`.agent/CURRENT_STATE.md`、`.agent/RESULT.md`：计划、当前状态和证据索引。
- `docs/release-smoke.md`：安装后验收清单。

### D. 暂不纳入本次推送承诺

- 安装包继续瘦身。
- GitHub CI/Release 的真实云端运行。
- 真实桌面长任务的鼠标/滚动/流式定量验收。
- 安全专项和 force-push。

## 3. 与上游的归因

### 3.1 上游已有、我们修复的缺口

证据来自同一上游提交的源码对照、定点回归夹具和历史用户现场：

| 问题 | 上游表现 | 当前处理 | 证据状态 |
| --- | --- | --- | --- |
| `/settings` Provider 边界 | `useSidebar must be used within a SidebarProvider` | 设置页不再读取隐式 sidebar context | 源码调用树 + typecheck；真实桌面待验收 |
| Markdown 标题 | 标题可变成字面量 `#{1,6}`，metadata 丢失 | 显式解析标题后递归切分 | 当前回归通过 |
| 后台流恢复 | 临时 HTTP 错误、EOF/取消路径不完整 | 重连、退避、reader 释放、取消隔离 | 当前回归通过 |
| 工具快照 | 同一 `toolCallId` 的输入/输出重复展示 | 保留最新快照并稳定分组 | 当前回归通过 |
| 分片协议 | 会话上限与路由分片上限不一致 | 统一 20MB 协议 | 定点检查；真实大文件待验收 |
| Provider 诊断 | base URL 回退、错误被包装成笼统 400 | 保留 registry/custom URL 与上游状态码 | 定点检查；真实供应商请求待验收 |

### 3.2 我们主动引入的行为变化或风险

这些不能归咎上游，推送说明必须显式标注：

1. 内置技能从 EE 路径迁移到仓库自有资源；当前只提供自有技能，不等价于原 EE 技能全集。
2. 媒体上下文、Electron sandbox/CSP、asar 边界和上传清理都改变了运行边界，兼容性风险属于本次改动。
3. 新增的回归脚本和测试抽取器依赖当前源码结构；它们不是上游已有的独立测试套件。
4. 长任务渲染限频和快照合并是针对现场卡顿/任务停滞的新增策略，尚未完成真实桌面性能测量。

### 3.3 目前不能归因的现象

- `Maximum update depth exceeded` 的最终组件栈没有从用户桌面会话采集到，不能宣称已由某一处代码单独证明。
- `network error` 流中断需要服务端、renderer 和时间窗三方日志，当前只有局部流处理回归。
- Windows CP936/UTF-8 显示差异是环境和解码选择的交互问题，不能简单归因安装包瘦身。

## 4. 数据支撑

### 4.1 当前工作树的可复核数据

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm run typecheck` | PASS | Node `v24.19.0` / pnpm `11.19.0`；项目声明环境为 Node 22，存在 engine warning |
| `pnpm run test:regression` | **34/34 PASS** | 覆盖流恢复、取消、上传短写、Provider、chunker、工具投影、grep、Windows 编码 |
| `pnpm run verify:release` | PASS | 源码、图标和打包 guard 通过 |
| 当前 diff | 92 files / +5202 / -467 | 相对 `origin/main@9031264` |
| fresh-context review | 无新的 P1/P2 | 复核了 stale snapshot、分页缺失任务、sandbox 详情展开收口 |

### 4.2 上游 A/B 的证据边界（重要修正）

本轮实际尝试运行：

```powershell
pnpm exec node --test scripts/test-experience-regressions.mjs scripts/test-background-task-stream.mjs
$env:REGRESSION_BASELINE='90312644ff0af8d938552207345a416c88f2db9f'
pnpm exec node --test scripts/test-experience-regressions.mjs scripts/test-background-task-stream.mjs
Remove-Item Env:REGRESSION_BASELINE
```

当前版本运行结果为 16/16 PASS（完整套件为 34/34 PASS）。上游运行不能作为通过/失败的同口径数字，原因是：

- 上游提交没有 `scripts/test-experience-regressions.mjs` 和 `scripts/test-background-task-stream.mjs`；这些测试是本次新增成果。
- 将当前测试强行指向上游源码时，出现“baseline 缺少目标函数/旧流实现不满足当前 harness”的错误，不能解释为上游整体“7 项失败”。
- 因此旧报告中的“上游 2/14、当前 14/14”只能保留为历史定点观察，不能作为本次第一次推送的独立 A/B 验收结论。

### 4.3 包体与安装数据

历史安装证据显示：setup 约 655.73 MiB，安装目录约 2.02 GiB；主要体积来自 Chromium、Mastra/native runtime 和依赖树。该数据用于说明风险，不证明本次代码身份已经完成新包验收，因此安装包瘦身继续暂停。

## 5. 第一次推送判定

当前已经形成一个**已合并、可审查的主分支成果**，但还不是“完整发布通过”：

- 已完成：提交链、代码身份、回归门禁和审计资料已推送并进入 `origin/main`。
- 不能宣称：真实桌面长任务、云端 CI/Release、最新安装包启动和多 Provider 实请求已通过。
- 推送前必须由 Owner 决定是否接受 Node 22/pnpm 12 环境差异，并完成至少一次桌面手测。

建议第一次 PR 使用当前分支完整提交链，保留“不 force-push、不瘦身、不发布 Release”的边界；桌面手测失败时，以同一 code identity 追加修复提交，不改写基线。
