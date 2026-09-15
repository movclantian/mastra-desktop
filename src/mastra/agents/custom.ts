import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Agent } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import { type AnyWorkflow, cloneStep, createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { getAppConfig, setAppConfig } from "../storage";
import { getManagedSkillsDirectory } from "../workspace";

export const AGENT_PROFILE_CONTEXT_KEY = "mastra-work:agent-profile";
export const DEFAULT_AGENT_PROFILE_ID = "mastra-work-agent";
const CONFIG_KEY = "agent-profiles";

export type AgentProfileType = "agent" | "team";

/**
 * The four coordination patterns used in Mastra's multi-agent guide.
 *
 * `handoff` and `council` are implemented with Workflow control flow, while
 * `supervisor` stays model-driven through Agent delegation and `workflow`
 * exposes the explicit graph controls.
 */
export type AgentWorkflowStrategy = "supervisor" | "handoff" | "workflow" | "council";

export type AgentWorkflowCondition = {
  operator: "contains" | "equals" | "not_contains";
  value: string;
};

export type AgentWorkflowStepKind = "agent" | "approval" | "branch" | "loop";

export interface AgentWorkflowStep {
  id: string;
  memberId?: string;
  kind?: AgentWorkflowStepKind;
  prompt?: string;
  retries?: number;
  condition?: AgentWorkflowCondition;
  branch?: { onTrueMemberId: string; onFalseMemberId: string };
  loop?: { mode: "until" | "while" | "foreach"; maxIterations: number; concurrency?: number };
  approval?: { title: string; description: string };
}

export interface AgentWorkflowDefinition {
  strategy: AgentWorkflowStrategy;
  steps: AgentWorkflowStep[];
  synthesis: boolean;
}

export interface AgentMemberDefinition {
  id: string;
  name: string;
  profession: string;
  description: string;
  instructions: string;
  skills: string[];
  memoryScope: "thread" | "resource";
}

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

const DEFAULT_PROFILE: AgentProfile = {
  id: DEFAULT_AGENT_PROFILE_ID,
  type: "agent",
  name: "MastraWork",
  displayName: "MastraWork",
  profession: "通用工作 Agent",
  description: "负责规划、执行和复查复杂工作任务的默认 Agent。",
  instructions: "",
  skills: [],
  members: [],
  workflow: undefined,
  tags: ["默认", "通用"],
  quickPrompts: [],
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function normalizeProfile(
  raw: Partial<AgentProfile>,
  now = new Date().toISOString(),
): AgentProfile {
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : randomUUID();
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
  const usedMemberIds = new Set<string>();
  return {
    ...DEFAULT_PROFILE,
    type: raw.type === "team" ? "team" : "agent",
    categoryId: raw.categoryId,
    avatar: raw.avatar,
    id,
    name,
    displayName:
      typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName.trim() : name,
    profession: typeof raw.profession === "string" ? raw.profession.trim() : "自定义 Agent",
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    instructions: typeof raw.instructions === "string" ? raw.instructions.trim() : "",
    skills: Array.isArray(raw.skills)
      ? raw.skills.filter((item): item is string => typeof item === "string")
      : [],
    members: Array.isArray(raw.members)
      ? raw.members
          .filter(
            (item): item is AgentMemberDefinition => typeof item === "object" && item !== null,
          )
          .map((item) => {
            const baseId =
              typeof item.id === "string" && item.id.trim() ? item.id.trim() : randomUUID();
            let memberId = baseId;
            let suffix = 2;
            while (usedMemberIds.has(memberId)) memberId = `${baseId}-${suffix++}`;
            usedMemberIds.add(memberId);
            return {
              id: memberId,
              name: typeof item.name === "string" ? item.name.trim() : "团队成员",
              profession: typeof item.profession === "string" ? item.profession.trim() : "",
              description: typeof item.description === "string" ? item.description.trim() : "",
              instructions: typeof item.instructions === "string" ? item.instructions.trim() : "",
              skills: Array.isArray(item.skills)
                ? item.skills.filter(
                    (skill): skill is string =>
                      typeof skill === "string" && skill.trim().length > 0,
                  )
                : [],
              memoryScope: item.memoryScope === "resource" ? "resource" : "thread",
            };
          })
      : [],
    workflow: raw.workflow === undefined ? undefined : agentWorkflowSchema.parse(raw.workflow),
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((item): item is string => typeof item === "string")
      : [],
    quickPrompts: Array.isArray(raw.quickPrompts)
      ? raw.quickPrompts.filter((item): item is string => typeof item === "string")
      : [],
    enabled: raw.enabled !== false,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

export const agentWorkflowSchema = z.object({
  strategy: z.enum(["supervisor", "handoff", "workflow", "council"]),
  steps: z.array(
    z.object({
      id: z.string(),
      memberId: z.string().optional(),
      kind: z.enum(["agent", "approval", "branch", "loop"]).optional(),
      prompt: z.string().optional(),
      retries: z.number().int().min(0).max(5).optional(),
      condition: z
        .object({
          operator: z.enum(["contains", "equals", "not_contains"]),
          value: z.string(),
        })
        .optional(),
      branch: z.object({ onTrueMemberId: z.string(), onFalseMemberId: z.string() }).optional(),
      loop: z
        .object({
          mode: z.enum(["until", "while", "foreach"]),
          maxIterations: z.number().int().min(1).max(20),
          concurrency: z.number().int().min(1).max(8).optional(),
        })
        .optional(),
      approval: z.object({ title: z.string(), description: z.string() }).optional(),
    }),
  ),
  synthesis: z.boolean(),
});

export async function listAgentProfiles(resourceId?: string): Promise<AgentProfile[]> {
  const raw = await getAppConfig(CONFIG_KEY, resourceId);
  if (!raw) return [DEFAULT_PROFILE];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const profiles = Array.isArray(parsed)
      ? parsed.map((item) => normalizeProfile(item as Partial<AgentProfile>))
      : [];
    return [
      DEFAULT_PROFILE,
      ...profiles.filter((profile) => profile.id !== DEFAULT_AGENT_PROFILE_ID && profile.enabled),
    ];
  } catch {
    return [DEFAULT_PROFILE];
  }
}

export async function getAgentProfile(
  id: string | undefined,
  resourceId?: string,
): Promise<AgentProfile> {
  const profiles = await listAgentProfiles(resourceId);
  return (
    profiles.find((profile) => profile.id === (id?.trim() || DEFAULT_AGENT_PROFILE_ID)) ??
    DEFAULT_PROFILE
  );
}

async function saveProfiles(profiles: AgentProfile[], resourceId?: string): Promise<void> {
  await setAppConfig(
    CONFIG_KEY,
    JSON.stringify(profiles.filter((profile) => profile.id !== DEFAULT_AGENT_PROFILE_ID)),
    resourceId,
  );
}

export async function upsertAgentProfile(
  input: Partial<AgentProfile>,
  resourceId?: string,
): Promise<AgentProfile> {
  if (input.id === DEFAULT_AGENT_PROFILE_ID) throw new Error("默认 Agent 不可覆盖");
  const current = (await listAgentProfiles(resourceId)).filter(
    (profile) => profile.id !== DEFAULT_AGENT_PROFILE_ID,
  );
  const existing = current.find((profile) => profile.id === input.id);
  const previousUpdatedAt = existing ? Date.parse(existing.updatedAt) : Number.NaN;
  const now = new Date(
    Math.max(Date.now(), Number.isFinite(previousUpdatedAt) ? previousUpdatedAt + 1 : 0),
  ).toISOString();
  const teamWorkflow =
    input.type === "team" && !input.workflow
      ? {
          strategy: "supervisor" as const,
          steps: (input.members ?? existing?.members ?? []).map((member, index) => ({
            id: `step-${index + 1}`,
            memberId: member.id,
          })),
          synthesis: true,
        }
      : undefined;
  const profile = normalizeProfile(
    {
      ...(existing ?? {}),
      ...input,
      ...(teamWorkflow ? { workflow: teamWorkflow } : {}),
      updatedAt: now,
    },
    existing?.createdAt ?? now,
  );
  if (profile.type === "team" && profile.workflow?.strategy !== "supervisor" && profile.workflow) {
    const { strategy, steps } = profile.workflow;
    if (!steps.length) throw new Error("团队工作流至少需要一个步骤");
    const ids = new Set<string>();
    const members = new Set(profile.members.map((member) => member.id));
    for (const step of steps) {
      if (!step.id.trim() || ids.has(step.id)) throw new Error("工作流步骤 ID 必须非空且唯一");
      ids.add(step.id);
      const kind = step.kind ?? "agent";
      if (strategy !== "workflow" && kind !== "agent")
        throw new Error("交接和并行评议只接受 Agent 步骤");
      const targets =
        kind === "branch"
          ? [step.branch?.onTrueMemberId, step.branch?.onFalseMemberId]
          : kind === "approval"
            ? []
            : [step.memberId];
      if (targets.some((id) => !id || !members.has(id)))
        throw new Error(`步骤 ${step.id} 引用了不存在的成员`);
      if (kind === "branch" && !step.condition) throw new Error(`分支 ${step.id} 缺少条件`);
      if (kind === "loop" && (!step.loop || (step.loop.mode !== "foreach" && !step.condition)))
        throw new Error(`循环 ${step.id} 缺少循环设置或条件`);
    }
  }
  await saveProfiles([...current.filter((item) => item.id !== profile.id), profile], resourceId);
  return profile;
}

export async function deleteAgentProfile(id: string, resourceId?: string): Promise<void> {
  if (id === DEFAULT_AGENT_PROFILE_ID) throw new Error("默认 Agent 不可删除");
  await saveProfiles(
    (await listAgentProfiles(resourceId)).filter((profile) => profile.id !== id),
    resourceId,
  );
  memberCache.delete(scopedProfileKey(id, resourceId));
}

type ProfileAgentFactory = (profile: AgentProfile, resourceScope?: string) => Agent;
type MemberAgentFactory = (
  profile: AgentProfile,
  member: AgentMemberDefinition,
  resourceScope?: string,
) => Agent;

let profileAgentFactory: ProfileAgentFactory | undefined;
let memberAgentFactory: MemberAgentFactory | undefined;

export function setProfileAgentFactories(factories: {
  profile: ProfileAgentFactory;
  member: MemberAgentFactory;
}): void {
  profileAgentFactory = factories.profile;
  memberAgentFactory = factories.member;
}

const memberCache = new Map<string, { updatedAt: string; agents: Record<string, Agent> }>();

function scopedProfileKey(id: string, resourceScope?: string): string {
  return `${resourceScope?.trim() || "__system__"}\u0000${id}`;
}

export async function resolveProfileMembers(
  profile: AgentProfile,
  resourceScope?: string,
): Promise<Record<string, Agent>> {
  if (profile.type !== "team") return {};
  const key = scopedProfileKey(profile.id, resourceScope);
  const cached = memberCache.get(key);
  if (cached?.updatedAt === profile.updatedAt) return cached.agents;
  if (!memberAgentFactory) throw new Error("Profile Agent factory is not initialized");
  const agents: Record<string, Agent> = {};
  for (const member of profile.members) {
    agents[member.id] = memberAgentFactory(profile, member, resourceScope);
  }
  memberCache.set(key, { updatedAt: profile.updatedAt, agents });
  return agents;
}

/**
 * Mastra's registry is process-wide, while profiles are resource-scoped. Keep
 * the registration key and Agent id tenant-qualified so two users can create
 * profiles with the same local id without colliding in `mastra.addAgent()`.
 */
function registrationScope(resourceScope?: string): string {
  return resourceScope?.trim() || "__system__";
}

function registrationToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function profileAgentRegistryKey(profile: AgentProfile, resourceScope?: string): string {
  return `profile-${registrationToken(registrationScope(resourceScope))}-${registrationToken(
    profile.id,
  )}`;
}

export function profileMemberAgentRegistryKey(
  profile: AgentProfile,
  memberId: string,
  resourceScope?: string,
): string {
  return `${profileAgentRegistryKey(profile, resourceScope)}-member-${registrationToken(memberId)}`;
}

export function profileAgentRuntimeId(
  profile: AgentProfile,
  memberId?: string,
  resourceScope?: string,
): string {
  const prefix = memberId ? "member" : "profile";
  return `${prefix}-${registrationToken(registrationScope(resourceScope))}-${registrationToken(
    profile.id,
  )}${memberId ? `-${registrationToken(memberId)}` : ""}`;
}

type AgentRegistry = Pick<Mastra, "addAgent" | "removeAgent" | "listAgents">;

export interface RegisteredProfileAgents {
  profile: Agent;
  members: Record<string, Agent>;
  profileKey: string;
  memberKeys: Record<string, string>;
}

const registeredProfiles = new Map<
  string,
  { updatedAt: string; registration: RegisteredProfileAgents }
>();
const registrationLocks = new Map<
  string,
  { updatedAt: string; promise: Promise<RegisteredProfileAgents> }
>();
const removedProfileKeys = new Set<string>();

function isRegistrationPresent(
  registry: AgentRegistry,
  registration: RegisteredProfileAgents,
): boolean {
  const agents = registry.listAgents();
  if (agents[registration.profileKey] !== registration.profile) return false;
  return Object.entries(registration.memberKeys).every(
    ([memberId, key]) => agents[key] === registration.members[memberId],
  );
}

function removeRegisteredProfileEntries(registry: AgentRegistry, profileKey: string): void {
  const memberPrefix = `${profileKey}-member-`;
  for (const key of Object.keys(registry.listAgents())) {
    if (key === profileKey || key.startsWith(memberPrefix)) registry.removeAgent(key);
  }
}

async function registerProfileAgents(
  registry: AgentRegistry,
  profile: AgentProfile,
  profileKey: string,
  resourceScope: string,
): Promise<RegisteredProfileAgents> {
  const cached = registeredProfiles.get(profileKey);
  if (
    cached?.updatedAt === profile.updatedAt &&
    isRegistrationPresent(registry, cached.registration)
  ) {
    return cached.registration;
  }

  if (cached) {
    removeRegisteredProfileEntries(registry, cached.registration.profileKey);
    registeredProfiles.delete(profileKey);
  }

  if (!profileAgentFactory) throw new Error("Profile Agent factory is not initialized");
  const profileAgent = profileAgentFactory(profile, resourceScope);
  const members = await resolveProfileMembers(profile, resourceScope);
  const memberKeys = Object.fromEntries(
    Object.keys(members).map((memberId) => [
      memberId,
      profileMemberAgentRegistryKey(profile, memberId, resourceScope),
    ]),
  );

  // Remove stale registry entries as well, so a hot reload or process-level
  // cache reset cannot turn a valid profile save into a duplicate-key error.
  if (removedProfileKeys.has(profileKey)) {
    removeRegisteredProfileEntries(registry, profileKey);
    throw new Error("Profile Agent was removed during registration");
  }
  removeRegisteredProfileEntries(registry, profileKey);
  registry.addAgent(profileAgent, profileKey);
  for (const [memberId, member] of Object.entries(members)) {
    registry.addAgent(member, memberKeys[memberId]);
  }

  const registration = { profile: profileAgent, members, profileKey, memberKeys };
  const agents = registry.listAgents();
  if (agents[profileKey] !== profileAgent) {
    throw new Error(`Profile Agent registration was not accepted for key ${profileKey}`);
  }
  for (const [memberId, key] of Object.entries(memberKeys)) {
    if (agents[key] !== members[memberId]) {
      throw new Error(`Team member registration was not accepted for ${memberId}`);
    }
  }
  registeredProfiles.set(profileKey, { updatedAt: profile.updatedAt, registration });
  return registration;
}

/**
 * Create and register a real Profile Agent and all of its Team members.
 * Registration is idempotent for an unchanged profile and replaces the
 * previous instance after a profile edit. The returned Profile Agent is the
 * object that chat/session routes must execute, rather than the default Agent.
 */
export async function ensureProfileAgentsRegistered(
  registry: AgentRegistry,
  profile: AgentProfile,
  resourceScope?: string,
): Promise<RegisteredProfileAgents> {
  if (profile.id === DEFAULT_AGENT_PROFILE_ID) {
    const defaultAgent = Object.values(registry.listAgents()).find(
      (agent) => agent.id === DEFAULT_AGENT_PROFILE_ID,
    );
    if (!defaultAgent) throw new Error("Default work agent is not registered");
    return {
      profile: defaultAgent,
      members: {},
      profileKey: DEFAULT_AGENT_PROFILE_ID,
      memberKeys: {},
    };
  }
  const normalizedScope = registrationScope(resourceScope);
  const profileKey = profileAgentRegistryKey(profile, normalizedScope);
  removedProfileKeys.delete(profileKey);
  const cached = registeredProfiles.get(profileKey);
  if (
    cached?.updatedAt === profile.updatedAt &&
    isRegistrationPresent(registry, cached.registration)
  ) {
    return cached.registration;
  }

  const active = registrationLocks.get(profileKey);
  if (active?.updatedAt === profile.updatedAt) return active.promise;

  const promise = active
    ? active.promise
        .catch(() => undefined)
        .then(() => registerProfileAgents(registry, profile, profileKey, normalizedScope))
    : registerProfileAgents(registry, profile, profileKey, normalizedScope);
  registrationLocks.set(profileKey, { updatedAt: profile.updatedAt, promise });
  try {
    return await promise;
  } finally {
    if (registrationLocks.get(profileKey)?.promise === promise) {
      registrationLocks.delete(profileKey);
    }
  }
}

/** Remove a profile and all registered Team members from Mastra. */
export function unregisterProfileAgents(
  registry: AgentRegistry,
  profileId: string,
  resourceScope?: string,
): void {
  const prefix = `profile-${registrationToken(registrationScope(resourceScope))}-${registrationToken(profileId)}`;
  removedProfileKeys.add(prefix);
  memberCache.delete(scopedProfileKey(profileId, resourceScope));
  removeRegisteredProfileEntries(registry, prefix);
  for (const [key] of registeredProfiles) {
    if (key !== prefix) continue;
    registeredProfiles.delete(key);
  }
}

export async function resolveManagedSkillPaths(
  names: string[],
  resourceId?: string,
): Promise<string[]> {
  const requested = new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean));
  if (requested.size === 0) return [];
  const root = getManagedSkillsDirectory(resourceId);
  const entries = await readdir(root, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    try {
      const content = await readFile(join(directory, "SKILL.md"), "utf8");
      const metadataName = /^---\s*[\s\S]*?\bname:\s*["']?([^\r\n"']+)/m.exec(content)?.[1]?.trim();
      if (
        requested.has(entry.name.toLowerCase()) ||
        (metadataName && requested.has(metadataName.toLowerCase()))
      ) {
        paths.push(directory);
      }
    } catch {
      // Invalid skill directories are excluded from a profile instead of breaking the run.
    }
  }
  return paths;
}

/** Read an explicitly activated managed skill from the current resource scope. */
export async function loadManagedSkill(
  name: string,
  resourceId?: string,
): Promise<{ name: string; instructions: string } | undefined> {
  const [directory] = await resolveManagedSkillPaths([name], resourceId);
  if (!directory) return undefined;
  const content = await readFile(join(directory, "SKILL.md"), "utf8");
  const metadataName = /^---\s*[\s\S]*?\bname:\s*["']?([^\r\n"']+)/m.exec(content)?.[1]?.trim();
  return {
    name: metadataName || basename(directory),
    instructions: content.replace(/^---\s*[\s\S]*?\s*---\s*/, "").trim(),
  };
}

// Every team stage carries the original request and its latest result. In particular,
// native loops feed their output back into the same input schema on every iteration.
const teamStageSchema = z.object({ request: z.string(), text: z.string() });
type TeamStage = z.infer<typeof teamStageSchema>;

function conditionMatches(text: string, condition?: AgentWorkflowCondition): boolean {
  if (!condition) return true;
  if (condition.operator === "equals") return text.trim() === condition.value.trim();
  const contains = text.toLowerCase().includes(condition.value.toLowerCase());
  return condition.operator === "not_contains" ? !contains : contains;
}

function createApprovalWorkflowStep(step: AgentWorkflowStep) {
  const title = step.approval?.title || "人工审批";
  const description = step.approval?.description || "请确认是否继续工作流。";
  return createStep({
    id: step.id,
    inputSchema: teamStageSchema,
    outputSchema: teamStageSchema,
    resumeSchema: z.object({ approved: z.boolean(), feedback: z.string().optional() }),
    suspendSchema: z.object({ title: z.string(), description: z.string() }),
    execute: async ({ inputData, resumeData, suspend, bail }) => {
      if (!resumeData) return await suspend({ title, description });
      if (!resumeData.approved) return bail(inputData);
      return inputData;
    },
  });
}

/** Compose native Workflow steps; no application run loop or workflow state machine. */
export async function buildProfileWorkflow(
  profile: AgentProfile,
  resourceScope?: string,
): Promise<{ workflow: AnyWorkflow } | undefined> {
  const definition = profile.workflow;
  if (profile.type !== "team" || !definition || definition.strategy === "supervisor")
    return undefined;
  if (definition.steps.length === 0) throw new Error("Team workflow requires at least one step");
  const members = await resolveProfileMembers(profile, resourceScope);
  const workflowId = `team-${profileAgentRegistryKey(profile, resourceScope)}`;
  const stage = (step: AgentWorkflowStep, memberId = step.memberId, id = step.id) => {
    const member = memberId ? members[memberId] : undefined;
    if (!member) throw new Error(`Workflow step "${step.id}" references a missing member`);
    return createWorkflow({
      id: `${workflowId}-${id}`,
      inputSchema: teamStageSchema,
      outputSchema: teamStageSchema,
    })
      .map(
        async ({ inputData }) => ({
          prompt: `${step.prompt || "继续处理这个任务"}: ${inputData.request}\n\n上一步结果: ${inputData.text}`,
        }),
        { id: "input" },
      )
      .then(cloneStep(createStep(member, { retries: step.retries ?? 0 }), { id: "agent" }))
      .map(
        async ({ inputData, getInitData }) => ({
          request: getInitData<TeamStage>().request,
          text: inputData.text,
        }),
        { id: "result" },
      )
      .commit();
  };
  const mergeResults = async ({
    inputData,
    getInitData,
  }: {
    inputData: Record<string, TeamStage | undefined> | TeamStage[];
    getInitData: () => { request: string };
  }): Promise<TeamStage> => ({
    request: getInitData().request,
    text: Object.values(inputData)
      .flatMap((result) => (result ? [result.text] : []))
      .join("\n\n"),
  });
  let flow: AnyWorkflow = createWorkflow({
    id: workflowId,
    description: `${profile.displayName} 的可执行协作流程`,
    inputSchema: z.object({ request: z.string().min(1) }),
    outputSchema: z.object({ text: z.string() }),
  }).map(async ({ inputData }) => ({ request: inputData.request, text: inputData.request }), {
    id: "workflow-input",
  });

  if (definition.strategy === "council") {
    flow = flow
      .parallel(definition.steps.map((step) => stage(step)))
      .map(mergeResults, { id: "parallel-result" });
  } else {
    for (const step of definition.steps) {
      const kind = definition.strategy === "handoff" ? "agent" : (step.kind ?? "agent");
      if (kind === "approval") {
        flow = flow.then(createApprovalWorkflowStep(step));
      } else if (kind === "branch") {
        if (!step.branch || !step.condition)
          throw new Error(`Branch "${step.id}" requires targets and a condition`);
        flow = flow
          .branch([
            [
              async ({ inputData }: { inputData: TeamStage }) =>
                conditionMatches(inputData.text, step.condition),
              stage(step, step.branch.onTrueMemberId, `${step.id}-true`),
            ],
            [
              async ({ inputData }: { inputData: TeamStage }) =>
                !conditionMatches(inputData.text, step.condition),
              stage(step, step.branch.onFalseMemberId, `${step.id}-false`),
            ],
          ])
          .map(mergeResults, { id: `${step.id}-merge` });
      } else if (kind === "loop") {
        const loop = step.loop;
        if (!loop) throw new Error(`Loop "${step.id}" requires loop settings`);
        const body = stage(step);
        if (loop.mode === "foreach") {
          flow = flow
            .map(
              async ({ inputData }: { inputData: TeamStage }) =>
                inputData.request
                  .split(/\r?\n/)
                  .map((request) => request.trim())
                  .filter(Boolean)
                  .map((request) => ({ request, text: inputData.text })),
              { id: `${step.id}-items` },
            )
            .foreach(body, { concurrency: loop.concurrency ?? 1 })
            .map(mergeResults, { id: `${step.id}-merge` });
        } else {
          if (!step.condition) throw new Error(`Loop "${step.id}" requires a condition`);
          const condition = async ({
            inputData,
            iterationCount,
          }: {
            inputData: TeamStage;
            iterationCount: number;
          }) =>
            loop.mode === "while"
              ? conditionMatches(inputData.text, step.condition) &&
                iterationCount < loop.maxIterations
              : conditionMatches(inputData.text, step.condition) ||
                iterationCount >= loop.maxIterations;
          flow =
            loop.mode === "while" ? flow.dowhile(body, condition) : flow.dountil(body, condition);
        }
      } else {
        flow = flow.then(stage(step));
      }
    }
  }
  if (definition.synthesis) {
    if (!profileAgentFactory) throw new Error("Profile Agent factory is not initialized");
    // The synthesizer must not expose the same workflow recursively.
    const synthesizer = profileAgentFactory({ ...profile, workflow: undefined }, resourceScope);
    flow = flow
      .map(
        async ({ inputData }: { inputData: TeamStage }) => ({
          prompt: `请汇总以下团队结果并给出最终答复。原始请求: ${inputData.request}\n\n团队结果: ${inputData.text}`,
        }),
        { id: "synthesis-input" },
      )
      .then(cloneStep(createStep(synthesizer), { id: "synthesis" }));
  }
  return {
    workflow: flow
      .map(async ({ inputData }: { inputData: { text: string } }) => ({ text: inputData.text }), {
        id: "workflow-result",
      })
      .commit(),
  };
}
