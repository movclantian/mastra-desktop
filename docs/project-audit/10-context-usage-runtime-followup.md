# 上下文用量与桌面验证跟进（2026-09-20）

## 当前结论

保留现有工具、技能、上传与浏览器能力；本轮不做安装包瘦身、重新打包、安装或推送。
真实 Electron 开发实例与 Mastra 服务已启动。用户本轮提供的账号登录一次后返回“邮箱或密码错误”，已清空密码输入框，等待确认邮箱或自行登录。凭据不写入报告。
登录后的真实会话、Provider、上传和完整工具链路尚未验收。

## 修改

- session 从 SDK 的 finish-step 取最后请求用量，保留 finish.totalUsage 作为本轮累计用量。
- 元数据增加 contextUsageVersion: 2、单次 contextUsage，线程另存累计 totalUsage。不变更数据库结构。
- 上下文水位与附件预算不再使用多步累计 token。旧记录没有单次快照时显示未知。
- 费用估算继续使用累计用量；未知用量显示“—”，不以最后一步代替累计，不把缺失字段当零。

## 证据与边界

- 三套 TypeScript 检查通过；test:regression 24 项通过；verify:release 源码门禁通过。
- 新增真实 toAISdkStream 适配器测试（最后请求 1200 与累计 2000 分离）、跨运行重置测试、mock 存储的兼容测试。
- fresh reviewer 对上下文组件真实渲染的8个场景通过：已知值、上下文未知、全部未知、真实零、负数、NaN、Infinity、缺少输出量。主线程已查看 context-usage-review.png，确认未知显示与累计费用保留；这是无完整应用样式的隔离组件截图，不是应用整体布局或登录后验收。
- 独立 React/Chromium StrictMode 探针：MessageItem/MessageScroller、AssistantTrace、CodeComparison、PromptInputProvider，120 工具步骤、60 次更新，未复现 maximum update depth。探针见 .agent/runtime-evidence/react-depth-probe.*。
- 未复现不代表崩溃已修复；尚缺原始会话完整 Workbench 状态、SSE 时序和组件堆栈。
- 当前 Node 24.19 / pnpm 11.19 不符合声明的 Node 22 / pnpm 12，标准环境仍须复验。
- 之前安装包不包含本轮修改，不作为本轮验收产物。

## 下一步

1. 确认可登录账号，在新会话中逐组测工具，捕获 renderer 错误/组件栈和流事件；不做全量长回合盲测，不改历史会话。
2. 实测上下文、费用、附件预算和刷新恢复，区分开发实例与安装包结果。
3. 定位 React 更新循环，测交互延迟和内存；没有证据不宣称卡顿消除。
4. 继续处理 .ps1 搜索、Windows 编码、工具失败状态；安全专项与包体收敛暂停。
5. 定点回归与真实桌面验收完成后再考虑安装包；不强推。
