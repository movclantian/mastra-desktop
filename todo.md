Workflow 主要就在“自定义 Agent / 团队 Agent”这条链路里使用，具体分两层：

  1. src/mastra/agents/custom.ts

  这里定义了自定义 Agent 的配置和团队配置：

  - AgentProfile
  - AgentWorkflowDefinition
  - 团队策略：
      - supervisor
      - handoff
      - workflow
      - council

  - 成员 Agent 注册和资源隔离
  - buildProfileWorkflow()：把团队配置转换成 Mastra 原生 Workflow

  其中：

  - supervisor 通过主 Agent 动态委派成员，不创建显式 Workflow。
  - handoff 按顺序调用成员。
  - council 并行调用多个成员，然后汇总。
  - workflow 使用显式 Workflow，支持分支、循环和人工审批。
  - approval 步骤也是在这里定义的 Workflow suspend/resume 节点。

  2. src/mastra/agents/index.ts

  这里把自定义团队生成的 Workflow 挂到 Agent 上：

  const workflowResult = await buildProfileWorkflow(profile, resourceScope);
  return workflowResult ? { teamWorkflow: workflowResult.workflow } : {};

  也就是说，团队配置保存后，运行时会动态生成一个名为 teamWorkflow 的 Workflow，并通过 Agent 的 workflows 能力暴露出去。

  3. src/mastra/routes/session.ts

  这里是 Workflow 的管理接口：

  - 查询 Workflow 运行详情
  - 重放 Workflow 状态
  - 恢复挂起的 Workflow
  - 重启 Workflow
  - 取消 Workflow
  - 在 display-state 中汇总 Workflow 的运行和挂起状态

  相关路由是：

  /work/sessions/:scope/threads/:threadId/workflows/:workflowId/runs/:runId
  /work/sessions/:scope/threads/:threadId/workflows/:workflowId/runs/:runId/stream
  /work/sessions/:scope/threads/:threadId/workflows/:workflowId/runs/:runId/resume
  /work/sessions/:scope/threads/:threadId/workflows/:workflowId/runs/:runId/restart
  /work/sessions/:scope/threads/:threadId/workflows/:workflowId/runs/:runId/cancel

  所以，“跳过 Workflow 部分”指的是暂时不继续核查或重构这条自定义团队显式编排路径，尤其是：

  - Workflow 中 Agent step 的工具审批是否完全沿父 Session 处理。
  - Workflow 内部成员 Agent 的权限边界。
  - Workflow suspend/resume 和 Session approval/suspension 的交界。
  - 直接调用 Workflow 的运行、恢复和取消并发行为。

  它不影响已经完成的主聊天路径、主 Work Agent、原生子 Agent、Session 权限和普通 Agent 调用。

  因此当前状态可以准确描述为：

  > 除了自定义团队的显式 Workflow 编排、Workflow 审批和 Workflow 运行管理边界外，主 Agent、原生子 Agent、Session、模式和权
  > 限路径已经基本修好。自定义 Agent/团队模块本身已经接入官方 Workflow API，但 Workflow 这一分支仍然是未完成审查项。
