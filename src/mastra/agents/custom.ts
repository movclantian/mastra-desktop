import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Agent, SubAgent } from "@mastra/core/agent";
import { type AnyWorkflow, cloneStep, createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { getAppConfig, getResourceScope, setAppConfig } from "../storage";
import { getManagedSkillsDirectory } from "../workspace";

export const AGENT_PROFILE_CONTEXT_KEY = "mastra-work:agent-profile";
export const DEFAULT_AGENT_PROFILE_ID = "mastra-work-agent";
const CONFIG_KEY = "agent-profiles";

export type AgentProfileType = "agent" | "team";

export type AgentWorkflowStrategy = "supervisor" | "sequence" | "parallel";

export interface AgentWorkflowStep {
  id: string;
  memberId: string;
  prompt?: string;
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
  model?: { providerId: string; modelId: string };
  skills: string[];
  tools: string[];
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
  model?: { providerId: string; modelId: string };
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
    ...raw,
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
              ...(item.model &&
              typeof item.model.providerId === "string" &&
              typeof item.model.modelId === "string"
                ? { model: { providerId: item.model.providerId, modelId: item.model.modelId } }
                : {}),
              skills: Array.isArray(item.skills)
                ? item.skills.filter(
                    (skill): skill is string =>
                      typeof skill === "string" && skill.trim().length > 0,
                  )
                : [],
              tools: Array.isArray(item.tools)
                ? item.tools.filter(
                    (tool): tool is string => typeof tool === "string" && tool.trim().length > 0,
                  )
                : [],
              memoryScope: item.memoryScope === "resource" ? "resource" : "thread",
            };
          })
      : [],
    workflow: normalizeWorkflow(raw.workflow),
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

function normalizeWorkflow(value: unknown): AgentWorkflowDefinition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const usedStepIds = new Set<string>();
  const steps = Array.isArray(raw.steps)
    ? raw.steps.flatMap((item, index) => {
        if (!item || typeof item !== "object") return [];
        const step = item as Record<string, unknown>;
        const memberId = typeof step.memberId === "string" ? step.memberId.trim() : "";
        if (!memberId) return [];
        const baseId =
          typeof step.id === "string" && step.id.trim() ? step.id.trim() : `step-${index + 1}`;
        let id = baseId;
        let suffix = 2;
        while (usedStepIds.has(id)) id = `${baseId}-${suffix++}`;
        usedStepIds.add(id);
        return [
          {
            id,
            memberId,
            ...(typeof step.prompt === "string" && step.prompt.trim()
              ? { prompt: step.prompt.trim() }
              : {}),
          },
        ];
      })
    : [];
  if (steps.length === 0) return undefined;
  const strategy =
    raw.strategy === "sequence" || raw.strategy === "parallel" ? raw.strategy : "supervisor";
  return { strategy, steps, synthesis: raw.synthesis !== false };
}

export async function listAgentProfiles(): Promise<AgentProfile[]> {
  const raw = await getAppConfig(CONFIG_KEY);
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

export async function getAgentProfile(id: string | undefined): Promise<AgentProfile> {
  const profiles = await listAgentProfiles();
  return (
    profiles.find((profile) => profile.id === (id?.trim() || DEFAULT_AGENT_PROFILE_ID)) ??
    DEFAULT_PROFILE
  );
}

async function saveProfiles(profiles: AgentProfile[]): Promise<void> {
  await setAppConfig(
    CONFIG_KEY,
    JSON.stringify(profiles.filter((profile) => profile.id !== DEFAULT_AGENT_PROFILE_ID)),
  );
}

export async function upsertAgentProfile(input: Partial<AgentProfile>): Promise<AgentProfile> {
  if (input.id === DEFAULT_AGENT_PROFILE_ID) throw new Error("默认 Agent 不可覆盖");
  const current = (await listAgentProfiles()).filter(
    (profile) => profile.id !== DEFAULT_AGENT_PROFILE_ID,
  );
  const existing = current.find((profile) => profile.id === input.id);
  const now = new Date().toISOString();
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
  await saveProfiles([...current.filter((item) => item.id !== profile.id), profile]);
  return profile;
}

export async function deleteAgentProfile(id: string): Promise<void> {
  if (id === DEFAULT_AGENT_PROFILE_ID) throw new Error("默认 Agent 不可删除");
  await saveProfiles((await listAgentProfiles()).filter((profile) => profile.id !== id));
  memberCache.delete(scopedProfileKey(id));
}

type ProfileAgentFactory = (profile: AgentProfile) => Agent;
type MemberAgentFactory = (profile: AgentProfile, member: AgentMemberDefinition) => SubAgent;

let profileAgentFactory: ProfileAgentFactory | undefined;
let memberAgentFactory: MemberAgentFactory | undefined;

export function setProfileAgentFactories(factories: {
  profile: ProfileAgentFactory;
  member: MemberAgentFactory;
}): void {
  profileAgentFactory = factories.profile;
  memberAgentFactory = factories.member;
}

const memberCache = new Map<string, { updatedAt: string; agents: Record<string, SubAgent> }>();

function scopedProfileKey(id: string): string {
  return JSON.stringify([getResourceScope() ?? "__system__", id]);
}

export async function resolveProfileMembers(
  profile: AgentProfile,
): Promise<Record<string, SubAgent>> {
  if (profile.type !== "team") return {};
  const key = scopedProfileKey(profile.id);
  const cached = memberCache.get(key);
  if (cached?.updatedAt === profile.updatedAt) return cached.agents;
  if (!memberAgentFactory) throw new Error("Profile Agent factory is not initialized");
  const agents: Record<string, SubAgent> = {};
  for (const member of profile.members) {
    agents[member.id] = memberAgentFactory(profile, member);
  }
  memberCache.set(key, { updatedAt: profile.updatedAt, agents });
  return agents;
}

export async function resolveManagedSkillPaths(names: string[]): Promise<string[]> {
  const requested = new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean));
  if (requested.size === 0) return [];
  const root = getManagedSkillsDirectory();
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
): Promise<{ name: string; instructions: string } | undefined> {
  const [directory] = await resolveManagedSkillPaths([name]);
  if (!directory) return undefined;
  const content = await readFile(join(directory, "SKILL.md"), "utf8");
  const metadataName = /^---\s*[\s\S]*?\bname:\s*["']?([^\r\n"']+)/m.exec(content)?.[1]?.trim();
  return {
    name: metadataName || basename(directory),
    instructions: content.replace(/^---\s*[\s\S]*?\s*---\s*/, "").trim(),
  };
}

/** Build a team workflow from the authenticated user's profile without global registration. */
export async function buildProfileWorkflow(
  profile: AgentProfile,
): Promise<{ workflow: AnyWorkflow } | undefined> {
  if (
    profile.type !== "team" ||
    !profile.workflow ||
    profile.workflow.strategy === "supervisor" ||
    profile.members.length === 0
  )
    return undefined;
  const memberIds = new Set(profile.members.map((member) => member.id));
  const steps = profile.workflow.steps.filter((step) => memberIds.has(step.memberId));
  if (steps.length === 0) return undefined;

  const members = await resolveProfileMembers(profile);
  const agentSteps = steps.map((step) => {
    const member = members[step.memberId];
    if (!member) return undefined;
    return cloneStep(createStep(member), { id: step.id });
  });
  const resolvedAgentSteps = agentSteps.filter((step): step is NonNullable<typeof step> =>
    Boolean(step),
  );
  if (resolvedAgentSteps.length !== steps.length) return undefined;
  if (!profileAgentFactory) throw new Error("Profile Agent factory is not initialized");

  const workflow = createWorkflow({
    id: `agent-team-${profile.id}`,
    description: `${profile.displayName} 的可执行协作流程`,
    inputSchema: z.object({ request: z.string() }),
    outputSchema: z.object({ text: z.string() }),
  });
  let flow: AnyWorkflow = workflow.map(
    async ({ inputData }: { inputData: { request: string } }) => ({ prompt: inputData.request }),
    { id: "workflow-input" },
  );

  if (profile.workflow.strategy === "parallel") {
    flow = flow.parallel(resolvedAgentSteps);
    if (profile.workflow.synthesis) {
      flow = flow.map(
        async ({
          inputData,
          getInitData,
        }: {
          inputData: Record<string, { text: string }>;
          getInitData: () => { request: string };
        }) => ({
          prompt: `请汇总以下团队结果并给出最终答复。原始请求: ${getInitData().request}\n\n团队结果: ${Object.values(
            inputData,
          )
            .map((result) => result.text)
            .join("\n\n")}`,
        }),
        { id: "synthesis-input" },
      );
      flow = flow.then(cloneStep(createStep(profileAgentFactory(profile)), { id: "synthesis" }));
    } else {
      flow = flow.map(
        async ({ inputData }: { inputData: Record<string, { text: string }> }) => ({
          text: Object.values(inputData)
            .map((result) => result.text)
            .join("\n\n"),
        }),
        { id: "parallel-result" },
      );
    }
  } else {
    steps.forEach((step, index) => {
      if (index > 0) {
        flow = flow.map(
          async ({
            inputData,
            getInitData,
          }: {
            inputData: { text: string };
            getInitData: () => { request: string };
          }) => ({
            prompt: `${step.prompt ?? "继续处理这个任务"}: ${getInitData().request}\n\n上一步结果: ${inputData.text}`,
          }),
          { id: `${step.id}-input` },
        );
      }
      flow = flow.then(resolvedAgentSteps[index]);
    });
    if (profile.workflow.synthesis) {
      flow = flow.map(
        async ({
          inputData,
          getInitData,
        }: {
          inputData: { text: string };
          getInitData: () => { request: string };
        }) => ({
          prompt: `请汇总以下团队结果并给出最终答复。原始请求: ${getInitData().request}\n\n团队结果: ${inputData.text}`,
        }),
        { id: "synthesis-input" },
      );
      flow = flow.then(cloneStep(createStep(profileAgentFactory(profile)), { id: "synthesis" }));
    }
  }
  return { workflow: flow.commit() as AnyWorkflow };
}
