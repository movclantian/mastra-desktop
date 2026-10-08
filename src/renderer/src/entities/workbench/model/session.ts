import {
  DEFAULT_PERMISSION_RULES,
  PERMISSION_POLICIES,
  type PermissionPolicy,
  type PermissionRules,
  TOOL_CATEGORIES,
  type ToolCategory,
} from "../../../../../shared/agent-contract";
/**
 * 会话策略(模式 + 工具审批)的渲染层常量与规则助手。
 *
 * 服务端类型真相来自 @mastra/core/agent-controller;渲染进程不能依赖服务端 Agent
 * 模块,类别、策略和默认规则统一取自 shared/agent-contract，这里只维护 UI 文案。
 *
 * 这里**不镜像「工具名 → 类别」的映射**:审批面板需要的类别由服务端算好后随
 * 会话 display-state 一起下发,避免两侧各存一份工具清单而漂移。
 */

// ---------------------------------------------------------------------------
// 会话模式
// ---------------------------------------------------------------------------

import { i18n } from "@/shared/i18n";

export const WORK_MODE_IDS = ["build", "plan", "review"] as const;
export type WorkModeId = (typeof WORK_MODE_IDS)[number];

export const DEFAULT_MODE_ID: WorkModeId = "build";

// ---------------------------------------------------------------------------
// 工具审批(官方 ToolCategory / PermissionPolicy / PermissionRules)
// ---------------------------------------------------------------------------

export const CATEGORY_META: Record<ToolCategory, { label: string; description: string }> = {
  read: {
    get label() {
      return i18n.t("chat:approvals.categories.read");
    },
    get description() {
      return i18n.t("chat:approvals.categoryDescriptions.read");
    },
  },
  edit: {
    get label() {
      return i18n.t("chat:approvals.categories.edit");
    },
    get description() {
      return i18n.t("chat:approvals.categoryDescriptions.edit");
    },
  },
  execute: {
    get label() {
      return i18n.t("chat:approvals.categories.execute");
    },
    get description() {
      return i18n.t("chat:approvals.categoryDescriptions.execute");
    },
  },
  mcp: {
    get label() {
      return i18n.t("chat:approvals.categories.mcp");
    },
    get description() {
      return i18n.t("chat:approvals.categoryDescriptions.mcp");
    },
  },
  other: {
    get label() {
      return i18n.t("chat:approvals.categories.other");
    },
    get description() {
      return i18n.t("chat:approvals.categoryDescriptions.other");
    },
  },
};

export interface ApprovalPreset {
  id: "standard" | "allow-all";
  readonly label: string;
  readonly description: string;
  rules: PermissionRules;
}

export const APPROVAL_PRESETS: ApprovalPreset[] = [
  {
    id: "standard",
    get label() {
      return i18n.t("chat:approvals.standard.label");
    },
    get description() {
      return i18n.t("chat:approvals.standard.desc");
    },
    rules: {
      categories: { read: "allow", edit: "ask", execute: "ask", mcp: "ask", other: "ask" },
      tools: { ...DEFAULT_PERMISSION_RULES.tools },
    },
  },
  {
    id: "allow-all",
    get label() {
      return i18n.t("chat:approvals.allowAll.label");
    },
    get description() {
      return i18n.t("chat:approvals.allowAll.desc");
    },
    rules: DEFAULT_PERMISSION_RULES,
  },
];

export type ApprovalPresetId = ApprovalPreset["id"] | "custom";

function sameCategories(left: PermissionRules, right: PermissionRules): boolean {
  return TOOL_CATEGORIES.every(
    (category) =>
      (left.categories[category] ?? DEFAULT_PERMISSION_RULES.categories[category]) ===
      (right.categories[category] ?? DEFAULT_PERMISSION_RULES.categories[category]),
  );
}

/** 当前规则命中哪个预设(都不命中即「自定义」) */
export function matchApprovalPreset(rules: PermissionRules): ApprovalPresetId {
  // 交互工具的固定允许规则由服务端补齐，不代表用户设置了自定义审批。
  if (
    Object.entries(rules.tools).some(
      ([name, policy]) => policy !== DEFAULT_PERMISSION_RULES.tools[name],
    )
  )
    return "custom";
  return APPROVAL_PRESETS.find((preset) => sameCategories(rules, preset.rules))?.id ?? "custom";
}

/** 审批模式按钮上的短标签 */
export function approvalSummary(rules: PermissionRules): string {
  const preset = matchApprovalPreset(rules);
  if (preset !== "custom") {
    return (
      APPROVAL_PRESETS.find((item) => item.id === preset)?.label ?? i18n.t("chat:approvals.custom")
    );
  }
  const denied = TOOL_CATEGORIES.filter((category) => rules.categories[category] === "deny");
  if (denied.length > 0) {
    return i18n.t("chat:approvals.customDeny", {
      denied: denied.map((category) => CATEGORY_META[category].label).join("/"),
    });
  }
  return i18n.t("chat:approvals.custom");
}

export function withCategoryPolicy(
  rules: PermissionRules,
  category: ToolCategory,
  policy: PermissionPolicy,
): PermissionRules {
  return { ...rules, categories: { ...rules.categories, [category]: policy } };
}

/** 解析会话规则:非法字段丢弃,缺失回落默认(与服务端 parsePermissionRules 同构) */
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
  const tools: PermissionRules["tools"] = { ...DEFAULT_PERMISSION_RULES.tools };
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

export {
  DEFAULT_PERMISSION_RULES,
  type PermissionPolicy,
  type PermissionRules,
  type ToolCategory,
} from "../../../../../shared/agent-contract";
