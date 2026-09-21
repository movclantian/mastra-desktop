/**
 * 线程业务 metadata 类型:工作区绑定 / 模式 / 权限规则 / 模型快照 /
 * 子代理与草稿标记。
 */
export type ThreadMetadata = {
  /** 当前线程使用的 Agent 或 Agent 团队 profile。缺省为 mastra-work-agent。 */
  agentProfileId?: string;
  pinned?: boolean;
  archivedAt?: string | null;
  draft?: boolean;
  /**
   * 会话模式(plan / build / review,见 src/mastra/agents/modes.ts)。
   * 缺省视为默认模式;非法值由 resolveMode 回落,故不需要在路由层校验。
   */
  currentModeId?: string;
  /**
   * 工具审批规则(官方 PermissionRules 形状,见 src/mastra/agents/permissions.ts)。
   * 缺省视为默认规则(只读放行、写/执行需批准)。
   */
  permissionRules?: {
    categories?: Record<string, string>;
    tools?: Record<string, string>;
  };
  /**
   * 本线程最近使用的模型形态快照(每次带 body.model 的请求写入)。
   * 只存形态 —— apiKey / gateway url 永不落线程元数据。
   */
  modelSelectionByMode?: Record<
    string,
    {
      providerId: string;
      modelId: string;
      modelName: string;
      reasoningEffort: string;
    }
  >;
  /**
   * 线程绑定的工作区目录(绝对路径)。首条消息时锁定:
   * - 显式绑定:用户在 promptInput 选择器选定的本地目录
   * - 隐式绑定:<threadsRoot>/<threadId>/(线程专属默认目录,用户同样可浏览)
   */
  workspacePath?: string;
  /** true = 用户显式选定的目录;false/缺省 = 隐式默认目录(两者都可浏览) */
  workspaceExplicit?: boolean;
  contextUsage?: Record<string, unknown> | null;
  contextUsageVersion?: number;
  totalUsage?: Record<string, unknown> | null;
};
