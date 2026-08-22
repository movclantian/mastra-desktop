import { Agent, type SubAgent } from "@mastra/core/agent";
import { getAppConfig, setAppConfig } from "../storage";
import { resolveConfiguredModel, resolveDefaultModelId } from "../models";

export const AGENT_PROFILE_CONTEXT_KEY = "mastra-work:agent-profile";
export const DEFAULT_AGENT_PROFILE_ID = "mastra-work-agent";
const CONFIG_KEY = "agent-profiles";

export type AgentProfileType = "agent" | "team";

export interface AgentMemberDefinition {
  id: string;
  name: string;
  profession: string;
  description: string;
  instructions: string;
  model?: { providerId: string; modelId: string };
}

export interface AgentProfile {
  id: string;
  type: AgentProfileType;
  name: string;
  displayName: string;
  profession: string;
  description: string;
  instructions: string;
  model?: { providerId: string; modelId: string };
  skills: string[];
  members: AgentMemberDefinition[];
  workflow: string;
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
  workflow: "",
  tags: ["默认", "通用"],
  quickPrompts: [],
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function normalizeProfile(raw: Partial<AgentProfile>, now = new Date().toISOString()): AgentProfile {
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : crypto.randomUUID();
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
  return {
    ...DEFAULT_PROFILE,
    ...raw,
    id,
    name,
    displayName:
      typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName.trim() : name,
    profession: typeof raw.profession === "string" ? raw.profession.trim() : "自定义 Agent",
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    instructions: typeof raw.instructions === "string" ? raw.instructions.trim() : "",
    skills: Array.isArray(raw.skills) ? raw.skills.filter((item): item is string => typeof item === "string") : [],
    members: Array.isArray(raw.members)
      ? raw.members
          .filter((item): item is AgentMemberDefinition => typeof item === "object" && item !== null)
          .map((item) => ({
            id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : crypto.randomUUID(),
            name: typeof item.name === "string" ? item.name.trim() : "团队成员",
            profession: typeof item.profession === "string" ? item.profession.trim() : "",
            description: typeof item.description === "string" ? item.description.trim() : "",
            instructions: typeof item.instructions === "string" ? item.instructions.trim() : "",
            ...(item.model && typeof item.model.providerId === "string" && typeof item.model.modelId === "string"
              ? { model: { providerId: item.model.providerId, modelId: item.model.modelId } }
              : {}),
          }))
      : [],
    workflow: typeof raw.workflow === "string" ? raw.workflow.trim() : "",
    tags: Array.isArray(raw.tags) ? raw.tags.filter((item): item is string => typeof item === "string") : [],
    quickPrompts: Array.isArray(raw.quickPrompts)
      ? raw.quickPrompts.filter((item): item is string => typeof item === "string")
      : [],
    enabled: raw.enabled !== false,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

export async function listAgentProfiles(): Promise<AgentProfile[]> {
  const raw = await getAppConfig(CONFIG_KEY);
  if (!raw) return [DEFAULT_PROFILE];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const profiles = Array.isArray(parsed) ? parsed.map((item) => normalizeProfile(item as Partial<AgentProfile>)) : [];
    return [DEFAULT_PROFILE, ...profiles.filter((profile) => profile.id !== DEFAULT_AGENT_PROFILE_ID && profile.enabled)];
  } catch {
    return [DEFAULT_PROFILE];
  }
}

export async function getAgentProfile(id: string | undefined): Promise<AgentProfile> {
  const profiles = await listAgentProfiles();
  return profiles.find((profile) => profile.id === (id?.trim() || DEFAULT_AGENT_PROFILE_ID)) ?? DEFAULT_PROFILE;
}

async function saveProfiles(profiles: AgentProfile[]): Promise<void> {
  await setAppConfig(CONFIG_KEY, JSON.stringify(profiles.filter((profile) => profile.id !== DEFAULT_AGENT_PROFILE_ID)));
}

export async function upsertAgentProfile(input: Partial<AgentProfile>): Promise<AgentProfile> {
  if (input.id === DEFAULT_AGENT_PROFILE_ID) throw new Error("默认 Agent 不可覆盖");
  const current = (await listAgentProfiles()).filter((profile) => profile.id !== DEFAULT_AGENT_PROFILE_ID);
  const existing = current.find((profile) => profile.id === input.id);
  const profile = normalizeProfile({ ...(existing ?? {}), ...input }, existing?.createdAt);
  await saveProfiles([...current.filter((item) => item.id !== profile.id), profile]);
  return profile;
}

export async function deleteAgentProfile(id: string): Promise<void> {
  if (id === DEFAULT_AGENT_PROFILE_ID) throw new Error("默认 Agent 不可删除");
  await saveProfiles((await listAgentProfiles()).filter((profile) => profile.id !== id));
}

async function resolveProfileModel(model: AgentProfile["model"]): Promise<unknown> {
  if (!model) return resolveDefaultModelId();
  return (await resolveConfiguredModel(model.providerId, model.modelId)) ?? (await resolveDefaultModelId());
}

const memberCache = new Map<string, { updatedAt: string; agents: Record<string, SubAgent> }>();

export async function resolveProfileMembers(profile: AgentProfile): Promise<Record<string, SubAgent>> {
  if (profile.type !== "team") return {};
  const cached = memberCache.get(profile.id);
  if (cached?.updatedAt === profile.updatedAt) return cached.agents;
  const agents: Record<string, SubAgent> = {};
  for (const member of profile.members) {
    agents[member.id] = new Agent({
      id: member.id,
      name: member.name,
      description: member.description || member.profession,
      instructions: member.instructions || `你是团队成员 ${member.name},负责${member.profession || "完成分配的专业任务"}。`,
      model: async () => resolveProfileModel(member.model),
    });
  }
  memberCache.set(profile.id, { updatedAt: profile.updatedAt, agents });
  return agents;
}

export async function profileInstructions(profile: AgentProfile): Promise<string[]> {
  if (profile.id === DEFAULT_AGENT_PROFILE_ID) return [];
  const blocks = [`你当前运行的是用户配置的 ${profile.type === "team" ? "Agent 团队" : "Agent"}「${profile.displayName}」。`];
  if (profile.instructions) blocks.push(`用户定义的工作指令:\n${profile.instructions}`);
  if (profile.workflow) blocks.push(`团队 SOP / 工作流程:\n${profile.workflow}`);
  if (profile.type === "team" && profile.members.length > 0) {
    blocks.push(`可委派成员:\n${profile.members.map((member) => `- ${member.name}: ${member.profession || member.description}`).join("\n")}\n根据成员职责委派具体子任务,由你汇总最终结果。`);
  }
  if (profile.skills.length > 0) blocks.push(`优先使用这些技能: ${profile.skills.join(", ")}`);
  return blocks;
}
