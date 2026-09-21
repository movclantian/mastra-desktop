# Windows 目录/安装包体积复核（2026-09-19）

## 范围

本次先执行清理后的 `electron-builder --dir`，再用同一份产物生成 NSIS 安装器并完成隔离目录安装 smoke。目的是验证发布边界调整、`!**/*.map` 排除规则和安装后真实运行路径，不把目录打包结果误报为安装验收通过。

命令：

```text
node scripts/clean-package-output.mjs
pnpm exec electron-builder --dir
```

结果：`electron-builder 26.15.3` 退出码 `0`；`pnpm run verify:package` 通过；修复版安装器安装/启动/退出 smoke 通过。

## 当前产物

目录：`dist/win-unpacked`

| 范围 | 文件数 | 体积 |
| --- | ---: | ---: |
| `win-unpacked` | 4,076 | 约 2.18 GB |
| `resources` | 4,005 | 约 1.82 GB |
| `resources/app.asar` | 1 | 约 708.61 MB |
| `resources/app.asar.unpacked` | 4,002 | 约 1.13 GB |
| source map | 0 | 0 |

`app.asar.unpacked` 的主要目录：

| 目录 | 文件数 | 体积 |
| --- | ---: | ---: |
| `resources/browsers` | 611 | 约 0.69 GB |
| `node_modules` | 3,390 | 约 0.44 GB |
| `.mastra/output` | 0 | 不再位于 `app.asar.unpacked`；入口位于 `app.asar\\.mastra\\output\\index.mjs` |

## 与安装现场的对照

此前失败的安装现场记录显示，旧 `win-unpacked` 的 `app.asar` 约 1.07 GB、`app.asar.unpacked` 约 1.93 GB，NSIS 临时解压约 7.5 GB 后超过 10 分钟仍未完成。

本次清理后目录打包约 2.18 GB，source map 已完全排除；setup.exe 约 656.33 MB，安装目录约 2.02 GB。与首轮失败包相比，不能把差值全部归因于单条排除规则：构建输入也发生过变化，因此仍需把“构建输入变化”和“打包排除”分开做后续对照。浏览器运行时和 unpacked native/runtime 依赖仍是主要体积来源。

## 运行验收边界

- `electron-builder --dir` 已完成。
- `pnpm run verify:package:dir` 已通过，确认目录包 EXE、`app.asar` 和 Chromium 可执行文件齐全。
- `pnpm run verify:package` 已通过，确认 setup/blockmap/目录包属于同一份新鲜产物。
- 修复版 setup.exe 约 656.33 MB，SHA-256 为 `A1A6DD9CABFE513C81C128A5211FEB2787AECA92095DFB549F0D4B5D22A8A3A5`。
- 修复版 NSIS 安装到 `C:\Users\chenfeng\AppData\Local\Programs\mastra-desktop-0.0.1-smoke-20260919-fix` 后，窗口标题为 `MastraWork`，4111 `/health` 返回 200，关闭后进程/端口均释放。
- 安装后 Mastra 命令行为 `resources\\app.asar\\.mastra\\output\\index.mjs`；静态检查确认 `resources\\icon.png` 和 bundled preload 依赖存在，`.mastra\\output\\node_modules` 不存在。
- 已停止确认属于项目的开发态进程树后，用隔离 userData 完成目录包 packaged smoke：窗口标题 `MastraWork`，4111 监听归属该进程树，`/health` 返回 200；关闭窗口后主进程、后端和端口均清理。
- 首轮安装包启动失败的历史证据为 `ERR_MODULE_NOT_FOUND: @mastra/core`，发生在 `app.asar.unpacked\\.mastra\\output\\index.mjs`；这不是修复版路径。
- 临时隐藏 `chromium_headless_shell-1243`、`ffmpeg-1011`、`winldd-1007` 后，Playwright headless 启动因缺少 headless shell 失败；恢复目录后同一 smoke 成功。因此 headless shell 当前不能作为安全删除项，ffmpeg/winldd 仍需按具体功能单独验证。

## 第一轮安全裁剪（待重建验收）

### 证据

- `electron-builder.yml` 原先使用 `asarUnpack: resources/**`。
- 现有目录包中 `app.asar/resources/icon.png` 与
  `app.asar.unpacked/resources/icon.png` 同时存在，图标约 0.7MB，被重复携带。
- `src/main/index.ts` 的 `?asset` 导入在构建产物中解析为
  `app.asar/resources/icon.png`；只有 `resources/browsers` 和
  `resources/builtin-skills` 通过 unpacked 文件系统路径被服务进程消费。

### 修复

`asarUnpack` 已收敛为：

```yaml
asarUnpack:
  - resources/browsers/**
  - resources/builtin-skills/**
  - 'node_modules/node-pty/**'
```

这只消除确定的图标重复，不改变浏览器、内置技能或 native 模块的运行时边界。

### 验收门槛

下一次干净目录构建后必须同时满足：

1. `app.asar/resources/icon.png` 存在。
2. `app.asar.unpacked/resources/icon.png` 不存在。
3. `app.asar.unpacked/resources/browsers` 和 `builtin-skills` 存在。
4. `pnpm run verify:package:dir` 通过后，再由用户执行窗口启动与浏览器能力 smoke。

这不是几百 MB 级别的解决方案；其余大头仍需产品决策后再做按需下载或功能拆分。
