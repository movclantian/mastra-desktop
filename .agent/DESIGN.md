# 工程问题修复设计

## G0 语义边界

- **Product Core:** 桌面开发工作台内提供可直接使用的网页浏览，并允许 Agent 在受控范围内协助当前页面。
- **Primary User:** 在 Mastra Desktop 里查看、调试网页并需要 Agent 辅助的开发者。
- **Role Ownership:** Electron `WebContentsView` 是用户所见页面的事实源；Mastra 持有 Agent/线程上下文；用户决定导航并保留最终控制权；Agent 只能通过线程绑定的浏览器目标进行操作。
- **Non-goals:** 不重做完整 Chrome/Edge，不把 Bing 当首页或 Agent 专属浏览器，不在本轮宣称或实现按线程隔离 cookies/site storage。
- **Forbidden Claims:** 未做同机基准前不声称性能等同 Codex；未完成真实 Electron 交互前不声称无闪烁/无延迟；URL 相同不能单独证明 Agent 与用户共享同一页面。

## 当前设计：上游对齐与浏览器变更集成

- **基线:** 以已 fetch 的 `origin/main` `0afc3b51d913164f1a43dee7d7206d8ce9a3e94d` 为唯一集成起点。功能分支在上游 `b18ab3d` 的源树已一致；不重复搬运已合入的 transfer-recovery 代码。
- **产品语义:** 新标签为 `about:blank`；地址栏支持直接网址和普通搜索词，搜索服务为用户可配置项（当前用户选择 Bing 为默认搜索服务，不代表首页）；用户与 Agent 的目标是同一线程当前可见原生页面。
- **实现边界:** 主进程管理原生页面及生命周期，renderer 只通过 preload/IPC 操作 UI，Mastra 继续负责 Agent 请求身份和浏览器工具；SSE/JPEG 仅在确认仍有消费者后作为兼容路径保留。
- **已知边界:** Electron default session 的 cookies/site storage 仍是应用级共享；loopback CDP 旁路风险按 Owner 最新决定列为已知、当前非阻塞项，不在本批扩成 transport 重写。
- **保护:** 原始脏工作区保留不动；仅迁移与本批目标直接相关且经 diff 审核的源码/测试。临时截图、研究缓存及无法解释的文件不自动进入交付。
- **完成声明:** 类型/定向回归/完整回归/构建与隔离 Electron 运行态分别报告；未获得性能测量和 Owner 手工体验前，不宣称达到 Codex 性能或完整浏览器等价。

## Goal

按已确认问题清单优先修复许可证边界、CI 信号、上传临时数据、Electron 隔离和资源控制；低风险维护项一并收敛。

## Key decisions

1. 内置技能不再读取 `@mastra/editor/ee`，改为仓库自有 `resources/builtin-skills` 空目录，保留市场/用户技能能力。
2. 上传过期清理采用“启动时清理 + 创建新会话时清理”的惰性方案，避免常驻定时器；只清理 `expires_at` 已过期且未完成的临时会话。
3. 分片合并改为按顺序写入临时合并文件，再交给既有资产入口；本轮不改变资产数据库 schema。
4. Electron sandbox/CORS 只收紧默认边界；若现有运行路径依赖旧行为，保留明确的待验证状态，不添加兼容回退。
5. 验证遵守 `AGENT.md`：只做静态检查和差异检查，不启动应用、测试或构建。

6. 上传入口优先传递文件路径而不是完整 Buffer；只有文档抽取确实需要时才读一次文件，媒体上下文超过 8 MB 时不生成 data URL。
7. 发布前门禁检查图标资源、内置技能路径和 Enterprise 排除规则；安装后 smoke 只记录为手动验收，不在本轮自动执行。

## Acceptance

- `@mastra/editor/ee` 不再出现在运行时技能源路径或打包资源中。
- CI 对 `src/**` 的 PR 变更有回归信号；发布流程仍只在 tag 上创建 Release。
- 过期上传记录和 chunk 目录可从源码调用链清理；合并过程不再同时保留所有 chunk 与完整 merged buffer；资产后处理失败不遗留已复制文件。
- Electron 默认 sandbox、localhost CORS、依赖构建脚本和 Node 版本约束有明确变更。
- 关键改动均有静态 diff、路径/行号和配置一致性证据；未声称真实运行通过。
- 侧栏、登录品牌区和 favicon 使用同一 renderer 图标资源；50 MB 上传完成路径不再同时保留所有分片和完整合并 Buffer。
