import { createHash, randomUUID } from "node:crypto";
import type { Agent } from "@mastra/core/agent";
import type { Mastra } from "@mastra/core/mastra";
import { resolveAgentSkills } from "@mastra/core/skills";
import type { AnyWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  type AgentMemberDefinition,
  type AgentProfile,
  agentMemberSchema,
  agentWorkflowSchema,
  DEFAULT_AGENT_PROFILE_ID,
  TEAM_PROFILE_CONTEXT_KEY,
  validateAgentTeam,
} from "../../shared/agent-contract";
import { workError } from "../errors";
import { listPluginSkills } from "../plugins/registry";
import { appStorage, getAppConfig, setAppConfig } from "../storage/database";
import { compileTeamWorkflow } from "./team-workflow";

export const AGENT_PROFILE_CONTEXT_KEY = "mastra-work:agent-profile";
export { DEFAULT_AGENT_PROFILE_ID } from "../../shared/agent-contract";

const CONFIG_KEY = "agent-profiles";

export type { AgentMemberDefinition, AgentProfile } from "../../shared/agent-contract";
export { agentWorkflowSchema } from "../../shared/agent-contract";

type AgentProfileInput = Omit<Partial<AgentProfile>, "members"> & {
  members?: Partial<AgentMemberDefinition>[];
};

const DEFAULT_PROFILE: AgentProfile = {
  id: DEFAULT_AGENT_PROFILE_ID,
  type: "agent",
  name: "MastraWork",
  displayName: "MastraWork",
  profession: "通用工作 Agent",
  description: "负责规划、执行和复查复杂工作任务的默认 Agent。",
  instructions: "",
  skills: [],
  mcpServers: [],
  members: [],
  workflow: undefined,
  tags: ["默认", "通用"],
  quickPrompts: [],
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function normalizeProfile(raw: AgentProfileInput, now = new Date().toISOString()): AgentProfile {
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : randomUUID();
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
  return {
    ...DEFAULT_PROFILE,
    type: raw.type === "team" ? "team" : "agent",
    categoryId: raw.categoryId,
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
    members: (raw.members ?? []).map((member) => agentMemberSchema.parse(member)),
    mcpServers: z.array(z.string()).parse(raw.mcpServers ?? []),
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

export async function listAgentProfiles(resourceId?: string): Promise<AgentProfile[]> {
  const raw = await getAppConfig(CONFIG_KEY, resourceId);
  if (!raw) return [DEFAULT_PROFILE];
  const profiles = z
    .array(z.unknown())
    .parse(JSON.parse(raw))
    .map((item) => {
      try {
        const profile = normalizeProfile(item as AgentProfileInput);
        validateAgentTeam(profile);
        return profile;
      } catch (cause) {
        throw workError("VALIDATION_FAILED", {
          text: `Agent 配置不符合当前格式，请删除并重建: ${String((item as AgentProfileInput)?.id ?? "unknown")}`,
          cause,
        });
      }
    });
  return [
    DEFAULT_PROFILE,
    ...profiles.filter((profile) => profile.id !== DEFAULT_AGENT_PROFILE_ID),
  ];
}

export async function getAgentProfile(
  id: string | undefined,
  resourceId?: string,
): Promise<AgentProfile> {
  const selectedId = id?.trim() || DEFAULT_AGENT_PROFILE_ID;
  if (selectedId === DEFAULT_AGENT_PROFILE_ID) return DEFAULT_PROFILE;
  const raw = await getAppConfig(CONFIG_KEY, resourceId);
  const selected = raw
    ? z
        .array(z.object({ id: z.string() }).passthrough())
        .parse(JSON.parse(raw))
        .find((item) => item.id === selectedId)
    : undefined;
  const profile = selected ? normalizeProfile(selected) : undefined;
  if (!profile?.enabled) throw workError("VALIDATION_FAILED", { text: "Agent 不存在或已停用" });
  validateAgentTeam(profile);
  return profile;
}

async function saveProfiles(profiles: AgentProfile[], resourceId?: string): Promise<void> {
  await setAppConfig(
    CONFIG_KEY,
    JSON.stringify(profiles.filter((profile) => profile.id !== DEFAULT_AGENT_PROFILE_ID)),
    resourceId,
  );
}

// Profiles share one per-user config record, so all read/modify/write operations share its lock.
const profileWrites = new Map<string, Promise<unknown>>();
async function withProfileWrite<T>(
  resourceId: string | undefined,
  action: () => Promise<T>,
): Promise<T> {
  if (!resourceId?.trim()) throw workError("AUTH_REQUIRED");
  const pending = (profileWrites.get(resourceId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(action);
  profileWrites.set(resourceId, pending);
  try {
    return await pending;
  } finally {
    if (profileWrites.get(resourceId) === pending) profileWrites.delete(resourceId);
  }
}

async function assertProfileIdle(id: string, resourceId?: string) {
  const store = await appStorage.getStore("workflows");
  const runs = await store?.listWorkflowRuns({ resourceId, perPage: false });
  for (const run of runs?.runs ?? []) {
    if (!run.workflowName.startsWith("team-")) continue;
    const snapshot = typeof run.snapshot === "string" ? JSON.parse(run.snapshot) : run.snapshot;
    if (
      snapshot?.requestContext?.[TEAM_PROFILE_CONTEXT_KEY]?.id === id &&
      ["pending", "running", "waiting", "suspended", "paused"].includes(snapshot.status)
    )
      throw workError("VALIDATION_FAILED", {
        text: "请先完成或取消该团队的流程，再修改或删除团队",
      });
  }
}

/** Discover metadata only. Creating an Agent must not connect to MCP servers or run tools. */
export async function getAgentCapabilityCatalog(resourceId: string) {
  if (!resourceId?.trim()) throw workError("AUTH_REQUIRED");
  const { getMcpConfig, summarizeMcpServer } = await import("../connections/mcp");
  const [skills, config] = await Promise.all([
    listPluginSkills(resourceId),
    getMcpConfig(resourceId),
  ]);
  const servers = await Promise.all(
    config.servers
      .filter((server) => server.enabled && !server.builtin)
      .map((server) => summarizeMcpServer(server, resourceId)),
  );
  return {
    skills: skills
      .filter((skill) => skill.enabled)
      .map((skill) => ({
        id: skill.id,
        name: skill.displayName,
        description: skill.description,
      })),
    mcpServers: servers
      .filter((server) => !server.configurationError && !server.connectionError)
      .map((server) => ({
        id: server.id,
        name: server.name,
        tools: Object.entries(server.tools ?? {}).map(([name, tool]) => ({
          name,
          description: tool.description,
        })),
      })),
  };
}

function validateProfileCapabilities(
  target: Pick<AgentProfile, "skills" | "mcpServers">,
  catalog: Awaited<ReturnType<typeof getAgentCapabilityCatalog>>,
  previous?: Pick<AgentProfile, "skills" | "mcpServers">,
) {
  for (const key of ["skills", "mcpServers"] as const) {
    const ids = z.array(z.string()).max(2000).parse(target[key]);
    const available = new Set(catalog[key].map((item) => item.id));
    const invalid = ids.filter((id) => !available.has(id) && !previous?.[key].includes(id));
    if (invalid.length)
      throw workError("VALIDATION_FAILED", {
        text: `${key === "skills" ? "Skill" : "MCP"} 不存在、已停用或不可用，请刷新能力列表后重试: ${invalid.join(", ")}`,
      });
    target[key] = [...new Set(ids)];
  }
}

export async function createAgentProfile(
  input: Omit<AgentProfileInput, "id" | "createdAt" | "updatedAt">,
  resourceId?: string,
): Promise<AgentProfile> {
  if (!resourceId?.trim()) throw workError("AUTH_REQUIRED");
  return withProfileWrite(resourceId, async () => {
    const profile = normalizeProfile({ ...input, id: randomUUID() });
    try {
      validateAgentTeam(profile);
    } catch (cause) {
      throw workError("VALIDATION_FAILED", {
        text: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    }
    const catalog = await getAgentCapabilityCatalog(resourceId);
    for (const target of [profile, ...profile.members])
      validateProfileCapabilities(target, catalog);
    const current = await listAgentProfiles(resourceId);
    await saveProfiles([...current, profile], resourceId);
    return profile;
  });
}

export async function deleteAgentProfile(id: string, resourceId?: string): Promise<void> {
  if (id === DEFAULT_AGENT_PROFILE_ID)
    throw workError("VALIDATION_FAILED", { text: "默认 Agent 不可删除" });
  return withProfileWrite(resourceId, async () => {
    await assertProfileIdle(id, resourceId);
    // Deletion must also work for invalid definitions, without interpreting an obsolete graph.
    const raw = await getAppConfig(CONFIG_KEY, resourceId);
    const profiles = z
      .array(z.object({ id: z.string() }).passthrough())
      .parse(JSON.parse(raw ?? "[]"));
    await setAppConfig(
      CONFIG_KEY,
      JSON.stringify(profiles.filter((profile) => profile.id !== id)),
      resourceId,
    );
    memberCache.delete(scopedProfileKey(id, resourceId));
  });
}

export async function setAgentProfileCapabilities(
  id: string,
  skills: string[],
  mcpServers: string[],
  memberId: string | undefined,
  resourceId: string,
): Promise<AgentProfile> {
  if (id === DEFAULT_AGENT_PROFILE_ID)
    throw workError("VALIDATION_FAILED", {
      text: "The default Agent uses all enabled skills and MCP servers",
    });
  return withProfileWrite(resourceId, async () => {
    await assertProfileIdle(id, resourceId);
    const profiles = await listAgentProfiles(resourceId);
    const profile = profiles.find((item) => item.id === id);
    if (!profile) throw workError("VALIDATION_FAILED", { text: "Agent not found" });
    const target = memberId ? profile.members.find((item) => item.id === memberId) : profile;
    if (!target) throw workError("VALIDATION_FAILED", { text: "Agent member not found" });
    const selection = { skills, mcpServers };
    validateProfileCapabilities(selection, await getAgentCapabilityCatalog(resourceId), target);
    Object.assign(target, selection);
    profile.updatedAt = new Date().toISOString();
    await saveProfiles(profiles, resourceId);
    return profile;
  });
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

export function resolveProfileMembers(
  profile: AgentProfile,
  resourceScope?: string,
): Record<string, Agent> {
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

function profileAgentRegistryKey(profile: AgentProfile, resourceScope?: string): string {
  return `profile-${registrationToken(registrationScope(resourceScope))}-${registrationToken(
    profile.id,
  )}-${registrationToken(profile.updatedAt)}`;
}

function profileMemberAgentRegistryKey(
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
  )}-${registrationToken(profile.updatedAt)}${memberId ? `-${registrationToken(memberId)}` : ""}`;
}

type AgentRegistry = Pick<
  Mastra,
  "addAgent" | "removeAgent" | "listAgents" | "addWorkflow" | "removeWorkflow"
>;

export interface RegisteredProfileAgents {
  profile: Agent;
  members: Record<string, Agent>;
  profileKey: string;
  memberKeys: Record<string, string>;
  workflow?: AnyWorkflow;
}

const registeredProfiles = new Map<
  string,
  { updatedAt: string; registration: RegisteredProfileAgents }
>();

/** Registration has no await boundary: factories and native registry writes are synchronous. */
export function ensureProfileAgentsRegistered(
  registry: AgentRegistry,
  profile: AgentProfile,
  resourceScope?: string,
): RegisteredProfileAgents {
  if (profile.id === DEFAULT_AGENT_PROFILE_ID) {
    const agent = Object.values(registry.listAgents()).find(
      (candidate) => candidate.id === DEFAULT_AGENT_PROFILE_ID,
    );
    if (!agent) throw new Error("Default work agent is not registered");
    return { profile: agent, members: {}, profileKey: DEFAULT_AGENT_PROFILE_ID, memberKeys: {} };
  }
  const profileKey = profileAgentRegistryKey(profile, resourceScope);
  const cached = registeredProfiles.get(profileKey);
  if (cached?.updatedAt === profile.updatedAt) return cached.registration;
  if (!profileAgentFactory) throw new Error("Profile Agent factory is not initialized");
  const profileAgent = profileAgentFactory(profile, resourceScope);
  const members = resolveProfileMembers(profile, resourceScope);
  const memberKeys = Object.fromEntries(
    Object.keys(members).map((id) => [
      id,
      profileMemberAgentRegistryKey(profile, id, resourceScope),
    ]),
  );
  const workflow =
    profile.type === "team" && profile.workflow?.steps.length
      ? compileTeamWorkflow(profile, members, `team-${profileKey}`)
      : undefined;
  memberCache.set(scopedProfileKey(profile.id, resourceScope), {
    updatedAt: profile.updatedAt,
    agents: members,
  });
  registry.addAgent(profileAgent, profileKey);
  for (const [id, agent] of Object.entries(members)) registry.addAgent(agent, memberKeys[id]);
  if (workflow) registry.addWorkflow(workflow);
  const registration = { profile: profileAgent, members, profileKey, memberKeys, workflow };
  registeredProfiles.set(profileKey, { updatedAt: profile.updatedAt, registration });
  return registration;
}

export function unregisterProfileAgents(
  registry: AgentRegistry,
  profileId: string,
  resourceScope?: string,
): void {
  const key = `profile-${registrationToken(registrationScope(resourceScope))}-${registrationToken(profileId)}`;
  for (const [registeredKey, { registration }] of registeredProfiles) {
    if (!registeredKey.startsWith(`${key}-`)) continue;
    if (registration.workflow) registry.removeWorkflow(registration.workflow.id);
    registry.removeAgent(registration.profileKey);
    for (const memberKey of Object.values(registration.memberKeys)) registry.removeAgent(memberKey);
    registeredProfiles.delete(registeredKey);
  }
  memberCache.delete(scopedProfileKey(profileId, resourceScope));
}

export async function resolveManagedSkillPaths(
  names: string[] | undefined,
  resourceId?: string,
): Promise<string[]> {
  const requested = names ? new Set(names) : undefined;
  if (requested?.size === 0) return [];
  return (await listPluginSkills(resourceId))
    .filter((skill) => skill.enabled && (!requested || requested.has(skill.id)))
    .map((skill) => skill.path);
}

/** Read an explicitly activated managed skill through the native skill resolver. */
export async function loadManagedSkill(name: string, resourceId?: string) {
  const skill = (await listPluginSkills(resourceId)).find(
    (item) => item.id === name && item.enabled,
  );
  if (!skill) throw workError("VALIDATION_FAILED", { text: "所选技能不存在或已停用，请重新选择" });
  const resolved = await resolveAgentSkills([skill.path]).get(skill.name);
  if (!resolved)
    throw workError("VALIDATION_FAILED", { text: `无法读取所选技能：${skill.displayName}` });
  return { ...resolved, displayName: skill.displayName };
}
