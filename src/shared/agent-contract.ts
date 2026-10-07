import { z } from "zod";

export const DEFAULT_AGENT_PROFILE_ID = "mastra-work-agent";

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

export const agentWorkflowStepSchema = z.discriminatedUnion("kind", [
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
export type AgentWorkflowDefinition = z.infer<typeof agentWorkflowSchema>;
export type AgentProfileType = "agent" | "team";

export interface AgentProfile {
  id: string;
  type: AgentProfileType;
  name: string;
  displayName: string;
  profession: string;
  description: string;
  instructions: string;
  skills: string[];
  members: AgentMemberDefinition[];
  workflow?: AgentWorkflowDefinition;
  categoryId?: string;
  tags: string[];
  quickPrompts: string[];
  avatar?: string;
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
  memoryThreadId?: string;
  memoryResourceId?: string;
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
