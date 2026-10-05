import type {
  PermissionPolicy,
  PermissionRules,
  ToolCategory,
} from "@mastra/core/agent-controller";
import { WORKSPACE_TOOLS, WORKSPACE_TOOLS_PREFIX } from "@mastra/core/workspace";

/** Workbench category catalog and persisted native Controller permission rules. */
const DEFAULT_CATEGORY_POLICIES = {
  read: "allow",
  edit: "allow",
  execute: "allow",
  mcp: "allow",
  other: "allow",
} satisfies Record<ToolCategory, PermissionPolicy>;

const PERMISSION_POLICY_KEYS = {
  allow: true,
  ask: true,
  deny: true,
} satisfies Record<PermissionPolicy, true>;

export const TOOL_CATEGORIES = Object.keys(DEFAULT_CATEGORY_POLICIES) as ToolCategory[];
export const PERMISSION_POLICIES = Object.keys(PERMISSION_POLICY_KEYS) as PermissionPolicy[];

export type { PermissionPolicy, PermissionRules, ToolCategory };

/** chat 路由 → Agent defaultOptions 传递本线程生效规则的 RequestContext key */
export const PERMISSION_RULES_CONTEXT_KEY = "mastra-work:permission-rules";
export const SESSION_TOOL_POLICY_CONTEXT_KEY = "mastra-work:tool-policy";

/**
 * 默认策略:工作台默认完全访问;交互型工具仍显式允许,避免进入审批门。
 */
export const DEFAULT_PERMISSION_RULES: PermissionRules = {
  categories: { ...DEFAULT_CATEGORY_POLICIES },
  tools: { ask_user: "allow", submit_plan: "allow" },
};

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
  // Code Mode:在沙箱里运行模型生成的多工具编排代码,由外层审批统一保护
  execute_typescript: "execute",
  // Skills:只读取技能目录里的说明与脚本文本
  skill: "read",
  skill_search: "read",
  skill_read: "read",
  // 联网检索(src/mastra/tools/web-search.ts 注入的全部名字)
  web_search: "read",
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
export const READ_ONLY_TOOL_NAMES = [
  ...WORKSPACE_READ_TOOLS,
  ...Object.keys(CATEGORY_BY_TOOL).filter((name) => CATEGORY_BY_TOOL[name] === "read"),
  "ask_user",
];

/** Plan 模式允许的唯一写入能力:只能生成 plans/ 下的计划草稿。 */
export const PLAN_DRAFT_TOOL_NAME = "write_plan_draft";
export const PLAN_TOOL_NAMES = [...READ_ONLY_TOOL_NAMES, "submit_plan", PLAN_DRAFT_TOOL_NAME];

export function toolCategoryOf(toolName: string): ToolCategory {
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

function isPolicy(value: unknown): value is PermissionPolicy {
  return typeof value === "string" && (PERMISSION_POLICIES as readonly string[]).includes(value);
}

/** 从 thread.metadata / RequestContext 读回规则(容错:非法字段丢弃,缺失回落默认) */
export function parsePermissionRules(value: unknown): PermissionRules {
  if (typeof value !== "object" || value === null) return DEFAULT_PERMISSION_RULES;
  const raw = value as { categories?: unknown; tools?: unknown };
  const categories: PermissionRules["categories"] = { ...DEFAULT_PERMISSION_RULES.categories };
  if (typeof raw.categories === "object" && raw.categories !== null) {
    for (const category of TOOL_CATEGORIES) {
      const policy = (raw.categories as Record<string, unknown>)[category];
      if (isPolicy(policy)) categories[category] = policy;
    }
  }
  const tools: PermissionRules["tools"] = { ...DEFAULT_PERMISSION_RULES.tools };
  if (typeof raw.tools === "object" && raw.tools !== null) {
    for (const [toolName, policy] of Object.entries(raw.tools as Record<string, unknown>)) {
      if (isPolicy(policy)) tools[toolName] = policy;
    }
  }
  return { categories, tools };
}

/** Official Controller modes shared by the workbench and agent request handlers. */
import type { AgentControllerMode } from "@mastra/core/agent-controller";

export type WorkModeId = "plan" | "build" | "review";

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
    description: "先调研、写计划文件并提交审批,批准后自动切到执行",
    metadata: { default: true },
    transitionsTo: "build",
    availableTools: PLAN_TOOL_NAMES,
    instructions: `MODE: PLAN.
Investigate before proposing anything. Read relevant files and use read-only tools. Ask the user with ask_user when a missing decision blocks reliable planning.
Do not carry out the work in this mode. Your deliverable is a plan, not a change.
Write the complete Markdown plan to a file under the plans/ directory of the workspace with write_plan_draft, then call submit_plan with that file path and wait for the user's decision. If the plan is rejected, revise the file and submit it again.
You may not use task-state mutation, ordinary workspace write, delete, edit, execute, browser mutation, MCP, or external side-effect tools in this mode.`,
  },
  {
    id: "build",
    name: "执行",
    description: "执行已批准的计划,工具全量开放",
    instructions: `MODE: BUILD.
Carry out the approved plan. Keep the task list current with task_write / task_update / task_complete, with exactly one task in progress.
Prefer small verifiable steps: make a change, check it, then move to the next task. Report what you actually did, including anything you could not finish.
Do not silently widen the scope beyond the approved plan — if new work is required, say so and ask before doing it.`,
  },
  {
    id: "review",
    name: "复查",
    description: "只读复查已有变更并报告问题,写入与执行类工具被收回",
    availableTools: READ_ONLY_TOOL_NAMES,
    instructions: `MODE: REVIEW.
Inspect the current state of the workspace and report findings. You have no write, task-state mutation, or command-execution tools in this mode — do not claim to have changed anything.
Ground every finding in a file and line you actually read. Order findings by severity and state, for each one, the concrete input or state that would make it fail.
If a finding needs a change, describe the change; the user will switch to another mode to apply it.`,
  },
];

export function listWorkModes(): WorkMode[] {
  return WORK_MODES.map((mode) => ({ ...mode }));
}

export const DEFAULT_MODE_ID: WorkModeId =
  WORK_MODES.find((mode) => mode.metadata?.default)?.id ?? "plan";

/** chat 路由 → Agent 动态 instructions/tools 传递当前模式的 RequestContext key */
export const MODE_ID_CONTEXT_KEY = "mastra-work:mode-id";

/** 按 id 取模式;非法或缺失回落默认模式(因此路由层不必再校验 modeId) */
export function resolveMode(modeId: unknown): WorkMode {
  const found = WORK_MODES.find((mode) => mode.id === modeId);
  return found ?? WORK_MODES.find((mode) => mode.id === DEFAULT_MODE_ID) ?? WORK_MODES[0];
}
