import type { Processor } from "@mastra/core/processors";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  type AgentMemberDefinition,
  type AgentProfile,
  TEAM_PROFILE_CONTEXT_KEY,
  type TeamHandoff,
  type TeamHandoffState,
} from "../../shared/agent-contract";
import { getLibsqlClient, userIdFromContext } from "../storage/database";
import { WORKSPACE_THREAD_ID_CONTEXT_KEY } from "../workspace/workspace-manager";

export const TEAM_HANDOFF_CONTEXT_KEY = "mastra-work:handoff";
export const HANDOFF_COMPLETE_CONTEXT_KEY = "mastra-work:handoff-complete";
export const handoffInputSchema = z
  .object({
    fromMemberId: z.string().trim().min(1),
    toMemberId: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(2000),
    context: z.string().trim().min(1).max(20000),
  })
  .strict();
let tableReady: Promise<void> | undefined;
async function handoffClient() {
  const client = await getLibsqlClient();
  tableReady ??= client
    .batch(
      [
        `CREATE TABLE IF NOT EXISTS team_handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, resource_id TEXT NOT NULL,
    thread_id TEXT NOT NULL, profile_id TEXT NOT NULL, record TEXT NOT NULL
  )`,
        "CREATE INDEX IF NOT EXISTS team_handoffs_thread ON team_handoffs(resource_id, thread_id, profile_id, id)",
      ],
      "write",
    )
    .then(() => undefined);
  await tableReady;
  return client;
}

export async function getTeamHandoffState(
  profile: AgentProfile,
  resourceId: string,
  threadId: string,
): Promise<TeamHandoffState | null> {
  if (profile.workflow?.strategy !== "handoff") return null;
  const client = await handoffClient();
  const result = await client.execute({
    sql: "SELECT id, record FROM team_handoffs WHERE resource_id = ? AND thread_id = ? AND profile_id = ? ORDER BY id",
    args: [resourceId, threadId, profile.id],
  });
  const history = result.rows.map(
    (row) => ({ ...JSON.parse(String(row.record)), id: Number(row.id) }) as TeamHandoff,
  );
  const activeMemberId = history.at(-1)?.toMemberId ?? profile.workflow.entryMemberId;
  if (!activeMemberId || !profile.members.some((member) => member.id === activeMemberId))
    throw new Error("Invalid active specialist");
  return { profileId: profile.id, activeMemberId, history };
}

/** A conditional insert makes stale or concurrent transfers fail atomically. */
export async function transferTeamHandoff(
  profile: AgentProfile,
  resourceId: string,
  threadId: string,
  raw: unknown,
) {
  const input = handoffInputSchema.parse(raw);
  if (
    profile.workflow?.strategy !== "handoff" ||
    input.fromMemberId === input.toMemberId ||
    !profile.members.some((member) => member.id === input.toMemberId)
  )
    throw new Error("Invalid handoff target");
  const client = await handoffClient();
  const record = { ...input, profileId: profile.id, createdAt: new Date().toISOString() };
  const result = await client.execute({
    sql: `INSERT INTO team_handoffs (resource_id, thread_id, profile_id, record)
      SELECT ?, ?, ?, ? WHERE COALESCE((SELECT json_extract(record, '$.toMemberId') FROM team_handoffs
        WHERE resource_id = ? AND thread_id = ? AND profile_id = ? ORDER BY id DESC LIMIT 1), ?) = ?`,
    args: [
      resourceId,
      threadId,
      profile.id,
      JSON.stringify(record),
      resourceId,
      threadId,
      profile.id,
      profile.workflow.entryMemberId ?? "",
      input.fromMemberId,
    ],
  });
  if (result.rowsAffected !== 1)
    throw new Error("Active specialist changed; refresh before handing off");
  return { ...record, id: Number(result.lastInsertRowid) };
}

export function activeHandoffMember(
  profile: AgentProfile,
  context?: { get: (key: string) => unknown },
) {
  if (profile.workflow?.strategy !== "handoff") return undefined;
  const state = context?.get(TEAM_HANDOFF_CONTEXT_KEY) as TeamHandoffState | undefined;
  if (!state || state.profileId !== profile.id) throw new Error("Handoff identity is missing");
  const member = profile.members.find((member) => member.id === state.activeMemberId);
  if (!member) throw new Error("Handoff specialist is missing");
  return member;
}

/** Resolve at generation time too: queued requests may outlive a transfer. */
export async function refreshHandoffIdentity(
  profile: AgentProfile,
  requestContext?: RequestContext,
) {
  if (profile.workflow?.strategy !== "handoff") return;
  const owner = userIdFromContext(requestContext);
  const threadId = requestContext?.get(WORKSPACE_THREAD_ID_CONTEXT_KEY);
  if (!owner || typeof threadId !== "string" || !requestContext)
    throw new Error("Missing handoff owner");
  requestContext.set(TEAM_HANDOFF_CONTEXT_KEY, await getTeamHandoffState(profile, owner, threadId));
}

export function teamHandoffTool(profile: AgentProfile) {
  return createTool({
    id: "handoff",
    description:
      "Transfer ownership to another specialist. Supply the reason and relevant context. This ends your turn; the successor directly handles subsequent messages.",
    inputSchema: handoffInputSchema,
    execute: async (input, context) => {
      const requestContext = context?.requestContext as RequestContext | undefined;
      const owner = userIdFromContext(requestContext);
      const threadId = requestContext?.get(WORKSPACE_THREAD_ID_CONTEXT_KEY);
      const member = activeHandoffMember(profile, requestContext);
      if (!owner || typeof threadId !== "string" || member?.id !== input.fromMemberId)
        throw new Error("Invalid handoff identity");
      const transfer = await transferTeamHandoff(profile, owner, threadId, input);
      requestContext?.set(HANDOFF_COMPLETE_CONTEXT_KEY, true);
      return transfer;
    },
  });
}

/** Preserve the actual speaker on stored replies, including after a later handoff. */
export function agentIdentityProcessor(configuredMember?: AgentMemberDefinition) {
  return {
    id: "agent-identity",
    processOutputResult({ messages, messageList, requestContext }) {
      const state = requestContext?.get(TEAM_HANDOFF_CONTEXT_KEY) as TeamHandoffState | undefined;
      const profile = requestContext?.get(TEAM_PROFILE_CONTEXT_KEY) as AgentProfile | undefined;
      if (!profile) return messages;
      const member =
        configuredMember ?? profile.members.find((member) => member.id === state?.activeMemberId);
      const responseIds = new Set(messageList.get.response.db().map((message) => message.id));
      return messages.map((message) =>
        message.role !== "assistant" || !responseIds.has(message.id)
          ? message
          : {
              ...message,
              content: {
                ...message.content,
                metadata: {
                  ...message.content.metadata,
                  agentProfileId: profile.id,
                  agentDisplayName: member?.name ?? profile.displayName,
                  agentAvatar: member?.avatar ?? profile.avatar,
                  ...(member ? { teamMemberId: member.id } : {}),
                },
              },
            },
      );
    },
  } satisfies Processor;
}

export async function deleteTeamHandoffs(resourceId: string, threadId: string) {
  const client = await handoffClient();
  await client.execute({
    sql: "DELETE FROM team_handoffs WHERE resource_id = ? AND thread_id = ?",
    args: [resourceId, threadId],
  });
}
