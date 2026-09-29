# 发布候选当前状态

更新时间：2026-09-29

## 基线

- 仓库：`movclantian/mastra-desktop`
- 集成基线：`main` 与 `origin/main` 同为 `fdbf9a9`；最新已发布 tag 为 `v0.0.4`。
- 当前候选包含 Electron 原生浏览器 Agent 命令通道、线程工具注册修复、输入/拖放/标签操作及对应的回归 fixture；PR #11 已创建，首轮 CI 的 Linux Electron fixture sandbox 启动问题已本地修复，等待提交和 CI 重跑。

## 已有证据

- `pnpm run test:electron-browser-target`：通过，真实 Electron `WebContentsView` fixture 覆盖 AgentBrowser tools、本机鉴权 broker、可见页面、标签切换竞态、点击/拖拽导航竞态、排队命令截止时间、第 101 个标签拒绝、stale refs、线程隔离和 fail-closed。
- `pnpm run test:regression`：通过，第一组 100 项、第二组 6 项。
- `pnpm run typecheck`：node/web/mastra 三套 TypeScript 检查通过。
- `pnpm run lint`：通过，410 个文件。
- `pnpm run verify:release`：通过。
- `git diff --check`：通过。
- PR release workflow 已加上 Xvfb 下的 `test:electron-browser-target`。首轮 Node 22 CI 发现 Linux runner 缺少 Chromium SUID sandbox 权限；已仅对测试 Electron 进程追加 Linux `--no-sandbox`，本机 Electron fixture 和该文件 lint 通过，CI 重跑待提交触发。
- 上述本机验证运行于 Node 24，不能替代 Node 22 PR CI。

## 尚未通过的门禁 / 限制

- 候选版本 `package.json` 已是 `0.0.5`；当前在 `release/v0.0.5-browser-agent`，PR #11 已创建；PR CI 修复提交待推送/重跑。PR CI 通过并合入 main 后才可创建 `v0.0.5`。
- Fresh review 提出的发布 tag ancestry、排队 deadline、导航期间旧坐标点击/拖拽、100 标签契约及生产 broker 接线覆盖均已修复并加回归；最终只读 follow-up 未发现剩余可操作的 P1/P2。未审计 GitHub branch protection 设置。
- 完整本地 package build 未运行：`localhost:4111` 有开发服务占用，构建脚本拒绝覆盖其正在使用的输出。PR CI/tag workflow 在干净 runner 上执行构建。
- tag workflow 尚未产出并核验多平台安装包。
- 已知 AgentBrowser 参数差异：`snapshot.maxDepth`、`screenshot.fullPage`、`type.delay` 和各操作的 `waitUntil` 语义尚未完全对齐；外部网站登录态、任意页面交互和与 Codex 的同机性能/闪烁对比未作为本轮已验收事实。
- 根目录 `DESIGN.md` 是视觉规范并继续保留；Mastra vendored `docs/` 不做清理。
