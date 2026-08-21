import { WORKSPACE_TOOLS, WORKSPACE_TOOLS_PREFIX } from "@mastra/core/workspace";

/**
 * 工具审批策略:在 Agent 请求上下文上实现工作台权限语义。
 *
 * 类别与策略枚举、规则形状、解析优先级遵循 Mastra Agent 工具审批 API,
 * 规则直接持久化在线程 metadata,由下一次原生 chat stream 读取。
 *
 * 与官方的两处必要差异(都是宿主形态导致的,不是语义分歧):
 * 1. 裁决位置。官方在消费 fullStream 时按 policy 自动 approve/decline;我们把
 *    UI 流原样透传给 useChat(不手写 SSE),没有拦截点,因此改用官方同样提供的
 *    函数式 requireToolApproval(human-in-the-loop.mdx「Conditional approval with
 *    a function」)——"ask" 返回 true、"allow" 返回 false。
 * 2. deny 的执行点。官方从 toolsets 里删除被拒工具;我们对**自己注入**的工具同样
 *    直接不注入(模型看不见),对**工作区注入**的工具无法在注入侧过滤,改用
 *    hooks.beforeToolCall 返回 { proceed: false, output }(human-in-the-loop.mdx
 *    的指纹绑定示例用的就是这个钩子),模型会收到明确的「被策略拒绝」而不是静默失败。
 */

// ---------------------------------------------------------------------------
// 官方枚举与规则形状
// ---------------------------------------------------------------------------

export const TOOL_CATEGORIES = ["read", "edit", "execute", "mcp", "other"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const PERMISSION_POLICIES = ["allow", "ask", "deny"] as const;
export type PermissionPolicy = (typeof PERMISSION_POLICIES)[number];

export interface PermissionRules {
  categories: Partial<Record<ToolCategory, PermissionPolicy>>;
  tools: Partial<Record<string, PermissionPolicy>>;
}

/** chat 路由 → Agent defaultOptions 传递本线程生效规则的 RequestContext key */
export const PERMISSION_RULES_CONTEXT_KEY = "mastra-work:permission-rules";
export const SESSION_GRANTS_CONTEXT_KEY = "mastra-work:session-grants";

/**
 * 默认策略:只放开 read,其余沿用官方兜底 "ask"。
 * 官方在没有任何类别策略时对所有工具兜底 ask;我们显式写全五个类别,
 * 让「默认行为」在代码里可读,而不是依赖框架兜底。
 */
export const DEFAULT_PERMISSION_RULES: PermissionRules = {
  categories: { read: "allow", edit: "ask", execute: "ask", mcp: "ask", other: "ask" },
  tools: {},
};

// ---------------------------------------------------------------------------
// 工具 → 类别(官方 toolCategoryResolver 的位置)
// ---------------------------------------------------------------------------

/**
 * 交互型工具永不进审批门。它们靠 suspend() 与用户往返(submit-plan-tool.mdx /
 * ask-user-tool.mdx),再叠一层预执行审批会让同一次交互先弹批准框、批准后再弹问答框。
 */
const INTERACTIVE_TOOLS = new Set(["ask_user", "submit_plan"]);

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

/** 非工作区工具的显式类别。未列出者归 other(默认 ask),不会被静默放行。 */
const CATEGORY_BY_TOOL: Record<string, ToolCategory> = {
  // Code Mode:在沙箱里运行模型生成的多工具编排代码,由外层审批统一保护
  execute_typescript: "execute",
  // Skills:只读取技能目录里的说明与脚本文本
  skill: "read",
  skill_search: "read",
  skill_read: "read",
  // 联网检索(src/mastra/agents/tools.ts 注入的全部名字)
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
  // TaskSignalProvider 的 TODO 工具:改的是线程状态(threadState)而非用户机器,
  // 结果只体现在输入区上方的任务队列里,因此与只读同级、不打断执行
  task_write: "read",
  task_update: "read",
  task_complete: "read",
  task_check: "read",
};

/**
 * 工具名 → 权限类别。
 * 工作区工具按官方常量表分类;**未识别的工作区工具按 edit 处理**(最严格的可写类别),
 * 这样框架新增工具时默认需要批准,而不是默认放行。
 */
export function toolCategoryOf(toolName: string): ToolCategory {
  const explicit = CATEGORY_BY_TOOL[toolName];
  if (explicit) return explicit;
  if (toolName.startsWith(WORKSPACE_TOOLS_PREFIX)) {
    if (WORKSPACE_READ_TOOLS.has(toolName)) return "read";
    if (WORKSPACE_EXECUTE_TOOLS.has(toolName)) return "execute";
    if (WORKSPACE_EDIT_TOOLS.has(toolName)) return "edit";
    return "edit";
  }
  // MCPClient namespaces discovered tools as `${serverId}_${toolName}`.
  // Treat unknown names containing the namespace separator as external MCP
  // capabilities so the default policy remains approval-first.
  if (toolName.includes("_") && !toolName.startsWith("library_")) return "mcp";
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
  const tools: PermissionRules["tools"] = {};
  if (typeof raw.tools === "object" && raw.tools !== null) {
    for (const [toolName, policy] of Object.entries(raw.tools as Record<string, unknown>)) {
      if (isPolicy(policy)) tools[toolName] = policy;
    }
  }
  return { categories, tools };
}

/** Apply ephemeral Session grants/state without mutating persisted permission rules. */
export function applySessionGrants(rules: PermissionRules, value: unknown): PermissionRules {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return rules;
  const raw = value as { categories?: unknown; tools?: unknown; yolo?: unknown };
  const grantedCategories = Array.isArray(raw.categories)
    ? raw.categories.filter(
        (item): item is ToolCategory =>
          typeof item === "string" && (TOOL_CATEGORIES as readonly string[]).includes(item),
      )
    : [];
  const grantedTools = Array.isArray(raw.tools)
    ? raw.tools.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const categories = { ...rules.categories };
  const tools = { ...rules.tools };

  // Official precedence: an explicit per-tool deny always wins, even in yolo.
  if (raw.yolo === true) {
    for (const category of TOOL_CATEGORIES) categories[category] = "allow";
    for (const [toolName, policy] of Object.entries(tools)) {
      if (policy !== "deny") tools[toolName] = "allow";
    }
  }
  for (const category of grantedCategories) categories[category] = "allow";
  for (const toolName of grantedTools) {
    if (tools[toolName] !== "deny") tools[toolName] = "allow";
  }
  return { categories, tools };
}

/**
 * 单个工具的生效策略。顺序与官方 Session.resolveToolApproval 一致:
 * 按工具的 deny 优先 → 按工具的显式策略 → 类别策略 → 兜底 ask。
 *
 * 官方在「按工具 deny」之后还有 yolo 短路与 session grants;我们把 yolo 表达为
 * 「所有类别都是 allow」(等价且只有一份真相),grants 表达为把类别策略持久化成
 * allow(审批面板的「始终允许此类」),因此不需要额外状态位。
 */
export function resolveToolPolicy(rules: PermissionRules, toolName: string): PermissionPolicy {
  const toolPolicy = rules.tools[toolName];
  if (toolPolicy === "deny") return "deny";
  if (toolPolicy) return toolPolicy;
  return rules.categories[toolCategoryOf(toolName)] ?? "ask";
}

/** 交互型工具不参与审批(见 INTERACTIVE_TOOLS) */
export function isInteractiveTool(toolName: string): boolean {
  return INTERACTIVE_TOOLS.has(toolName);
}

/**
 * 是否所有工具都免审(官方 yolo 等价形态)。
 * 为真时应彻底不传 requireToolApproval —— 该选项一旦存在就会强制工具调用串行
 * (loop/types.d.ts:39),关掉它才能恢复并发。
 */
export function isFullyAllowed(rules: PermissionRules): boolean {
  if (Object.values(rules.tools).some((policy) => policy !== "allow")) return false;
  return TOOL_CATEGORIES.every((category) => rules.categories[category] === "allow");
}

/** 该工具是否被策略拒绝(注入侧与 beforeToolCall 侧共用) */
export function isToolDenied(rules: PermissionRules, toolName: string): boolean {
  if (isInteractiveTool(toolName)) return false;
  return resolveToolPolicy(rules, toolName) === "deny";
}

/** 该工具是否需要用户批准 */
export function isToolApprovalRequired(rules: PermissionRules, toolName: string): boolean {
  if (isInteractiveTool(toolName)) return false;
  return resolveToolPolicy(rules, toolName) === "ask";
}

/** 类别策略覆盖(审批面板「始终允许此类」与审批模式菜单写入前的合并) */
export function withCategoryPolicy(
  rules: PermissionRules,
  category: ToolCategory,
  policy: PermissionPolicy,
): PermissionRules {
  return { ...rules, categories: { ...rules.categories, [category]: policy } };
}
