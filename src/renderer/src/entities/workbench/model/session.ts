/**
 * 会话策略(模式 + 工具审批)的渲染层常量与规则助手。
 *
 * 服务端类型真相来自 @mastra/core/agent-controller;渲染进程不能依赖服务端 Agent
 * 模块,所以这里只保留 UI 运行时需要的协议镜像与文案,不是第二份服务端类型定义。
 * 改动类别或策略时仍要同步服务端解析逻辑:
 * - 模式 → src/mastra/agents/modes.ts
 * - 类别 / 策略 / 规则形状 → src/mastra/agents/permissions.ts
 *
 * 这里**不镜像「工具名 → 类别」的映射**:审批面板需要的类别由服务端算好后随
 * 会话 display-state 一起下发,避免两侧各存一份工具清单而漂移。
 */

// ---------------------------------------------------------------------------
// 会话模式
// ---------------------------------------------------------------------------

export const WORK_MODE_IDS = ["plan", "build", "review"] as const;
export type WorkModeId = (typeof WORK_MODE_IDS)[number];

export const DEFAULT_MODE_ID: WorkModeId = "plan";

export const WORK_MODE_META: Record<
  WorkModeId,
  {
    label: string;
    description: string;
    hint: string;
  }
> = {
  plan: {
    label: "计划",
    description: "先调研、写计划文件并提交审批",
    hint: "批准计划后自动切到「执行」",
  },
  build: {
    label: "执行",
    description: "执行已批准的计划,工具全量开放",
    hint: "写入与命令执行仍按下方审批策略逐次确认",
  },
  review: {
    label: "复查",
    description: "只读复查已有变更并报告问题",
    hint: "写入与执行类工具在本模式下被收回,模型改不了任何文件",
  },
};

// ---------------------------------------------------------------------------
// 工具审批(官方 ToolCategory / PermissionPolicy / PermissionRules)
// ---------------------------------------------------------------------------

export const TOOL_CATEGORIES = ["read", "edit", "execute", "mcp", "other"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const PERMISSION_POLICIES = ["allow", "ask", "deny"] as const;
export type PermissionPolicy = (typeof PERMISSION_POLICIES)[number];

export interface PermissionRules {
  categories: Partial<Record<ToolCategory, PermissionPolicy>>;
  tools: Partial<Record<string, PermissionPolicy>>;
}

export const CATEGORY_META: Record<ToolCategory, { label: string; description: string }> = {
  read: { label: "读取", description: "读文件、列目录、检索、联网查资料" },
  edit: { label: "写入", description: "创建/改写/删除文件、建目录" },
  execute: { label: "执行", description: "运行命令与任务脚本" },
  mcp: { label: "MCP", description: "外部 MCP 服务器提供的工具" },
  other: { label: "其他", description: "未归类的工具" },
};

export const POLICY_META: Record<PermissionPolicy, { label: string; description: string }> = {
  allow: { label: "允许", description: "直接执行,不打断" },
  ask: { label: "询问", description: "每次调用前等你批准" },
  deny: { label: "拒绝", description: "不给模型这类工具,它无从调用" },
};

export const DEFAULT_PERMISSION_RULES: PermissionRules = {
  categories: { read: "allow", edit: "ask", execute: "ask", mcp: "ask", other: "ask" },
  tools: {},
};

/** 全部免审(官方 yolo 等价形态) */
const ALLOW_ALL_RULES: PermissionRules = {
  categories: { read: "allow", edit: "allow", execute: "allow", mcp: "allow", other: "allow" },
  tools: {},
};

export const APPROVAL_PRESETS = [
  {
    id: "standard" as const,
    label: "逐次审批",
    description: "读取直接放行,写入与执行每次都要你确认",
    rules: DEFAULT_PERMISSION_RULES,
  },
  {
    id: "allow-all" as const,
    label: "全部允许",
    description: "所有工具免审并恢复并发调用 —— 模型可以直接改文件、跑命令",
    rules: ALLOW_ALL_RULES,
  },
];

type ApprovalPresetId = (typeof APPROVAL_PRESETS)[number]["id"] | "custom";

function sameCategories(left: PermissionRules, right: PermissionRules): boolean {
  return TOOL_CATEGORIES.every(
    (category) => (left.categories[category] ?? "ask") === (right.categories[category] ?? "ask"),
  );
}

/** 当前规则命中哪个预设(都不命中即「自定义」) */
export function matchApprovalPreset(rules: PermissionRules): ApprovalPresetId {
  if (Object.keys(rules.tools).length > 0) return "custom";
  return APPROVAL_PRESETS.find((preset) => sameCategories(rules, preset.rules))?.id ?? "custom";
}

/** 审批模式按钮上的短标签 */
export function approvalSummary(rules: PermissionRules): string {
  const preset = matchApprovalPreset(rules);
  if (preset !== "custom") {
    return APPROVAL_PRESETS.find((item) => item.id === preset)?.label ?? "自定义";
  }
  const denied = TOOL_CATEGORIES.filter((category) => rules.categories[category] === "deny");
  if (denied.length > 0) {
    return `自定义 · 拒绝${denied.map((category) => CATEGORY_META[category].label).join("/")}`;
  }
  return "自定义";
}

export function withCategoryPolicy(
  rules: PermissionRules,
  category: ToolCategory,
  policy: PermissionPolicy,
): PermissionRules {
  return { ...rules, categories: { ...rules.categories, [category]: policy } };
}

/** 从 thread.metadata 读回规则:非法字段丢弃,缺失回落默认(与服务端 parsePermissionRules 同构) */
export function parsePermissionRules(value: unknown): PermissionRules {
  if (typeof value !== "object" || value === null) return DEFAULT_PERMISSION_RULES;
  const raw = value as { categories?: unknown; tools?: unknown };
  const categories: PermissionRules["categories"] = { ...DEFAULT_PERMISSION_RULES.categories };
  if (typeof raw.categories === "object" && raw.categories !== null) {
    for (const category of TOOL_CATEGORIES) {
      const policy = (raw.categories as Record<string, unknown>)[category];
      if ((PERMISSION_POLICIES as readonly string[]).includes(policy as string)) {
        categories[category] = policy as PermissionPolicy;
      }
    }
  }
  const tools: PermissionRules["tools"] = {};
  if (typeof raw.tools === "object" && raw.tools !== null) {
    for (const [toolName, policy] of Object.entries(raw.tools as Record<string, unknown>)) {
      if ((PERMISSION_POLICIES as readonly string[]).includes(policy as string)) {
        tools[toolName] = policy as PermissionPolicy;
      }
    }
  }
  return { categories, tools };
}

export function parseModeId(value: unknown): WorkModeId {
  return (WORK_MODE_IDS as readonly string[]).includes(value as string)
    ? (value as WorkModeId)
    : DEFAULT_MODE_ID;
}
