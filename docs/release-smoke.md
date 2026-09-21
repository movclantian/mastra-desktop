# 发布包安装后 Smoke 验收

这份清单用于发布前手动验收，不由本地开发循环自动启动安装器或应用。

## 1. 构建身份

- 确认 tag 与 package.json.version 一致，例如 v0.0.1 ↔ 0.0.1。
- 打包前运行 `pnpm run clean:package`，避免旧的 setup/blockmap 被误当成当前构建产物。
- 在上传前运行 `pnpm run verify:package`，确认安装包、blockmap、未安装目录可执行文件和构建时间线属于同一份产物。
- 仅做目录包启动验证时运行 `pnpm run verify:package:dir`，确认 `app.asar`、Mastra 入口和 Chromium 可执行文件存在；目录包模式不能替代安装包门禁。
- 记录安装包 SHA-256、目标平台、构建提交和构建时间。2026-09-19 修复版 Windows setup：`656.33 MB`，SHA-256 `A1A6DD9CABFE513C81C128A5211FEB2787AECA92095DFB549F0D4B5D22A8A3A5`。
- 确认桌面快捷方式、安装器和窗口标题使用新的品牌图标。

## 2. 安装

- Windows：安装到新的临时目录，确认 NSIS 完成且没有残留安装进程。
- macOS：挂载 DMG，将应用复制到新的测试目录，不覆盖旧版本。
- Linux：至少验证 AppImage 可执行；需要时再验证 deb/snap 安装。
- 安装完成后记录最终安装目录大小和临时目录是否清理。

### Windows packaged smoke 前置条件

目录包和开发态实例不能并行验证：应用使用单实例锁，Mastra 固定监听 `localhost:4111`，开发态 Vite 通常占用 `5173`。开始 packaged smoke 前必须先记录并确认：

- Git commit、目录包 EXE 的 SHA-256、版本、大小和修改时间；
- `5173`、`4111` 的监听 PID 及命令行；
- 所有项目 Electron、Vite、Mastra 子进程；
- 默认 userData 下是否存在单实例锁。

如果开发态进程仍在运行，只能停止已确认属于本项目的进程树；不要按端口无条件杀进程。停止后确认 `5173`、`4111` 均释放，再使用隔离 userData 启动目录包：

```text
dist\\win-unpacked\\mastra-desktop.exe --user-data-dir=D:\\temp\\mastrawork-packaged-smoke
```

启动通过必须同时满足：窗口标题为 `MastraWork` 且存在有效窗口句柄；Mastra 子进程命令行来自目录包 `resources\\app.asar\\.mastra\\output\\index.mjs`（安装后也必须来自 `resources\\app.asar\\.mastra\\output\\index.mjs`，不能从 `app.asar.unpacked` 启动）；`4111` 的监听 PID 属于该进程树；`/health` 返回 200。单独的 `/health` 200 不足以证明目录包启动成功。

退出后最多等待 30 秒，确认 Electron 主进程、Mastra 子进程和 credential-broker 均退出，`4111` 释放，再清理测试 userData。

## 3. 启动与退出

- 首次启动能显示登录页，renderer 控制台没有 CSP、preload 或资源加载错误。
- 登录后 Mastra 服务健康检查成功，端口退出后不残留。
- 关闭窗口后重新启动，数据目录和窗口状态仍可正常读取。
- 再次退出时确认没有残留 Electron/Mastra/credential-broker 进程。

## 4. 关键用户路径

- 新建线程并发送一条消息。
- 创建/切换 workspace，打开文件和终端。
- 上传一个小文本文件并检索。
- 上传一个接近上限的分片文件，确认合并成功或失败时临时目录可清理。
- 上传超过 8 MB 的图片/音频，确认会显示“超过上下文上限”，不会把文件转成超大 data URL。

## 5. 安全与发布边界

- renderer 只能加载可信本地页面；外部链接通过系统浏览器打开。
- 未授权 origin 不能调用本地 Mastra API。
- 构建产物中不应包含 @mastra/editor 的 ee/ 内容。
- CI 的 Release 只由 v*.*.* tag push 创建。

验收结果要记录为 PASS、FAIL 或 BLOCKED，并附平台、构建提交和日志路径；未执行的项目不要标成 PASS。

## 6. 2026-09-19 Windows 修复版记录

- 首轮安装后启动 FAIL：Mastra 从 `app.asar.unpacked\\.mastra\\output\\index.mjs` 启动，报 `ERR_MODULE_NOT_FOUND: @mastra/core`；同时发现 sandbox preload 外部依赖未 bundle，`resources/icon.png` 未显式纳入包体。
- 修复：Mastra 入口改在 `app.asar` 内运行；preload 单文件 bundle；显式打包 `resources/icon.png`；排除 `.mastra/output/node_modules`。
- 修复版安装 PASS：安装到 `C:\Users\chenfeng\AppData\Local\Programs\mastra-desktop-0.0.1-smoke-20260919-fix`，窗口标题 `MastraWork`，4111 `/health` 返回 200，关闭后 Electron、Mastra 和端口均退出。
- 安装器解压未超过 10 分钟阈值；安装目录约 2.02 GB。完整核心用户路径、跨平台和签名验收仍待后续进行。
