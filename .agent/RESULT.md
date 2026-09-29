# v0.0.5 候选改动与验证记录

日期：2026-09-29
代码基线：`main` / `origin/main` `fdbf9a9`（`v0.0.4`）。

## 候选改动

- Mastra Agent 的浏览器命令由 Electron 主进程按 `(resourceId, threadId)` 路由至当前可见原生 `WebContentsView`；使用本机 token 鉴权 broker，限制请求/响应大小，并对不可见/缺失会话 fail-closed。
- 页面操作、标签切换、导航和隐藏按 session 串行化；snapshot refs 与文档/标签生命周期绑定；每条命令有 deadline，超时会使旧 generation/refs 失效；拖放使用 Chromium 原生 drag interception，不能完成时不报告成功。
- 动态工具集只对绑定线程注册浏览器工具；Plan/Review 权限边界保留。
- 不改变用户浏览器的搜索引擎、登录 profile 或产品语义；本候选不宣称完整 Chrome 或 Codex 等价。

## 本机自动验证（Node 24）

- `pnpm run test:electron-browser-target`：通过。
- `pnpm run test:electron-browser-target` 的真实 Electron fixture 还验证了：文档导航发生在点击/拖拽坐标读取后会阻止后续鼠标按下；排队等待已耗尽 deadline 的脚本不运行；第 101 个标签返回 `tab_limit_reached`。
- `pnpm run test:regression`：106/106 通过（100 + 6），含 Electron broker 生产启动/环境变量接线静态门禁。
- `pnpm run lint`：通过（410 files）。
- `pnpm run typecheck`：三套配置通过。
- `pnpm run verify:release`：通过。
- `git diff --check`：通过。
- Fresh review 的 release ancestry、排队 deadline、导航期间 click/drag 竞态与 tab-count findings 已按真实运行测试修复；对主进程创建、启动、spawn 环境变量和关闭 broker 加了源码回归门禁。最终 follow-up 只读复核正在进行。
- 当前工作区有本机 Mastra 开发服务占用 `localhost:4111`；为避免清理/覆盖正在服务的构建输出，本轮未在此工作区强行运行完整 `pnpm run build`。Node 22 PR CI 和 tag package 是构建发布门禁。
- 本机验证不等于 Node 22 CI、tag package、任意网站桌面 E2E 或性能验收；这些均需分别取得证据。

## 发布记录状态

PR 尚未创建；PR CI、合并、`v0.0.5` tag 和 GitHub Release 资产均未完成。不得将本文件中的候选验证描述成已发布验收。
