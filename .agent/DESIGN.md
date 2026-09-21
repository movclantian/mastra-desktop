# 工程问题修复设计

## G0 语义边界

- **Product Core:** 本地优先的 AI 工作台，在桌面端安全地运行 Agent、工作区和知识库能力。
- **Primary User:** 在本机使用 Mastra Desktop 进行 Agent 对话、代码工作区操作和资料管理的开发者。
- **Role Ownership:** Electron 主进程负责宿主权限；Mastra 子进程负责服务、Agent 和数据访问；renderer 只通过受约束的 API 交互；数据库和文件系统是本地事实源。
- **Non-goals:** 本轮不重做 UI、不更换 Agent/存储框架；只把用户确认的品牌图标接入现有品牌位，不把未验证的运行结果包装成已验收。
- **Forbidden Claims:** 不能把静态检查称为安装后可用；不能把依赖存在称为已获许可证；不能把 CORS/sandbox 配置本身称为已完成安全认证。

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
