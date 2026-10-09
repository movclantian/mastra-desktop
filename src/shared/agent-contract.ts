import type {
  PermissionPolicy,
  PermissionRules,
  ToolCategory,
} from "@mastra/core/agent-controller";
import { z } from "zod";

export const DEFAULT_AGENT_PROFILE_ID = "mastra-work-agent";
export const BACKGROUND_TASK_TIMEOUT_MS = 15 * 60_000;

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

/** Shared execution identity; consumers must not import the workflow implementation for it. */
export const TEAM_PROFILE_CONTEXT_KEY = "mastra-work:team-profile";

/** The same roster drives native agent tools, prompts and mode visibility. */
export function delegationMemberIds(
  profile: AgentProfile,
  member?: AgentMemberDefinition,
): string[] {
  if (member) return member.delegates;
  if (profile.id === DEFAULT_AGENT_PROFILE_ID) return ["explorer", "reviewer"];
  return profile.type === "team" && profile.workflow?.strategy === "supervisor"
    ? profile.members.map((candidate) => candidate.id)
    : [];
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
const conditionSchema = z
  .object({
    operator: z.enum(["contains", "equals", "not_contains"]),
    value: z.string().min(1),
  })
  .strict();

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

const stepBase = {
  id: identifier,
  prompt: z.string().optional(),
  context: z.enum(["request", "previous"]).default("previous"),
  retries: z.number().int().min(0).max(5).default(0),
};

const agentWorkflowStepSchema = z.discriminatedUnion("kind", [
  z.object({ ...stepBase, kind: z.literal("agent"), memberId: identifier }).strict(),
  z
    .object({
      ...stepBase,
      kind: z.literal("council"),
      memberIds: z.array(identifier).min(2),
      judgeMemberId: identifier,
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal("approval"),
      approval: z.object({ title: z.string().min(1), description: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      ...stepBase,
      kind: z.literal("branch"),
      condition: conditionSchema,
      branch: z.object({ onTrueMemberId: identifier, onFalseMemberId: identifier }).strict(),
    })
    .strict(),
  z
    .object({
      ...stepBase,
      kind: z.literal("loop"),
      memberId: identifier,
      condition: conditionSchema.optional(),
      loop: z.discriminatedUnion("mode", [
        z
          .object({
            mode: z.enum(["until", "while"]),
            maxIterations: z.number().int().min(1).max(20),
          })
          .strict(),
        z
          .object({
            mode: z.literal("foreach"),
            concurrency: z.number().int().min(1).max(8).default(1),
          })
          .strict(),
      ]),
    })
    .strict(),
]);

// Strategy selects the entry point. Councils and supervisors compose inside the graph.
export const agentWorkflowSchema = z
  .object({
    strategy: z.enum(["supervisor", "workflow", "handoff"]),
    entryMemberId: identifier.optional(),
    steps: z.array(agentWorkflowStepSchema),
  })
  .strict();

export type AgentMemberDefinition = z.infer<typeof agentMemberSchema>;
export type AgentWorkflowStep = z.infer<typeof agentWorkflowStepSchema>;
export type AgentWorkflowCondition = z.infer<typeof conditionSchema>;
type AgentWorkflowDefinition = z.infer<typeof agentWorkflowSchema>;
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
  workflow?: AgentWorkflowDefinition;
  categoryId?: string;
  tags: string[];
  quickPrompts: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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
  workflowRunId?: string;
  stepId?: string;
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

/** A partial answer followed by another tool call or a token cutoff is not a final handoff. */
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

export interface TeamHandoff {
  id: number;
  profileId: string;
  fromMemberId: string;
  toMemberId: string;
  reason: string;
  context: string;
  createdAt: string;
}

export interface TeamHandoffState {
  profileId: string;
  activeMemberId: string;
  history: TeamHandoff[];
}

export function validateAgentTeam(
  profile: Pick<AgentProfile, "type" | "members" | "workflow">,
): void {
  if (profile.type !== "team") {
    if (profile.members.length || profile.workflow)
      throw new Error("单 Agent 不能配置团队成员或流程");
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
  const definition = profile.workflow;
  if (!definition) throw new Error("团队必须选择执行方式");
  if (definition.strategy === "handoff") {
    if (!definition.entryMemberId || !members.has(definition.entryMemberId))
      throw new Error("交接团队必须指定有效的初始专家");
    if (definition.steps.length || profile.members.some((member) => member.delegates.length))
      throw new Error("交接团队由当前专家负责，不能配置主管委派或显式流程步骤");
    if (members.size < 2) throw new Error("交接团队至少需要两位专家");
  } else if (definition.entryMemberId) throw new Error("仅交接团队可指定初始专家");
  if (definition.strategy === "workflow" && !definition.steps.length)
    throw new Error("显式流程至少需要一个步骤");
  const ids = new Set<string>();
  for (const step of definition.steps) {
    const generated = [
      step.id,
      ...(step.kind === "council"
        ? [
            ...step.memberIds.map((id) => `${step.id}-${id}`),
            `${step.id}-opinions`,
            `${step.id}-synthesis`,
          ]
        : step.kind === "branch"
          ? [`${step.id}-true`, `${step.id}-false`, `${step.id}-merge`]
          : step.kind === "loop"
            ? [`${step.id}-items`, `${step.id}-merge`]
            : []),
    ];
    for (const id of generated) {
      if (["workflow-input", "workflow-result"].includes(id) || ids.has(id))
        throw new Error(`重复或保留的步骤 ID: ${id}`);
      ids.add(id);
    }
    const targets =
      step.kind === "approval"
        ? []
        : step.kind === "branch"
          ? [step.branch.onTrueMemberId, step.branch.onFalseMemberId]
          : step.kind === "council"
            ? [...step.memberIds, step.judgeMemberId]
            : [step.memberId];
    for (const id of targets)
      if (!members.has(id)) throw new Error(`步骤 ${step.id} 引用了不存在的成员 ${id}`);
    if (step.kind === "council" && new Set(step.memberIds).size !== step.memberIds.length)
      throw new Error(`评议 ${step.id} 的成员不能重复`);
    if (step.kind === "loop" && step.loop.mode !== "foreach" && !step.condition)
      throw new Error(`循环 ${step.id} 缺少条件`);
    if (step.kind === "loop" && step.loop.mode === "foreach" && step.condition)
      throw new Error(`foreach ${step.id} 不接受循环终止条件`);
  }
}

export const PERMISSION_RULES_CONTEXT_KEY = "mastra-work:permission-rules";
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
