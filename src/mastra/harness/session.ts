/**
 * Harness 会话运行时(docs/en/docs/harness/agent-controller.mdx):
 * 围绕共享 Agent 承载单个会话的生命周期、排队、打断与策略通知。
 * 线程级收发全部走官方原语:queueMessage(ifIdle: wake)、subscribeToThread、
 * abortThreadStream、sendSignal(ifActive: deliver / ifIdle: discard)。
 */
import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentExecutionOptions,
  AgentMessageInput,
  AgentThreadSubscription,
} from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { SESSION_GRANTS_CONTEXT_KEY, type ToolCategory } from "../agents/permissions";
import { getDefaultWorkAgent } from "./registry";
import type { WorkNotificationInput } from "./signals";

/** Live state mirrors the Session state boundary in agent-controller.mdx. */
interface WorkSessionState {
  activeProject?: string;
  yolo?: boolean;
  count?: number;
}
interface WorkSessionGrants {
  categories: ToolCategory[];
  tools: string[];
}

export const SESSION_SCOPE_DEFAULT = "workbench";

interface WorkDisplayState {
  status: "idle" | "running" | "suspended";
  threadId: string;
  activeRunId: string | null;
  modeId: string;
  followUpCount: number;
  grants: WorkSessionGrants;
  state: WorkSessionState;
  tasks: unknown[];
  suspendedRuns: unknown[];
  updatedAt: string;
}

type AgentStreamChunk = {
  type?: string;
  runId?: string;
  finishReason?: string;
  payload?: {
    finishReason?: string;
    stepResult?: { reason?: string };
  };
};

/** 默认 Agent 由 agents/index.ts 在模块加载时注册; 会话实例化总在启动之后 */
function resolveDefaultAgent(): Agent {
  const agent = getDefaultWorkAgent();
  if (!agent) {
    throw new Error(
      "Default work agent is not registered. Import src/mastra/agents before creating a WorkSession.",
    );
  }
  return agent;
}

export function isTerminalAgentChunk(chunk: unknown): boolean {
  if (typeof chunk !== "object" || chunk === null) return false;
  const typedChunk = chunk as AgentStreamChunk;
  const chunkType = typedChunk.type;
  if (chunkType === "finish") {
    // A tool-calls finish closes one model step, not the agent run. Mastra's
    // thread subscription keeps reading so the tool result and next step can
    // arrive on the same stream.
    const finishReason =
      typedChunk.finishReason ??
      typedChunk.payload?.finishReason ??
      typedChunk.payload?.stepResult?.reason;
    return finishReason !== "tool-calls";
  }
  return (
    chunkType === "suspended" ||
    chunkType === "agent-step-suspended" ||
    chunkType === "error" ||
    chunkType === "agent-step-error"
  );
}

interface QueuedFollowUp {
  id: string;
  message: AgentMessageInput;
  streamOptions: AgentExecutionOptions;
  subscription: AgentThreadSubscription;
}

export class WorkSession {
  readonly id: string;
  readonly resourceId: string;
  readonly scope: string;
  private currentThreadId: string;
  private modeId = "build";
  private grants: WorkSessionGrants = { categories: [], tools: [] };
  private state: WorkSessionState = {};
  private executionDefaults: AgentExecutionOptions = {};
  private agent: Agent;
  private readonly subscriptions = new Map<AgentThreadSubscription, string>();
  private readonly followUps: QueuedFollowUp[] = [];
  private readonly followUpTargets = new Map<string, QueuedFollowUp>();
  private followUpMonitor: Promise<AgentThreadSubscription> | undefined;
  private followUpMonitorConsumer: Promise<void> | undefined;
  private followUpCount = 0;

  constructor(options: {
    id: string;
    resourceId: string;
    scope?: string;
    threadId: string;
    agent?: Agent;
  }) {
    this.id = options.id;
    this.resourceId = options.resourceId;
    this.scope = options.scope ?? SESSION_SCOPE_DEFAULT;
    this.currentThreadId = options.threadId;
    this.agent = options.agent ?? resolveDefaultAgent();
  }

  get threadId(): string {
    return this.currentThreadId;
  }

  setThreadId(threadId: string): void {
    if (this.currentThreadId === threadId) return;
    this.abort();
    this.currentThreadId = threadId;
  }

  setAgent(agent: Agent): void {
    if (this.agent === agent) return;
    this.abort();
    this.agent = agent;
  }

  setMode(modeId: string): void {
    this.modeId = modeId;
  }

  setExecutionDefaults(defaults: AgentExecutionOptions): void {
    this.executionDefaults = defaults;
  }

  getGrants(): WorkSessionGrants {
    return {
      categories: [...this.grants.categories],
      tools: [...this.grants.tools],
    };
  }

  setGrants(grants: Partial<WorkSessionGrants>): WorkSessionGrants {
    const nextCategories = grants.categories
      ? [...new Set(grants.categories)]
      : this.grants.categories;
    const nextTools = grants.tools ? [...new Set(grants.tools)] : this.grants.tools;
    this.grants = { categories: nextCategories, tools: nextTools };
    return this.getGrants();
  }

  grantTool(toolId: string): WorkSessionGrants {
    if (!this.grants.tools.includes(toolId)) {
      this.grants = {
        ...this.grants,
        tools: [...this.grants.tools, toolId],
      };
    }
    return this.getGrants();
  }

  revokeTool(toolId: string): WorkSessionGrants {
    this.grants = {
      ...this.grants,
      tools: this.grants.tools.filter((id) => id !== toolId),
    };
    return this.getGrants();
  }

  grantCategory(category: ToolCategory): WorkSessionGrants {
    if (!this.grants.categories.includes(category)) {
      this.grants = {
        ...this.grants,
        categories: [...this.grants.categories, category],
      };
    }
    return this.getGrants();
  }

  revokeCategory(category: ToolCategory): WorkSessionGrants {
    this.grants = {
      ...this.grants,
      categories: this.grants.categories.filter((c) => c !== category),
    };
    return this.getGrants();
  }

  clearGrants(): WorkSessionGrants {
    this.grants = { categories: [], tools: [] };
    return this.getGrants();
  }

  getState(): WorkSessionState {
    return { ...this.state };
  }

  setState(update: Partial<WorkSessionState>): WorkSessionState {
    this.state = { ...this.state, ...update };
    return this.getState();
  }

  async subscribe(threadId: string): Promise<AgentThreadSubscription> {
    const sub = await this.agent.subscribeToThread({
      resourceId: this.resourceId,
      threadId,
    });
    this.subscriptions.set(sub, threadId);
    return sub;
  }

  releaseSubscription(subscription: AgentThreadSubscription): void {
    this.subscriptions.delete(subscription);
    subscription.unsubscribe();
  }

  async subscribeFollowUp(followUpId: string): Promise<AgentThreadSubscription | undefined> {
    return this.followUpTargets.get(followUpId)?.subscription;
  }

  sendMessage(message: AgentMessageInput, streamOptions: AgentExecutionOptions = {}) {
    const requestContext = streamOptions.requestContext ?? new RequestContext();
    requestContext.set(SESSION_GRANTS_CONTEXT_KEY, this.getGrants());
    const options: AgentExecutionOptions = {
      ...this.executionDefaults,
      ...streamOptions,
      memory: {
        resource: this.resourceId,
        thread: this.currentThreadId,
      },
      requestContext,
    };
    return this.agent.queueMessage(message, {
      resourceId: this.resourceId,
      threadId: this.currentThreadId,
      ifIdle: { behavior: "wake", streamOptions: options },
    });
  }

  async followUp(message: AgentMessageInput, streamOptions: AgentExecutionOptions = {}) {
    const monitor = await this.ensureFollowUpMonitor();
    if (!monitor) {
      return { action: "blocked" as const, followUpId: null };
    }

    const target: QueuedFollowUp = {
      id: randomUUID(),
      message,
      streamOptions,
      subscription: monitor.subscription,
    };

    const activeRunId = this.agent.getActiveThreadRunId({
      resourceId: this.resourceId,
      threadId: this.currentThreadId,
    });

    if (activeRunId) {
      this.followUps.push(target);
      this.followUpTargets.set(target.id, target);
      this.followUpCount = this.followUps.length;
      this.consumeFollowUpMonitor(monitor);
      return { action: "queued" as const, followUpId: target.id };
    }

    const started = await this.startFollowUp(target);
    if (started) {
      this.consumeFollowUpMonitor(monitor);
      return { action: "started" as const, followUpId: target.id };
    }
    this.stopFollowUpMonitor(monitor);
    return { action: "blocked" as const, followUpId: target.id };
  }

  private async startFollowUp(target: QueuedFollowUp): Promise<boolean> {
    try {
      const result = this.agent.queueMessage(target.message, {
        resourceId: this.resourceId,
        threadId: this.currentThreadId,
        ifIdle: { behavior: "wake", streamOptions: target.streamOptions },
      });
      const accepted = await result.accepted;
      if ("runId" in accepted && accepted.action !== "blocked") return true;
    } catch {
      // 启动失败:目标会被下方清理逻辑回收
    }
    if (this.followUpTargets.has(target.id)) {
      target.subscription.unsubscribe();
      this.followUpTargets.delete(target.id);
    }
    return false;
  }

  private async ensureFollowUpMonitor(): Promise<
    | {
        pending: Promise<AgentThreadSubscription>;
        subscription: AgentThreadSubscription;
      }
    | undefined
  > {
    if (!this.followUpMonitor) {
      this.followUpMonitor = this.agent.subscribeToThread({
        resourceId: this.resourceId,
        threadId: this.currentThreadId,
      });
    }
    const pending = this.followUpMonitor;
    const subscription = await pending;
    if (this.followUpMonitor !== pending) {
      subscription.unsubscribe();
      return undefined;
    }
    return { pending, subscription };
  }

  private consumeFollowUpMonitor(monitor: {
    pending: Promise<AgentThreadSubscription>;
    subscription: AgentThreadSubscription;
  }): void {
    if (this.followUpMonitorConsumer) return;
    let consumer!: Promise<void>;
    consumer = (async () => {
      try {
        for await (const chunk of monitor.subscription.stream) {
          if (!isTerminalAgentChunk(chunk)) continue;
          const next = this.followUps.shift();
          this.followUpCount = this.followUps.length;
          if (next) {
            if (!(await this.startFollowUp(next))) break;
            continue;
          }
          break;
        }
      } finally {
        if (this.followUpMonitor === monitor.pending) this.followUpMonitor = undefined;
        if (this.followUpMonitorConsumer === consumer) this.followUpMonitorConsumer = undefined;
        monitor.subscription.unsubscribe();
      }
    })();
    this.followUpMonitorConsumer = consumer;
    void consumer.catch(() => undefined);
  }

  private stopFollowUpMonitor(monitor: {
    pending: Promise<AgentThreadSubscription>;
    subscription: AgentThreadSubscription;
  }): void {
    if (this.followUpMonitor === monitor.pending) this.followUpMonitor = undefined;
    monitor.subscription.unsubscribe();
  }

  async steer(message: AgentMessageInput, streamOptions: AgentExecutionOptions = {}) {
    const activeRunId = this.agent.getActiveThreadRunId({
      resourceId: this.resourceId,
      threadId: this.currentThreadId,
    });
    const release = activeRunId
      ? await this.agent.subscribeToThread({
          resourceId: this.resourceId,
          threadId: this.currentThreadId,
        })
      : undefined;
    this.abort();
    if (activeRunId && release) {
      try {
        for await (const chunk of release.stream) {
          if ((chunk as AgentStreamChunk).runId !== activeRunId) continue;
          if (isTerminalAgentChunk(chunk)) break;
        }
      } finally {
        release.unsubscribe();
      }
    }
    return this.sendMessage(message, streamOptions);
  }

  notifyPolicyChange(summary: string, attributes: Record<string, string> = {}): void {
    const result = this.agent.sendSignal(
      {
        type: "reactive",
        contents: summary,
        attributes: { type: "policy-change", ...attributes },
      },
      {
        resourceId: this.resourceId,
        threadId: this.currentThreadId,
        ifActive: { behavior: "deliver" },
        ifIdle: { behavior: "discard" },
      },
    );
    void result.accepted.catch(() => undefined);
  }

  sendNotification(notification: WorkNotificationInput) {
    if (Array.isArray(notification)) {
      return this.agent.sendNotificationSignal(notification, {
        resourceId: this.resourceId,
        threadId: this.currentThreadId,
      });
    }
    return this.agent.sendNotificationSignal(notification, {
      resourceId: this.resourceId,
      threadId: this.currentThreadId,
    });
  }

  abort(): boolean {
    const subscription = [...this.subscriptions].find(
      ([, threadId]) => threadId === this.currentThreadId,
    )?.[0];
    const aborted = subscription?.abort() ?? false;
    this.clearFollowUps();
    return (
      this.agent.abortThreadStream({
        resourceId: this.resourceId,
        threadId: this.currentThreadId,
      }) || aborted
    );
  }

  private clearFollowUps(): void {
    const monitor = this.followUpMonitor;
    this.followUpMonitor = undefined;
    this.followUpMonitorConsumer = undefined;
    void monitor?.then((subscription) => subscription.unsubscribe()).catch(() => undefined);
    for (const followUp of this.followUpTargets.values()) {
      followUp.subscription.unsubscribe();
    }
    this.followUps.length = 0;
    this.followUpTargets.clear();
    this.followUpCount = 0;
  }

  getDisplayState(): WorkDisplayState {
    const activeRunId =
      this.agent.getActiveThreadRunId({
        resourceId: this.resourceId,
        threadId: this.currentThreadId,
      }) ?? null;
    return {
      status: activeRunId ? "running" : "idle",
      threadId: this.currentThreadId,
      activeRunId,
      modeId: this.modeId,
      followUpCount: this.followUpCount,
      grants: this.getGrants(),
      state: this.getState(),
      tasks: [],
      suspendedRuns: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

class WorkSessionHost {
  private readonly sessions = new Map<string, WorkSession>();

  private sessionKey(resourceId: string, scope?: string): string {
    return JSON.stringify([resourceId, scope ?? SESSION_SCOPE_DEFAULT]);
  }

  getOrCreate(options: {
    resourceId: string;
    scope?: string;
    threadId: string;
    agent?: Agent;
  }): WorkSession {
    const key = this.sessionKey(options.resourceId, options.scope);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.setThreadId(options.threadId);
      if (options.agent) existing.setAgent(options.agent);
      return existing;
    }
    const session = new WorkSession({
      id: key,
      resourceId: options.resourceId,
      scope: options.scope,
      threadId: options.threadId,
      ...(options.agent ? { agent: options.agent } : {}),
    });
    this.sessions.set(key, session);
    return session;
  }

  get(resourceId: string, scope?: string): WorkSession | undefined {
    return this.sessions.get(this.sessionKey(resourceId, scope));
  }

  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.abort();
    return this.sessions.delete(sessionId);
  }
}

export const workSessionHost = new WorkSessionHost();
