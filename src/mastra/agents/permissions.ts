import type {
  PermissionPolicy,
  PermissionRules,
  ToolCategory,
} from "@mastra/core/agent-controller";
import type { RequireToolApprovalFn } from "@mastra/core/tools";
import { WORKSPACE_TOOLS, WORKSPACE_TOOLS_PREFIX } from "@mastra/core/workspace";
import { z } from "zod";
import {
  type AgentMemberDefinition,
  type AgentProfile,
  DEFAULT_PERMISSION_RULES,
  delegationMemberIds,
  PERMISSION_POLICIES,
  PERMISSION_RULES_CONTEXT_KEY,
  TOOL_CATEGORIES,
} from "../../shared/agent-contract.ts";
import { COMPUTER_READ_TOOLS, COMPUTER_TOOL_PREFIX } from "../../shared/computer-contract.ts";

const permissionRulesSchema = z.object({
  categories: z.partialRecord(z.enum(TOOL_CATEGORIES), z.enum(PERMISSION_POLICIES)),
  tools: z.record(z.string(), z.enum(PERMISSION_POLICIES)),
});

/** Validate product-owned state without stripping native OM/subagent state keys. */
export const workbenchSessionStateSchema = z
  .object({
    permissionRules: permissionRulesSchema.optional(),
    yolo: z.boolean().optional(),
  })
  .passthrough();

export type { PermissionPolicy, PermissionRules, ToolCategory };

/** 已认证会话与定时任务传给 Agent 的当前线程权限规则。 */

export const SESSION_TOOL_POLICY_CONTEXT_KEY = "mastra-work:tool-policy";
export const READ_ONLY_EXPERT_CONTEXT_KEY = "mastra-work:read-only-expert";

/** Delegated runs have no Controller approval handler; resolve the same policy before execution. */
export const requestToolApproval: RequireToolApprovalFn = ({ toolName, requestContext }) => {
  const resolve = requestContext?.[SESSION_TOOL_POLICY_CONTEXT_KEY] as
    | ((name: string) => PermissionPolicy)
    | undefined;
  if (typeof resolve === "function") return resolve(toolName) !== "allow";
  const rules = parsePermissionRules(requestContext?.[PERMISSION_RULES_CONTEXT_KEY]);
  return (rules.tools[toolName] ?? rules.categories[toolCategoryOf(toolName)]) !== "allow";
};

/**
 * 默认策略:工作台默认完全访问;交互型工具仍显式允许,避免进入审批门。
 */

// ---------------------------------------------------------------------------
// 工具 → 类别(官方 toolCategoryResolver 的位置)
// ---------------------------------------------------------------------------

/**
 * 交互型工具永不进审批门。它们靠 suspend() 与用户往返(submit-plan-tool.mdx /
 * ask-user-tool.mdx),再叠一层预执行审批会让同一次交互先弹批准框、批准后再弹问答框。
 */

const WORKSPACE_EDIT_TOOLS = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
  WORKSPACE_TOOLS.SEARCH.INDEX,
]);

const WORKSPACE_EXECUTE_TOOLS = new Set<string>([
  WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
  WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS,
]);

const WORKSPACE_READ_TOOLS = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES,
  WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT,
  WORKSPACE_TOOLS.FILESYSTEM.GREP,
  WORKSPACE_TOOLS.SEARCH.SEARCH,
  WORKSPACE_TOOLS.LSP.LSP_INSPECT,
  WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT,
]);

/** 非工作区工具的显式类别。未列出者归 other，按线程的该类别规则处理。 */
const CATEGORY_BY_TOOL: Record<string, ToolCategory> = {
  // Code Mode 的 QuickJS 无宿主访问能力；每个 external 调用独立遵循当前工具范围与权限。
  execute_typescript: "read",
  // Skills:只读取技能目录里的说明与脚本文本
  skill: "read",
  skill_search: "read",
  skill_read: "read",
  // 联网检索(src/mastra/tools/web-search.ts 注入的全部名字)
  web_fetch: "read",
  tavily_search: "read",
  tavily_extract: "read",
  firecrawl_search: "read",
  firecrawl_scrape: "read",
  anysearch_search: "read",
  anysearch_get_sub_domains: "read",
  anysearch_batch_search: "read",
  anysearch_extract: "read",
  library_vector_search: "read",
  library_graph_search: "read",
  library_document_chunker: "read",
  // AgentBrowser:观察页面不改变外部状态；其余浏览器动作按执行类审批。
  browser_snapshot: "read",
  browser_screenshot: "read",
  browser_goto: "execute",
  browser_click: "execute",
  browser_type: "execute",
  browser_press: "execute",
  browser_select: "execute",
  browser_scroll: "execute",
  browser_hover: "execute",
  browser_back: "execute",
  browser_dialog: "execute",
  browser_wait: "execute",
  browser_tabs: "execute",
  browser_drag: "execute",
  browser_evaluate: "execute",
  browser_close: "execute",
  // TaskSignalProvider 的 TODO 状态会持久修改当前线程，不能进入 Plan/Review 只读 allow-list。
  task_write: "edit",
  task_update: "edit",
  task_complete: "edit",
  task_check: "read",
  // 通知收件箱的 dismiss/archive 会改写持久状态,不能作为 Plan/Review 只读工具。
  notification_inbox: "edit",
  "notification-inbox": "edit",
};

/**
 * 工具名 → 权限类别。
 * 工作区工具按官方常量表分类；未识别的工作区工具归 edit，按线程的 edit 规则处理。
 */
const READ_ONLY_TOOL_NAMES = [
  ...COMPUTER_READ_TOOLS,
  ...WORKSPACE_READ_TOOLS,
  ...Object.keys(CATEGORY_BY_TOOL).filter((name) => CATEGORY_BY_TOOL[name] === "read"),
  "ask_user",
];

/** Workspace's beforeToolCall hook limits Plan writes to plans/*.md. */
const PLAN_TOOL_NAMES = [
  ...READ_ONLY_TOOL_NAMES,
  "submit_plan",
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
];

const COORDINATOR_TOOL_NAMES = new Set([
  "execute_typescript",
  ...WORKSPACE_READ_TOOLS,
  "ask_user",
  "submit_plan",
  "task_write",
  "task_update",
  "task_complete",
  "task_check",
  "skill",
  "skill_search",
  "skill_read",
  "notification_inbox",
]);

/** Native mode allowlists must retain the configured delegation tools, not every agent-shaped name. */
export function resolveAgentActiveTools({
  tools,
  activeTools,
  mode,
  rules,
  profile,
  member,
  scheduled,
  readOnlyExpert,
}: {
  tools: string[];
  activeTools?: string[];
  mode: WorkMode;
  rules: PermissionRules;
  profile?: AgentProfile;
  member?: AgentMemberDefinition;
  scheduled: boolean;
  readOnlyExpert: boolean;
}): string[] {
  const coordinationTools = new Set(
    profile ? delegationMemberIds(profile, member).map((id) => `agent-${id}`) : [],
  );
  const supervisor = !member && profile?.workflow?.strategy === "supervisor";
  if (supervisor && profile?.workflow?.steps.length) coordinationTools.add("workflow-teamWorkflow");
  if (!member && profile?.workflow?.strategy === "handoff") coordinationTools.add("handoff");
  const enabled = new Set(activeTools ?? tools);
  for (const name of coordinationTools) enabled.add(name);
  return tools.filter((name) => {
    const policy = rules.tools[name] ?? rules.categories[toolCategoryOf(name)];
    const collaboration =
      name.startsWith("agent-") || name.startsWith("workflow-") || name === "handoff";
    return (
      enabled.has(name) &&
      (!collaboration || coordinationTools.has(name)) &&
      (!mode.availableTools || mode.availableTools.includes(name) || coordinationTools.has(name)) &&
      (!readOnlyExpert || READ_ONLY_TOOL_NAMES.includes(name)) &&
      (!scheduled || (name !== "ask_user" && name !== "submit_plan")) &&
      (scheduled ? policy === "allow" : policy !== "deny") &&
      (!supervisor ||
        coordinationTools.has(name) ||
        COORDINATOR_TOOL_NAMES.has(name) ||
        (mode.id === "plan" && name === WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE))
    );
  });
}

export function toolCategoryOf(toolName: string): ToolCategory {
  if (toolName.startsWith(COMPUTER_TOOL_PREFIX))
    return COMPUTER_READ_TOOLS.includes(toolName) ? "read" : "execute";
  const explicit = CATEGORY_BY_TOOL[toolName];
  if (explicit) return explicit;
  if (toolName.startsWith(WORKSPACE_TOOLS_PREFIX)) {
    if (WORKSPACE_READ_TOOLS.has(toolName)) return "read";
    if (WORKSPACE_EXECUTE_TOOLS.has(toolName)) return "execute";
    if (WORKSPACE_EDIT_TOOLS.has(toolName)) return "edit";
    return "edit";
  }
  // MCPClient generates names from our reserved `mcp_${serverId}` server namespace.
  if (toolName.startsWith("mcp_")) return "mcp";
  return "other";
}

// ---------------------------------------------------------------------------
// 规则解析
// ---------------------------------------------------------------------------

/** Thread metadata is durable; each Session receives its own validated rules. */
export function parsePermissionRules(value: unknown): PermissionRules {
  const rules = permissionRulesSchema.parse(value ?? { categories: {}, tools: {} });
  return {
    categories: { ...DEFAULT_PERMISSION_RULES.categories, ...rules.categories },
    tools: { ...DEFAULT_PERMISSION_RULES.tools, ...rules.tools },
  };
}

/** Official Controller modes shared by the workbench and agent request handlers. */
import type { AgentControllerMode } from "@mastra/core/agent-controller";

type WorkModeId = "plan" | "build" | "review";

export type WorkMode = AgentControllerMode & {
  id: WorkModeId;
  name: string;
  /** 前端菜单里的一句话说明(与 src/renderer/src/lib/session-policy.ts 对应) */
  description: string;
  /** 叠加到 Agent instructions 之后的模式指令 */
  instructions: string;
};

const WORK_MODES: WorkMode[] = [
  {
    id: "plan",
    name: "计划",
    description: "先调研、写计划文件并提交审批,批准后自动切到构建",
    transitionsTo: "build",
    availableTools: PLAN_TOOL_NAMES,
    instructions: `MODE: PLAN.
Investigate before proposing anything. Read relevant files and use read-only tools. Ask the user with ask_user when a missing decision blocks reliable planning.
Do not carry out the work in this mode. Your deliverable is a plan, not a change.
Write the complete Markdown plan to plans/<name>.md with mastra_workspace_write_file, then call submit_plan with that workspace-relative path and wait for the user's decision. Parent directories are created automatically. If revising an existing plan, read it with mastra_workspace_read_file before overwriting and submitting it again.
Only Markdown files directly inside plans/ may be written in this mode. You may not use task-state mutation, delete, edit, execute, browser mutation, MCP, or external side-effect tools in this mode.`,
  },
  {
    id: "build",
    name: "构建",
    metadata: { default: true },
    description: "按用户要求执行任务，遵循工具权限",
    instructions: `MODE: BUILD.
Carry out the user's request according to your configured role, following an approved plan when one exists. A supervisor coordinates execution through its members.
Report actual results and unresolved issues; use tools only when the task requires them.
Stay within the user's requested scope. Ask when a decision changes that scope.`,
  },
  {
    id: "review",
    name: "复查",
    description: "只读复查已有变更并报告问题,写入与执行类工具被收回",
    availableTools: READ_ONLY_TOOL_NAMES,
    instructions: `MODE: REVIEW.
Review the available evidence according to your configured role. You and your delegated members have no write, task-state mutation, or command-execution tools in this mode — do not claim to have changed anything.
Ground findings in evidence you actually inspected; cite file and line when reviewing code. State concrete issues and their impact.
If a finding needs a change, describe the change; the user will switch to another mode to apply it.`,
  },
];

export function listWorkModes(): WorkMode[] {
  return WORK_MODES.map((mode) => ({ ...mode }));
}

const DEFAULT_MODE_ID: WorkModeId =
  WORK_MODES.find((mode) => mode.metadata?.default)?.id ?? "build";

/** 会话与定时任务传给 Agent 动态 instructions/tools 的当前模式。 */
export const MODE_ID_CONTEXT_KEY = "mastra-work:mode-id";

/** 按 id 取模式;非法或缺失回落默认模式(因此路由层不必再校验 modeId) */
export function resolveMode(modeId: unknown): WorkMode {
  const found = WORK_MODES.find((mode) => mode.id === modeId);
  return found ?? WORK_MODES.find((mode) => mode.id === DEFAULT_MODE_ID) ?? WORK_MODES[0];
}

/** Controller transitions (for example plan approval) take effect before a request is recreated. */
export function resolveRequestMode(context?: { get: (key: string) => unknown }): WorkMode {
  const controller = context?.get("controller") as { session?: { modeId?: unknown } } | undefined;
  return resolveMode(controller?.session?.modeId ?? context?.get(MODE_ID_CONTEXT_KEY));
}

export { PERMISSION_RULES_CONTEXT_KEY, TOOL_CATEGORIES };
