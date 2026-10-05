/** Shared workbench session resolution and validated execution context. */
import { existsSync, statSync } from "node:fs";
import type { Agent, AgentExecutionOptions } from "@mastra/core/agent";
import type { Session as ControllerSession } from "@mastra/core/agent-controller";
import type { ContextWithMastra } from "@mastra/core/server";
import { z } from "zod";
import {
  AGENT_PROFILE_CONTEXT_KEY,
  ensureProfileAgentsRegistered,
  getAgentProfile,
} from "../agents/custom";
import {
  listWorkModes,
  MODE_ID_CONTEXT_KEY,
  PERMISSION_RULES_CONTEXT_KEY,
  parsePermissionRules,
  resolveMode,
  SESSION_TOOL_POLICY_CONTEXT_KEY,
  TOOL_CATEGORIES,
} from "../agents/permissions";
import { WORK_MESSAGE_OPTIONS_CONTEXT_KEY, workMessageMetadataSchema } from "../agents/processors";
import { TEAM_PROFILE_CONTEXT_KEY } from "../agents/team-workflow";
import { SESSION_EXECUTION_CONTEXT_KEY, SKILL_NAMES_CONTEXT_KEY } from "../agents/work-agent";
import { workError } from "../errors";
import {
  REQUEST_MODEL_ID_CONTEXT_KEY,
  requestModelFamily,
  resolveDefaultModelId,
  resolveRequestModel,
  usesOpenAIResponses,
} from "../models/providers";
import {
  LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY,
  LIBRARY_ATTACHMENT_CAPABILITIES_CONTEXT_KEY,
  LIBRARY_ORIGIN_CONTEXT_KEY,
  LIBRARY_RESOURCE_CONTEXT_KEY,
  LIBRARY_THREAD_CONTEXT_KEY,
} from "../rag/types";
import { parseWebSearchSelection, WEB_SEARCH_CONTEXT_KEY } from "../tools/tool-registry";
import {
  addRecentWorkspace,
  ensureDirectory,
  implicitThreadWorkspacePath,
  WORKSPACE_PATH_CONTEXT_KEY,
  WORKSPACE_RESOURCE_ID_CONTEXT_KEY,
  WORKSPACE_THREAD_ID_CONTEXT_KEY,
} from "../workspace/workspace-manager";
import {
  getOwnedThread,
  getWorkMemory,
  type OwnedThread,
  type ThreadMetadata,
} from "./threads/shared";

function scopeOf(value: string | undefined): string {
  return value?.trim() || "workbench";
}

export interface SessionRouteResult {
  controllerSession: ControllerSession;
  agent: Agent;
  memory: Awaited<ReturnType<typeof getWorkMemory>>;
  resourceId: string;
  threadId: string;
  thread: NonNullable<OwnedThread>;
}

export const workbenchMessageOptionsSchema = workMessageMetadataSchema
  .extend({
    workspacePath: z.string().optional(),
    agentProfileId: z.string().optional(),
    attachmentTokenBudget: z.number().finite().nonnegative().optional(),
    attachmentCapabilities: z
      .object({ vision: z.boolean().optional(), audio: z.boolean().optional() })
      .optional(),
    modelSettings: z.record(z.string(), z.unknown()).optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    webSearch: z.unknown().optional(),
    versions: z.unknown().optional(),
    scorers: z.unknown().optional(),
    isTaskComplete: z.unknown().optional(),
  })
  .strict();

/** Product context is validated here; native Session owns message submission. */
export async function prepareWorkbenchMessage(
  c: ContextWithMastra,
  threadId: string,
  resourceId: string,
  rawOptions?: unknown,
): Promise<SessionRouteResult> {
  const options = workbenchMessageOptionsSchema.parse(rawOptions ?? {});
  const requestContext = c.get("requestContext");
  const memory = await getWorkMemory(requestContext);
  const thread = await getOwnedThread(memory, threadId, resourceId);
  if (!thread) throw workError("THREAD_NOT_FOUND");
  const metadata = (thread.metadata ?? {}) as ThreadMetadata;
  const profile = await getAgentProfile(
    options.agentProfileId ?? metadata.agentProfileId,
    resourceId,
  );
  const patch: ThreadMetadata = {};
  if (metadata.agentProfileId !== profile.id) patch.agentProfileId = profile.id;
  if (!metadata.workspacePath) {
    const requested = options.workspacePath;
    if (requested && existsSync(requested) && statSync(requested).isDirectory()) {
      patch.workspacePath = requested;
      patch.workspaceExplicit = true;
      await addRecentWorkspace(requested, resourceId);
    } else {
      patch.workspacePath = await implicitThreadWorkspacePath(threadId, resourceId);
      patch.workspaceExplicit = false;
      ensureDirectory(patch.workspacePath);
    }
  }
  if (Object.keys(patch).length) {
    await memory.updateThread({
      id: threadId,
      title: thread.title,
      metadata: { ...metadata, ...patch },
    });
  }
  if (profile.type === "team") requestContext.set(TEAM_PROFILE_CONTEXT_KEY, profile);
  requestContext.set(WORK_MESSAGE_OPTIONS_CONTEXT_KEY, options);
  requestContext.set(SKILL_NAMES_CONTEXT_KEY, options.skillNames ?? []);
  if (options.attachmentTokenBudget !== undefined) {
    requestContext.set(
      LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY,
      Math.floor(options.attachmentTokenBudget),
    );
  }
  requestContext.set(LIBRARY_ATTACHMENT_CAPABILITIES_CONTEXT_KEY, {
    vision: options.attachmentCapabilities?.vision === true,
    audio: options.attachmentCapabilities?.audio === true,
  });
  const result = await sessionFor(c, { threadId, resourceId, scope: "workbench" });
  const selectedModel = { id: result.controllerSession.model.get() };
  if (!(await resolveRequestModel(selectedModel, resourceId)))
    throw workError("MODEL_NOT_CONFIGURED");
  requestContext.set(REQUEST_MODEL_ID_CONTEXT_KEY, selectedModel.id);
  const webSearch = parseWebSearchSelection(options.webSearch);
  if (webSearch) requestContext.set(WEB_SEARCH_CONTEXT_KEY, webSearch);
  const reasoningSummary = await usesOpenAIResponses(selectedModel, resourceId);
  const modelFamily = await requestModelFamily(selectedModel, resourceId);
  requestContext.set(SESSION_EXECUTION_CONTEXT_KEY, {
    modelSettings: options.modelSettings as AgentExecutionOptions["modelSettings"],
    providerOptions: {
      ...options.providerOptions,
      openai: {
        ...(options.providerOptions?.openai as Record<string, unknown> | undefined),
        ...(reasoningSummary ? { reasoningSummary: "auto" } : {}),
        ...(modelFamily === "openai" ? { promptCacheKey: threadId } : {}),
      },
    },
    ...(options.versions !== undefined ? { versions: options.versions } : {}),
    ...(options.scorers !== undefined ? { scorers: options.scorers } : {}),
    ...(options.isTaskComplete !== undefined ? { isTaskComplete: options.isTaskComplete } : {}),
  });
  return result;
}

/** Restore the native per-mode selection; a new mode starts with the user's default. */
async function restoreSessionModel(session: ControllerSession, resourceId: string) {
  const defaultModelId = await resolveDefaultModelId(resourceId);
  if (defaultModelId) {
    for (const mode of listWorkModes()) {
      if (!(await session.model.resolveForMode({ modeId: mode.id }))) {
        await session.model.switch({ modelId: defaultModelId, modeId: mode.id });
      }
    }
  }
  await session.model.syncFromPersisted({ modeId: session.mode.get() });
}

/** Resolve the single official Session for a workbench thread. */
export async function getWorkbenchSession(
  c: ContextWithMastra,
  threadId: string,
  resourceId: string,
  scope?: string,
) {
  const requestContext = c.get("requestContext");
  const memory = await getWorkMemory(requestContext);
  const thread = await getOwnedThread(memory, threadId, resourceId);
  if (!thread) throw workError("THREAD_NOT_FOUND");
  const controller = c.get("mastra").getAgentController("workbench");
  if (!controller) throw new Error("Workbench AgentController is not registered");
  const mode = resolveMode(thread.metadata?.currentModeId);
  requestContext.set(MODE_ID_CONTEXT_KEY, mode.id);
  await controller.init();
  requestContext.set(WORKSPACE_THREAD_ID_CONTEXT_KEY, threadId);
  requestContext.set(WORKSPACE_RESOURCE_ID_CONTEXT_KEY, resourceId);
  const workspacePath =
    requestContext.get(WORKSPACE_PATH_CONTEXT_KEY) ?? thread.metadata?.workspacePath;
  if (typeof workspacePath === "string" && workspacePath) {
    requestContext.set(WORKSPACE_PATH_CONTEXT_KEY, workspacePath);
  }
  const session = await controller.createSession({
    resourceId,
    threadId,
    scope: JSON.stringify([scopeOf(scope), threadId]),
    requestContext,
  });
  requestContext.set(SESSION_TOOL_POLICY_CONTEXT_KEY, (toolName: string) =>
    session.resolveToolApproval(toolName),
  );
  if (session.mode.get() !== mode.id) await session.mode.switch({ modeId: mode.id });
  await restoreSessionModel(session, resourceId);
  if (session.state.get().permissionRules === undefined) {
    const rules = parsePermissionRules(thread.metadata?.permissionRules);
    const yolo =
      TOOL_CATEGORIES.every((category) => rules.categories[category] === "allow") &&
      Object.values(rules.tools).every((policy) => policy === "allow");
    await session.state.set({ permissionRules: rules, yolo });
  }
  requestContext.set(PERMISSION_RULES_CONTEXT_KEY, session.permissions.getRules());
  return session;
}

export async function sessionFor(
  c: ContextWithMastra,
  target?: { threadId: string; resourceId: string; scope: string },
): Promise<SessionRouteResult> {
  const threadId = target?.threadId ?? c.req.param("threadId");
  const resourceId = target?.resourceId ?? c.req.query("resourceId");
  const scope = target?.scope ?? scopeOf(c.req.param("scope"));
  if (!resourceId || !threadId)
    throw workError("VALIDATION_FAILED", { text: "resourceId and threadId are required" });
  const memory = await getWorkMemory(c.get("requestContext"));
  const thread = await getOwnedThread(memory, threadId, resourceId);
  if (!thread) {
    throw workError("THREAD_NOT_FOUND");
  }
  const metadata = (thread.metadata ?? {}) as ThreadMetadata;
  const profile = await getAgentProfile(metadata.agentProfileId, resourceId);
  await ensureProfileAgentsRegistered(c.get("mastra"), profile, resourceId);
  const requestContext = c.get("requestContext");
  requestContext.set(WORKSPACE_THREAD_ID_CONTEXT_KEY, threadId);
  requestContext.set(WORKSPACE_RESOURCE_ID_CONTEXT_KEY, resourceId);
  requestContext.set(LIBRARY_RESOURCE_CONTEXT_KEY, resourceId);
  requestContext.set(LIBRARY_THREAD_CONTEXT_KEY, threadId);
  requestContext.set(LIBRARY_ORIGIN_CONTEXT_KEY, new URL(c.req.url).origin);
  requestContext.set(AGENT_PROFILE_CONTEXT_KEY, profile.id);
  if (metadata.workspacePath) {
    requestContext.set(WORKSPACE_PATH_CONTEXT_KEY, metadata.workspacePath);
  }
  const controllerSession = await getWorkbenchSession(c, threadId, resourceId, scope);
  const agent = c.get("mastra").getAgentController("workbench")?.getCurrentAgent(controllerSession);
  if (!agent) throw new Error("Workbench AgentController is not registered");
  return { controllerSession, agent, memory, resourceId, threadId, thread };
}
