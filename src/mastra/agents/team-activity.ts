import type { DelegationConfig, MastraDBMessage } from "@mastra/core/agent";
import type { Processor } from "@mastra/core/processors";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "@mastra/core/request-context";
import type { AgentProfile, TeamInvocation } from "../../shared/agent-contract";
import { getLibsqlClient, userIdFromContext } from "../storage/database";
import { WORKSPACE_THREAD_ID_CONTEXT_KEY } from "../workspace/workspace-manager";
import { HANDOFF_COMPLETE_CONTEXT_KEY, TEAM_HANDOFF_CONTEXT_KEY } from "./team-handoff";

export const TEAM_INVOCATION_CONTEXT_KEY = "mastra-work:team-invocation";
let tableReady: Promise<void> | undefined;
async function activityClient() {
  const client = await getLibsqlClient();
  tableReady ??= client
    .batch(
      [
        `CREATE TABLE IF NOT EXISTS team_invocations (
    id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    record TEXT NOT NULL, messages TEXT NOT NULL DEFAULT '[]', tools TEXT NOT NULL DEFAULT '[]'
  )`,
        "CREATE INDEX IF NOT EXISTS team_invocations_thread ON team_invocations(resource_id, thread_id)",
      ],
      "write",
    )
    .then(() => undefined);
  await tableReady;
  return client;
}

export async function saveTeamInvocation(
  context: { get: (key: string) => unknown },
  invocation: TeamInvocation,
): Promise<void> {
  const resourceId = userIdFromContext(context);
  const threadId = context.get(WORKSPACE_THREAD_ID_CONTEXT_KEY);
  if (!resourceId || typeof threadId !== "string") throw new Error("Missing invocation owner");
  const client = await activityClient();
  await client.execute({
    sql: `INSERT INTO team_invocations (id, resource_id, thread_id, record) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET record = json_set(json_patch(team_invocations.record, excluded.record), '$.startedAt', json_extract(team_invocations.record, '$.startedAt'))`,
    args: [invocation.id, resourceId, threadId, JSON.stringify(invocation)],
  });
}

export async function finishTeamInvocation(
  id: string,
  patch: Partial<TeamInvocation>,
  messages?: unknown[],
  tools?: unknown[],
  expectedStatus?: TeamInvocation["status"],
): Promise<void> {
  const client = await activityClient();
  await client.execute({
    sql: "UPDATE team_invocations SET record = json_patch(record, ?), messages = COALESCE(?, messages), tools = COALESCE(?, tools) WHERE id = ? AND (? IS NULL OR json_extract(record, '$.status') = ?)",
    args: [
      JSON.stringify(patch),
      messages ? JSON.stringify(messages) : null,
      tools ? JSON.stringify(tools) : null,
      id,
      expectedStatus ?? null,
      expectedStatus ?? null,
    ],
  });
}

export async function listTeamInvocations(
  resourceId: string,
  threadId: string,
): Promise<TeamInvocation[]> {
  const client = await activityClient();
  const result = await client.execute({
    sql: "SELECT record FROM team_invocations WHERE resource_id = ? AND thread_id = ? ORDER BY json_extract(record, '$.startedAt'), id",
    args: [resourceId, threadId],
  });
  return result.rows.map((row) => JSON.parse(String(row.record)) as TeamInvocation);
}

export async function getTeamInvocationDetail(resourceId: string, threadId: string, id: string) {
  const client = await activityClient();
  const result = await client.execute({
    sql: "SELECT record, messages, tools FROM team_invocations WHERE resource_id = ? AND thread_id = ? AND id = ?",
    args: [resourceId, threadId, id],
  });
  const row = result.rows[0];
  return row
    ? {
        invocation: JSON.parse(String(row.record)) as TeamInvocation,
        messages: (JSON.parse(String(row.messages)) as MastraDBMessage[]).map((message) => ({
          ...message,
          createdAt: new Date(message.createdAt),
        })),
        tools: JSON.parse(String(row.tools)),
      }
    : null;
}

/** Bind the native isolated memory thread before tools run, including suspended invocations. */
export const teamInvocationProcessor = {
  id: "team-invocation",
  async processInputStep({ requestContext, state, runId, messages, agent }) {
    if (!requestContext) return;
    let id = requestContext.get(TEAM_INVOCATION_CONTEXT_KEY) as string | undefined;
    const handoff = requestContext.get(TEAM_HANDOFF_CONTEXT_KEY) as
      | import("../../shared/agent-contract").TeamHandoffState
      | undefined;
    const threadId = requestContext.get(MASTRA_THREAD_ID_KEY);
    const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY);
    if (handoff) {
      if (!runId || !agent) throw new Error("Missing handoff run identity");
      id = `${runId}:handoff`;
      requestContext.set(TEAM_INVOCATION_CONTEXT_KEY, id);
      if (state.invocationId === id) return;
      const prompt =
        messages
          .findLast((message) => message.role === "user")
          ?.content.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n") ?? "";
      await saveTeamInvocation(requestContext, {
        id,
        profileId: handoff.profileId,
        memberId: handoff.activeMemberId,
        agentId: agent.id,
        runId,
        toolCallId: id,
        prompt,
        status: "running",
        startedAt: new Date().toISOString(),
      });
    }
    if (!id || state.invocationId === id) return;
    await finishTeamInvocation(id, {
      status: "running",
      ...(agent ? { agentId: agent.id } : {}),
      ...(typeof threadId === "string" ? { memoryThreadId: threadId } : {}),
      ...(typeof resourceId === "string" ? { memoryResourceId: resourceId } : {}),
    });
    state.invocationId = id;
  },
  async processOutputResult({ requestContext, messages, messageList, result }) {
    const id = requestContext?.get(TEAM_INVOCATION_CONTEXT_KEY);
    if (typeof id !== "string") return messages;
    const directHandoff = Boolean(requestContext?.get(TEAM_HANDOFF_CONTEXT_KEY));
    const handedOff = requestContext?.get(HANDOFF_COMPLETE_CONTEXT_KEY) === true;
    await finishTeamInvocation(
      id,
      {
        text: result.text,
        ...(directHandoff && result.finishReason === "error"
          ? { status: "error" as const, error: "Member execution failed" }
          : directHandoff && (handedOff || result.finishReason !== "tool-calls")
            ? { status: "completed" as const, endedAt: new Date().toISOString() }
            : {}),
      },
      messageList.get.response.db(),
    );
    return messages;
  },
} satisfies Processor;

export async function deleteTeamInvocations(resourceId: string, threadId: string) {
  const client = await activityClient();
  await client.execute({
    sql: "DELETE FROM team_invocations WHERE resource_id = ? AND thread_id = ?",
    args: [resourceId, threadId],
  });
}

/** The hook context is copied by Mastra; nested calls inherit only their parent invocation ID. */
export function teamDelegation(
  base: DelegationConfig,
  profile: AgentProfile,
  agents: Record<string, { id: string }>,
  parentMemberId?: string,
): DelegationConfig {
  return {
    ...base,
    onDelegationStart: async (context) => {
      if (context.primitiveType !== "agent") return { proceed: true };
      const policy =
        profile.type === "team" ? { proceed: true } : await base.onDelegationStart?.(context);
      if (policy?.proceed === false) return policy;
      const memberId = Object.keys(agents).find(
        (id) => id === context.primitiveId || agents[id].id === context.primitiveId,
      );
      if (!memberId) throw new Error("Unknown delegated team member");
      const id = `${context.runId}:${context.toolCallId}`;
      const parentInvocationId = context.requestContext.get(TEAM_INVOCATION_CONTEXT_KEY);
      await saveTeamInvocation(context.requestContext, {
        id,
        profileId: profile.id,
        memberId,
        agentId: agents[memberId].id,
        parentMemberId,
        ...(typeof parentInvocationId === "string" ? { parentInvocationId } : {}),
        runId: context.runId,
        toolCallId: context.toolCallId,
        prompt: policy?.modifiedPrompt ?? context.prompt,
        status: "running",
        startedAt: new Date().toISOString(),
      });
      context.requestContext.set(TEAM_INVOCATION_CONTEXT_KEY, id);
      // Custom members execute their own instructions and the session's tool policy.
      return policy ?? { proceed: true };
    },
    onDelegationComplete: async (context) => {
      const completion = await base.onDelegationComplete?.(context);
      if (context.primitiveType === "agent") {
        await finishTeamInvocation(
          `${context.runId}:${context.toolCallId}`,
          {
            status: context.success && context.result.text.trim() ? "completed" : "error",
            text: context.result.text || completion?.resultText,
            ...(context.error ? { error: "Delegated task failed" } : {}),
            endedAt: new Date().toISOString(),
            memoryThreadId: context.result.subAgentThreadId,
            memoryResourceId: context.result.subAgentResourceId,
          },
          context.messages,
          context.result.subAgentToolResults,
        );
      }
      return completion;
    },
  };
}
