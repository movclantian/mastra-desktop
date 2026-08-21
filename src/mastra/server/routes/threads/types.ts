/**
 * 线程业务 metadata 类型:工作区绑定 / 模式 / 权限规则 / 模型快照 /
 * 子代理与 OM 模型覆盖(draft 标记见 createThreadRoute)。
 */
export type ThreadMetadata = {
  pinned?: boolean;
  archivedAt?: string | null;
  draft?: boolean;
  /**
   * 会话模式(plan / build / review,见 src/mastra/agents/modes.ts)。
   * 缺省视为默认模式;非法值由 resolveMode 回落,故不需要在路由层校验。
   */
  modeId?: string;
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
  subagentModels?: Record<string, string>;
  /** Session-style per-thread observational-memory role selections. */
  observerModelId?: string;
  reflectorModelId?: string;
  /**
   * 线程绑定的工作区目录(绝对路径)。首条消息时锁定:
   * - 显式绑定:用户在 promptInput 选择器选定的本地目录
   * - 隐式绑定:<threadsRoot>/<threadId>/(仅 Agent 工作目录,sidebar 不展示文件树)
   */
  workspacePath?: string;
  /** true = 用户显式选定的目录;false/缺省 = 隐式默认目录 */
  workspaceExplicit?: boolean;
  /** 手动压缩上下文完成时间(真压缩:折叠消息已删除并替换为摘要消息) */
  compactedAt?: string | null;
  /** 最近一次压缩详情(摘要 + token 统计,由 summarize 路由写入,前端 Marker 点击回看) */
  compaction?: {
    summary: string;
    extracted?: Record<string, unknown>;
    extractionFailures?: Array<{ slug: string; error: string }>;
    inputTokens?: number;
    outputTokens?: number;
    estimatedContextTokens?: number;
    deletedMessages?: number;
    compactedAt: string;
    compactionId?: string;
    windowStart?: string;
    windowEnd?: string;
  };
  contextUsage?: Record<string, unknown>;
  /**
   * AI SDK message branch manifest. The active message remains in the normal
   * Memory history; older versions are kept as JSON snapshots so editing or
   * regenerating never destroys a version that the user may want to revisit.
   */
  messageBranches?: Record<string, MessageBranchRecord>;
};

export type PersistedUIMessage = {
  id: string;
  role: "user" | "assistant";
  parts: unknown[];
  metadata?: Record<string, unknown>;
};

export type MessageBranchVersion = {
  id: string;
  role: "user" | "assistant";
  message?: PersistedUIMessage;
  createdAt: string;
  /**
   * 父子配对版本 id:编辑流程 = 同一轮生成的对侧版本(用户↔助手);
   * 重试流程 = 触发重试的父用户版本。客户端切换一侧分支时按它同步另一侧。
   */
  pairVersionId?: string;
  /**
   * 子树快照(仅助手版本使用):该版本作为当前版本期间,它所在行之后的
   * 全部下游消息。分支作用于整条时间线而非单对消息 —— 切走时把下游
   * 快照进当前版本的 tail 并从 Memory 删除;切回时由消息投影插回显示,
   * 下一次发消息时随请求物理落库。
   */
  tail?: PersistedUIMessage[];
};

export type MessageBranchRecord = {
  rootId: string;
  currentVersionId: string;
  versions: MessageBranchVersion[];
};
