# v0.0.5 发布计划

日期：2026-09-29
状态：review 提出的阻断风险已修并完成本机自动验证；等待单一 reviewer 最终复核，之后创建 PR，按 Node 22 CI 门禁合并和发布。

## 目标与范围

- 基于 `origin/main` / `fdbf9a9`（当前 `v0.0.4`）交付浏览器自动化修复：Mastra `browser_*` 命令通过本机鉴权 broker 到达当前线程可见的 Electron `WebContentsView`，不再依赖 Agent 侧 CDP 页面发现和私有页面映射。
- 保留地址栏、用户浏览器和现有 Mastra 工具接口；本批不宣称与 Codex 性能或全部浏览器参数等价。
- 清理过时工程笔记和错误工程规则；保留根目录视觉规范、发布 smoke 手册及有日期/来源的历史测量记录。
- 将应用版本提升到 `0.0.5`，最终创建 `v0.0.5` tag；发布包由 tag Release workflow 构建。

## 发布门禁

1. 已完成：逐项检查 Electron broker、会话身份、命令 deadline/超时失效、可见页面限制、工具参数语义和 Electron 回归 fixture；已修 review 发现的阻断问题。
2. 已完成：浏览器 Electron fixture、完整回归（106 项）、三套 typecheck、lint、`verify:release` 与 `git diff --check`。
3. 进行中：单一 reviewer 对最终修订只读复核；随后创建发布分支和 PR。只有 required checks 全绿、review 无未解决阻断项才合并至 `main`。
4. 合并完成且 `package.json` 为 `0.0.5` 后创建 `v0.0.5`；等待 tag 触发的 Windows/macOS/Linux package 与 GitHub Release workflow 全部成功，再核验发布资产。

## 停止条件与已知边界

- 任一必需测试/CI 失败、版本/tag 不一致、或出现未解决 P1/P2 review finding 时停止合并和打 tag。
- 当前 `@mastra/agent-browser` 公开 schema 中 `snapshot.maxDepth`、`screenshot.fullPage`、`type.delay` 和 `waitUntil` 参数的原生实现语义尚未完全对齐；必须在 PR 说明中明确，不能宣称所有参数完全兼容。
- 本机是 Node 24，而项目与 CI 声明 Node 22；本地结果不替代 PR Node 22 CI 和 tag package 验证。
- Release workflow 在 tag 构建时核验 tag commit 已是 `main` 祖先；PR job 增加 Xvfb Electron fixture，tag 仍须在 merge 后创建。
- 隔离 Electron fixture 和 Codex 当前附着 browser target 的 smoke 不能替代 Mastra 登录态网站的真实桌面体验或性能对照。
