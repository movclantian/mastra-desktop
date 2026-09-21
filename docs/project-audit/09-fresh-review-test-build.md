# Fresh review 与 Windows 测试包

日期：2026-09-20。状态：构建完成；未安装、未启动该产物验收。

## 本轮修复

上传过期维护从建表/创建会话的阻塞等待改为后台维护，单飞并在成功或失败后节流5分钟；未改变过期判定或删除目标。新增并发、成功/失败节流回归。该修改减少请求等待与重复清理，不声称解决React渲染循环。

包中同时包含上一批媒体50MB读取边界恢复、资料库视频读取恢复、两项原创技能、chunker默认参数、短写及Provider探针指令修复。

## 独立审查

fresh agent `fresh_release_review` 不继承主线程对话，以HEAD/工作区差异和测试独立核查。

- 源码：媒体、chunker、上传/后台维护、任务流、消息投影、Mastra入口/preload未发现阻止生成测试包的明确问题。
- 独立运行21项定向回归通过。本线程三套TypeScript检查、源码资源检查亦通过。
- 归档：package main为`./out/main/index.js`；main/preload/Mastra入口/renderer HTML与本次输出逐字节一致。
- preload外部require仅electron；两个新技能和图标与源文件一致；技能按配置unpacked。
- ASAR路径清单未发现`@mastra/editor/ee`、`@mastra/editor/dist/ee`、重复`.mastra/output/node_modules`。这是路径/资源扫描，不是完整法律意见或所有第三方许可证审计。
- 没有确认Maximum update depth的根因，review通过不等于桌面实测通过。

## 构建与身份

- HEAD：`90312644ff0af8d938552207345a416c88f2db9f`，含未提交工作区修改。
- 源码集合指纹：`945fa1457ab901357cfc051362efe917d5270e67b90f03f8799b36e9de1f4670`；397文件，覆盖git列出的src/scripts/resources/build/workflow及package/lock/workspace/Electron/tsconfig配置，排序后按路径+NUL+字节SHA256；不含文档/运行数据。
- 本机Node24.19/pnpm11.19，与项目声明Node22/pnpm12不同；不能声称标准CI环境通过。
- 分阶段执行：browser资源检查（复用已有Chromium）、Mastra build、electron-vite build、electron-builder --win；全部退出0。
- 打包输出到`dist-review-20260920-1259`，没有覆盖旧dist安装包，没有删除用户数据。
- 此前项目开发实例已停止，避免并发改写输出；没有自动启动新产物。
- 保留警告：package-lock生成失败提示、无效动态import、util浏览器外置、重复依赖和部分可选依赖解析警告。未据此宣称运行无问题。

## 产物

- 文件：`dist-review-20260920-1259/mastra-desktop-0.0.1-setup.exe`
- 精确大小：687587464字节（655.73MiB）。
- SHA256：`8FAF72480B7A55C52176B6F68E601C7BA101EE5CBF462DF11813E5B2D3757EA8`
- Authenticode：NotSigned；日志的signtool步骤不代表已取得有效签名。
- --dir与release两种产物检查均通过，包括资源、blockmap和时间一致性。

## 使用验收与遗留

这是用于继续验证的0.0.1测试包，不是正式发布。用户安装时应先关闭旧Mastra实例，核实选择本目录的新EXE；若解压超过10分钟，按之前约定停止并记录日志，不连续重试堆积临时文件。

优先验证设置页、模型连接、短聊天/停止、少量工具、分片上传及新技能目录。React卡顿/循环、累计token统计、grep .ps1与Windows乱码仍待修复。未做安装/启动/性能验收，无提交、无推送、无tag或Release发布。
