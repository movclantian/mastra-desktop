export const SESSION_SCOPE_DEFAULT = "workbench";
export const workSessionHost = {
  getOrCreate(options: any) {
    return createWorkSession(options);
  },
};

import { randomUUID } from "node:crypto";
import { RequestContext } from "@mastra/core/request-context";
import { SESSION_GRANTS_CONTEXT_KEY } from "../agents/permissions";
import { getDefaultWorkAgent } from "./registry";

function createWorkSession(options: any) {
  const agent = options.agent ?? getDefaultWorkAgent();
  if (!agent) throw new Error("Default work agent is not registered");
  let grants = { categories: [], tools: [] },
    state: any = {};
  const sendMessage = (message: any, streamOptions: any = {}, id?: string) =>
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
    releaseSubscription: (s: any) => s.unsubscribe(),
    subscribeFollowUp: async () => undefined,
    sendMessage,
    steer: async (m: any, o: any, id?: string) => {
      await agent.abortThreadStream({ resourceId: options.resourceId, threadId: options.threadId });
      return sendMessage(m, o, id);
    },
    abort: () =>
      agent.abortThreadStream({ resourceId: options.resourceId, threadId: options.threadId }),
    notifyPolicyChange: (s: string) =>
      void agent.sendSignal(
        { type: "reactive", contents: s },
        {
          resourceId: options.resourceId,
          threadId: options.threadId,
          ifActive: { behavior: "deliver" },
          ifIdle: { behavior: "discard" },
        },
      ),
    sendNotification: (n: any) =>
      agent.sendNotificationSignal(n, {
        resourceId: options.resourceId,
        threadId: options.threadId,
      }),
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

export { createWorkSession };
