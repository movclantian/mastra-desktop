export function isTerminalAgentChunk(chunk: unknown): boolean {
  if (typeof chunk !== "object" || chunk === null) return false;
  const event = chunk as {
    type?: string;
    finishReason?: string;
    payload?: { finishReason?: string; stepResult?: { reason?: string } };
  };
  // A tool-call finish ends a model step, while the agent continues running.
  if (event.type === "finish") {
    return (
      (event.finishReason ?? event.payload?.finishReason ?? event.payload?.stepResult?.reason) !==
      "tool-calls"
    );
  }
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    ["finish", "error", "suspended", "agent-step-error", "agent-step-suspended"].includes(
      (chunk as { type?: string }).type ?? "",
    )
  );
}
export const SESSION_SCOPE_DEFAULT = "workbench";
export const workSessionHost = {
  getOrCreate: createWorkSession,
};

import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentExecutionOptions,
  AgentMessageInput,
  AgentThreadSubscription,
} from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import type { ToolCategory } from "../agents/permissions";
import { SESSION_GRANTS_CONTEXT_KEY } from "../agents/permissions";
import { getDefaultWorkAgent } from "./registry";
import type { WorkNotificationInput } from "./signals";

function createWorkSession(options: {
  resourceId: string;
  threadId: string;
  agent?: Agent;
  scope?: string;
}) {
  const agent = options.agent ?? getDefaultWorkAgent();
  if (!agent) throw new Error("Default work agent is not registered");
  let grants: { categories: ToolCategory[]; tools: string[] } = { categories: [], tools: [] },
    state: Record<string, unknown> = {};
  const sendMessage = (
    message: AgentMessageInput,
    streamOptions: AgentExecutionOptions = {},
    id?: string,
  ) =>
    agent.sendSignal(
      {
        ...(typeof message === "object" && !Array.isArray(message)
          ? message
          : { contents: message }),
        type: "user",
        tagName: "user",
        id: id ?? randomUUID(),
      },
      {
        resourceId: options.resourceId,
        threadId: options.threadId,
        ifActive: { behavior: "deliver" },
        ifIdle: {
          behavior: "wake",
          streamOptions: {
            ...streamOptions,
            requestContext:
              streamOptions.requestContext ??
              new RequestContext([
                ["resourceId", options.resourceId],
                ["threadId", options.threadId],
                [SESSION_GRANTS_CONTEXT_KEY, grants],
              ]),
          },
        },
      },
    );
  return {
    id: `${options.resourceId}:${options.threadId}`,
    resourceId: options.resourceId,
    threadId: options.threadId,
    getGrants: () => grants,
    setGrants: (g: any) => (grants = { ...grants, ...g }),
    grantCategory: (c: any) => {
      if (!grants.categories.includes(c)) grants.categories.push(c);
      return grants;
    },
    revokeCategory: (c: any) => {
      grants.categories = grants.categories.filter((x: any) => x !== c);
      return grants;
    },
    grantTool: (t: string) => {
      if (!grants.tools.includes(t)) grants.tools.push(t);
      return grants;
    },
    revokeTool: (t: string) => {
      grants.tools = grants.tools.filter((x: string) => x !== t);
      return grants;
    },
    getState: () => ({ ...state }),
    setState: (u: any) => (state = { ...state, ...u }),
    subscribe: (threadId: string) =>
      agent.subscribeToThread({ resourceId: options.resourceId, threadId }),
    releaseSubscription: (s: AgentThreadSubscription) => s.unsubscribe(),
    sendMessage,
    steer: async (m: any, o: any, id?: string) => {
      await agent.abortThreadStream({ resourceId: options.resourceId, threadId: options.threadId });
      return sendMessage(m, o, id);
    },
    abort: () =>
      agent.abortThreadStream({ resourceId: options.resourceId, threadId: options.threadId }),
    notifyPolicyChange: (s: string, attributes?: Record<string, string>) =>
      void agent.sendSignal(
        { type: "reactive", contents: s, attributes },
        {
          resourceId: options.resourceId,
          threadId: options.threadId,
          ifActive: { behavior: "deliver" },
          ifIdle: { behavior: "discard" },
        },
      ),
    sendNotification: (n: WorkNotificationInput) => {
      const target = {
        resourceId: options.resourceId,
        threadId: options.threadId,
      };
      return Array.isArray(n)
        ? agent.sendNotificationSignal(n, target)
        : agent.sendNotificationSignal(n, target);
    },
    getDisplayState: () => ({
      status: agent.getActiveThreadRunId({
        resourceId: options.resourceId,
        threadId: options.threadId,
      })
        ? "running"
        : "idle",
      threadId: options.threadId,
      activeRunId:
        agent.getActiveThreadRunId({
          resourceId: options.resourceId,
          threadId: options.threadId,
        }) ?? null,
      grants,
      state,
      updatedAt: new Date().toISOString(),
    }),
  };
}

export type WorkSession = ReturnType<typeof createWorkSession>;
export { createWorkSession };
