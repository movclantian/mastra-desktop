import type {
  PermissionPolicy,
  PermissionRules,
  ToolCategory,
} from "@mastra/core/agent-controller";
import { z } from "zod";
import type { PluginBinding } from "./plugin-contract";

export interface MemoryProfile {
  workingMemory: string | null;
  scope: "thread" | "resource";
  format: "template" | "schema";
  enabled: boolean;
  readOnly: boolean;
  source: { threadId: string; threadTitle: string } | null;
  snapshot: string;
  threads: Array<{ id: string; title: string }>;
  extractors: Array<{
    slug: string;
    name: string;
    value: unknown;
    threadId: string;
    threadTitle: string;
    updatedAt: string;
  }>;
  threadCount: number;
}

export const DEFAULT_AGENT_PROFILE_ID = "mastra-work-agent";
/** Shared by persisted Agent configuration and the settings reset action. */
export const DEFAULT_DISCOVERY_CONFIG = {
  skillSearch: true,
  skillSearchTopK: 5,
  skillSearchMinScore: 0,
  skillSearchTtl: 3_600_000,
  skillSearchBlockingRefresh: true,
  toolSearch: true,
  toolSearchTopK: 3,
  toolSearchMinScore: 0,
  toolSearchInjectCatalog: false,
  toolSearchAutoLoad: true,
  toolSearchStorage: "context" as const,
  toolSearchTtl: 3_600_000,
};
export function workbenchSessionId(resourceId: string, threadId: string): string {
  return JSON.stringify(["workbench", resourceId, threadId]);
}
/** Maximum reliable Node timer; task manager and idle wrapper require finite timeouts. */
export const BACKGROUND_TASK_TIMEOUT_MS = 2_147_483_647;

export const MODEL_KINDS = ["language", "image", "video"] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];
// Selecting a model writes only its identity; capability metadata is read-only.
export const enabledModelSelectionSchema = z.object({ id: z.string().min(1), name: z.string() });

/** Prefer declared output capabilities; image/video inputs alone do not make a generator. */
export function inferModelKind(
  id: string,
  metadata?: { modelType?: string; outputModalities?: string[]; generationMethods?: string[] },
): ModelKind {
  if (metadata?.modelType === "image" || metadata?.modelType === "video") return metadata.modelType;
  const output = metadata?.outputModalities ?? [];
  if (output.includes("video")) return "video";
  if (output.includes("image")) return "image";
  if (metadata?.modelType === "language" || output.includes("text")) return "language";
  const name = id.slice(id.lastIndexOf("/") + 1).toLowerCase();
  if (name.startsWith("veo-") || metadata?.generationMethods?.includes("predictLongRunning"))
    return "video";
  if (
    /^(?:gpt-image-|chatgpt-image-|dall-e-|imagen-|flux[.-]|gemini-.*-image(?:-|$)|gemini-nano-banana)/.test(
      name,
    )
  )
    return "image";
  return "language";
}

/**
 * models.dev 目录的模型 ID 归一化。
 */
const MODEL_VARIANT_SUFFIX =
  /-(?:preview|latest|exp|experimental|free|beta|alpha|thinking|reasoning|online|extended)(?:-\d{2}(?:-\d{2})?)?$/;

export function stripModelIdPrefix(id: string): string {
  const slash = id.lastIndexOf("/");
  if (slash <= 0 || slash === id.length - 1) return id;
  return id.slice(slash + 1);
}

/** 统一分隔符、剥离日期后缀;变体词保留(它有时是不同型号)。 */
export function normalizeModelId(id: string): string {
  let value = id.trim().toLowerCase();
  if (!value) return "";
  // `:free` / `@20250101` / `:70b` 这类尾部标签先转成分隔符,后面按需剥离
  value = value.replace(/[@:]+/g, "-");
  // 日期后缀:-20241022 或 -2024-10-22
  value = value.replace(/-(?:19|20)\d{2}-?\d{2}-?\d{2}$/, "");
  value = value.replace(/[\s._]+/g, "-");
  return value.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

export function stripModelVariantSuffix(id: string): string {
  let value = normalizeModelId(id);
  for (let round = 0; round < 3 && MODEL_VARIANT_SUFFIX.test(value); round += 1) {
    value = value.replace(MODEL_VARIANT_SUFFIX, "");
  }
  return value;
}

export function compactModelId(id: string): string {
  return normalizeModelId(id).replace(/[^a-z0-9]/g, "");
}

export function modelLookupKeys(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const bare = stripModelIdPrefix(trimmed);
  const candidates = bare === trimmed ? [trimmed] : [trimmed, bare];
  const keys: string[] = [];
  const push = (key: string) => {
    if (!/^[a-z]:$/.test(key) && !keys.includes(key)) keys.push(key);
  };
  for (const candidate of candidates) push(`e:${candidate.toLowerCase()}`);
  for (const candidate of candidates) push(`n:${normalizeModelId(candidate)}`);
  for (const candidate of candidates) push(`s:${stripModelVariantSuffix(candidate)}`);
  for (const candidate of candidates) push(`c:${compactModelId(candidate)}`);
  return keys;
}

/** 目录侧键:一个模型同时挂在四层上,查询命中任意一层即可。 */
export function catalogModelKeys(id: string): string[] {
  const trimmed = id.trim();
  if (!trimmed) return [];
  return [
    ...new Set(
      [
        `e:${trimmed.toLowerCase()}`,
        `n:${normalizeModelId(trimmed)}`,
        `s:${stripModelVariantSuffix(trimmed)}`,
        `c:${compactModelId(trimmed)}`,
      ].filter((key) => !/^[a-z]:$/.test(key)),
    ),
  ];
}
export const generatedMediaSchema = z.object({
  model: z.string(),
  prompt: z.string(),
  warnings: z.array(z.string()).optional(),
  files: z
    .array(
      z.object({
        assetId: z.string().min(1),
        mediaType: z.string().regex(/^(image|video)\/[\w.+-]+$/),
        filename: z.string(),
        byteSize: z.number().nonnegative(),
      }),
    )
    .min(1),
});
export type GeneratedMedia = z.infer<typeof generatedMediaSchema>;
export const mediaGenerationStateSchema = z.object({
  kind: z.enum(["image", "video"]),
  status: z.enum(["generating", "complete", "failed", "canceled"]),
  result: generatedMediaSchema.optional(),
  error: z.string().optional(),
});
export type MediaGenerationState = z.infer<typeof mediaGenerationStateSchema>;

/** The same roster drives native agent tools, prompts and mode visibility. */
export function delegationMemberIds(
  profile: AgentProfile,
  member?: AgentMemberDefinition,
): string[] {
  if (member) return member.delegates;
  return [
    ...new Set([
      ...(profile.type === "team" ? profile.members.map((candidate) => candidate.id) : []),
      ...(profile.pluginAgentIds ?? []),
    ]),
  ];
}

/** Workbench projection of pending native Agent signals, never a second execution queue. */
export interface QueuedMessage {
  id: string;
  text: string;
  files: Array<{ type: "file"; url: string; mediaType: string; filename?: string }>;
  skills: string[];
  fileReferences: Array<{ id: string; filename: string; url: string; mediaType?: string }>;
  status: "queued" | "sending" | "failed";
  busy: boolean;
  error?: string;
}
export const messageQueueActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("remove") }).strict(),
  z.object({ action: z.literal("steer") }).strict(),
  z.object({ action: z.literal("retry") }).strict(),
  z.object({ action: z.literal("edit"), text: z.string().trim().max(100_000) }).strict(),
]);
export type MessageQueueAction = z.infer<typeof messageQueueActionSchema>;

const identifier = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const agentMemberSchema = z
  .object({
    id: identifier,
    name: z.string().trim().min(1),
    profession: z.string().default(""),
    description: z.string().default(""),
    instructions: z.string().trim().min(1),
    skills: z.array(z.string()).default([]),
    mcpServers: z.array(z.string()).default([]),
    memoryScope: z.enum(["thread", "resource"]).default("thread"),
    delegates: z.array(identifier).default([]),
    avatar: z.string().optional(),
  })
  .strict();

export type AgentMemberDefinition = z.infer<typeof agentMemberSchema>;

export const agentProfileDraftSchema = z.object({
  type: z.enum(["agent", "team"]),
  displayName: z.string().trim().min(1),
  profession: z.string(),
  description: z.string(),
  instructions: z.string().trim().min(1),
  skills: z.array(z.string()),
  mcpServers: z.array(z.string()).max(2000),
  members: z.array(agentMemberSchema),
  tags: z.array(z.string()),
  quickPrompts: z.array(z.string()),
});

export const agentProfilePatchSchema = agentProfileDraftSchema
  .partial()
  .extend({ enabled: z.boolean().optional() })
  .strict();

/**
 * Built-in supervisor roster. The same definitions drive the default profile,
 * the Explorer/Reviewer agents and the delegation prompt, so descriptions and
 * role instructions cannot drift apart.
 */
export const DEFAULT_AGENT_MEMBERS: AgentMemberDefinition[] = [
  {
    id: "explorer",
    name: "Explorer",
    profession: "探索专家",
    description: "快速搜集信息、探查环境与资料，并给出结构化汇总。",
    instructions:
      "你是探索专家 Explorer。围绕任务追踪相关证据，区分事实与推断，给出可直接供主管采用的结论和路径/行号。",
    skills: [],
    mcpServers: [],
    memoryScope: "thread",
    delegates: [],
  },
  {
    id: "reviewer",
    name: "Reviewer",
    profession: "审查专家",
    description: "审查代码变更、规范、边界条件与缺陷风险，给出针对性的改进建议。",
    instructions:
      "你是审查专家 Reviewer。根据任务检查正确性、边界条件和实际风险。核对上下文和调用方后再报告缺陷，说明触发条件、影响与证据。不要把个人风格偏好或测试样例的命名当成缺陷；没有实质问题就直接说明。",
    skills: [],
    mcpServers: [],
    memoryScope: "thread",
    delegates: [],
  },
];

export function defaultAgentMember(id: "explorer" | "reviewer"): AgentMemberDefinition {
  const member = DEFAULT_AGENT_MEMBERS.find((candidate) => candidate.id === id);
  if (!member) throw new Error(`Unknown default agent member: ${id}`);
  return member;
}

type AgentProfileType = "agent" | "team";

export interface AgentProfile {
  id: string;
  type: AgentProfileType;
  name: string;
  displayName: string;
  profession: string;
  description: string;
  instructions: string;
  skills: string[];
  mcpServers: string[];
  members: AgentMemberDefinition[];
  categoryId?: string;
  tags: string[];
  quickPrompts: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  plugin?: PluginBinding;
  pluginAgentIds?: string[];
}

/** Display names never identify an invocation: all links use these persisted IDs. */
export interface TeamInvocation {
  id: string;
  profileId: string;
  memberId: string;
  agentId: string;
  parentMemberId?: string;
  parentInvocationId?: string;
  runId: string;
  toolCallId: string;
  prompt: string;
  status: "running" | "suspended" | "completed" | "error";
  startedAt: string;
  endedAt?: string;
  text?: string;
  error?: string;
  /** Native model finish reason or terminal background-task status. */
  finishReason?: string;
  memoryThreadId?: string;
  memoryResourceId?: string;
}

/** A partial answer followed by another tool call or a token cutoff is not a final answer. */
export function isCompleteAgentResult(result: { text: string; finishReason?: string }): boolean {
  return (
    Boolean(result.text.trim()) &&
    !["aborted", "error", "tool-calls", "length", "content-filter"].includes(
      result.finishReason ?? "",
    )
  );
}

export function incompleteAgentResultMessage(finishReason?: string): string {
  if (finishReason === "aborted") return "Agent execution was interrupted before completion.";
  if (finishReason === "length") return "Agent response reached the model output limit.";
  if (finishReason === "content-filter") return "Agent response was stopped by the model filter.";
  if (finishReason === "error") return "Agent execution failed before completion.";
  return "Agent execution ended without a final answer.";
}

const agentFileOperationSchema = z.object({
  toolName: z.enum(["mastra_workspace_write_file", "mastra_workspace_edit_file"]),
  args: z.object({ path: z.string() }),
  isError: z.boolean().optional(),
});

/** Tool evidence is a record of operations, not proof that the deliverable works. */
export function summarizeAgentToolResults(results: readonly unknown[]) {
  const fileOperations = results.flatMap((value) => {
    const parsed = agentFileOperationSchema.safeParse(value);
    return parsed.success
      ? [{ tool: parsed.data.toolName, path: parsed.data.args.path, isError: parsed.data.isError }]
      : [];
  });
  return {
    toolResultCount: results.length,
    fileOperationCount: fileOperations.length,
    recentFileOperations: fileOperations.slice(-12),
  };
}

/** Streamed user signals carry their type in metadata, not on the message itself. */
export function isUserChatMessage(message: {
  role: string;
  content: { metadata?: { signal?: unknown } };
}): boolean {
  if (message.role === "user") return true;
  const signal = message.content.metadata?.signal;
  return (
    message.role === "signal" &&
    typeof signal === "object" &&
    signal !== null &&
    "type" in signal &&
    signal.type === "user"
  );
}

export function validateAgentTeam(profile: Pick<AgentProfile, "type" | "members">): void {
  if (profile.type !== "team") {
    if (profile.members.length) throw new Error("单 Agent 不能配置团队成员");
    return;
  }
  const members = new Map(profile.members.map((member) => [member.id, member]));
  if (!members.size || members.size !== profile.members.length)
    throw new Error("团队成员 ID 必须非空且唯一");
  const visited = new Set<string>();
  const visit = (id: string, path: string[]) => {
    const member = members.get(id);
    if (!member) throw new Error(`不存在的团队成员: ${id}`);
    if (path.includes(id)) throw new Error(`成员委派不能成环: ${[...path, id].join(" → ")}`);
    if (visited.has(id)) return;
    for (const target of member.delegates) visit(target, [...path, id]);
    visited.add(id);
  };
  for (const id of members.keys()) visit(id, []);
}

export const PERMISSION_RULES_CONTEXT_KEY = "mastra-work:permission-rules";

/** 提示建议:生成开关、模型与触发时机(空串沿用会话模型)。 */
export const SUGGESTION_STRATEGIES = ["request", "turn"] as const;
export type SuggestionStrategy = (typeof SUGGESTION_STRATEGIES)[number];
export const SuggestionConfigSchema = z
  .object({
    enabled: z.boolean(),
    model: z.string().max(512),
    strategy: z.enum(SUGGESTION_STRATEGIES).default("turn"),
  })
  .strict();
export type SuggestionConfig = z.infer<typeof SuggestionConfigSchema>;
export const DEFAULT_SUGGESTION_CONFIG: SuggestionConfig = {
  enabled: false,
  model: "",
  strategy: "turn",
};
export const MAX_PROMPT_SUGGESTIONS = 4;

export const SEARCH_ENGINES = ["tavily", "firecrawl", "anysearch"] as const;
export const SEARCH_DEPTHS = ["fast", "balanced", "deep"] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];
export type SearchDepth = (typeof SEARCH_DEPTHS)[number];

export const TOOL_CATEGORIES = [
  "read",
  "edit",
  "execute",
  "mcp",
  "other",
] as const satisfies readonly ToolCategory[];
export const PERMISSION_POLICIES = [
  "allow",
  "ask",
  "deny",
] as const satisfies readonly PermissionPolicy[];
export const DEFAULT_PERMISSION_RULES: PermissionRules = {
  categories: { read: "allow", edit: "allow", execute: "allow", mcp: "allow", other: "allow" },
  tools: { ask_user: "allow", submit_plan: "allow" },
};
export type { PermissionPolicy, PermissionRules, ToolCategory };
