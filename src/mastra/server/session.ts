import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentExecutionOptions,
  AgentMessageInput,
  AgentThreadSubscription,
} from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { mastraWorkAgent } from "../agents";
import { SESSION_GRANTS_CONTEXT_KEY, type ToolCategory } from "../agents/permissions";

/** Live state mirrors the Session state boundary in agent-controller.mdx. */
export const workSessionStateSchema = z.object({
  activeProject: z.string().optional(),
  yolo: z.boolean().optional(),
  count: z.number().int().optional(),
});

export type WorkSessionState = z.infer<typeof workSessionStateSchema>;
export interface WorkSessionGrants {
  categories: ToolCategory[];
  tools: string[];
}

export const SESSION_SCOPE_DEFAULT = "workbench";

export interface WorkDisplayState {
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

function sessionKey(resourceId: string, scope: string): string {
  return `${resourceId}\u0000${scope}`;
}

function withSessionGrants(
  requestContext: RequestContext | undefined,
  grants: WorkSessionGrants,
  state: WorkSessionState,
) {
  if (!requestContext) return;
  requestContext.set(SESSION_GRANTS_CONTEXT_KEY, {
    categories: [...grants.categories],
    tools: [...grants.tools],
    yolo: state.yolo === true,
  });
}

function mergeRequestContexts(
  base: RequestContext | undefined,
  override: RequestContext | undefined,
): RequestContext | undefined {
  if (!base && !override) return undefined;
  const merged = new RequestContext();
  for (const [key, value] of base?.entries() ?? []) merged.setRaw(key, value);
  for (const [key, value] of override?.entries() ?? []) merged.setRaw(key, value);
  return merged;
}

type AgentStreamChunk = {
  type?: unknown;
  finishReason?: unknown;
  payload?: unknown;
  runId?: unknown;
};

/** Match Agent.subscribeToThread(): tool-call step finishes are not run finishes. */
export function isTerminalAgentChunk(chunk: AgentStreamChunk): boolean {
  if (chunk.type === "error" || chunk.type === "abort") return true;
  const payload =
    typeof chunk.payload === "object" && chunk.payload !== null
      ? (chunk.payload as { finishReason?: unknown })
      : undefined;
  const finishReason = chunk.finishReason ?? payload?.finishReason;
  return chunk.type === "finish" && finishReason !== "tool-calls";
}

/**
 * 通知收件箱记录的形状,从框架方法签名派生而不是手写 —— beta 期字段变化时
 * 由 tsc 报错而非静默漂移。
 */
export type WorkNotificationInput = Parameters<Agent["sendNotificationSignal"]>[0];

interface QueuedFollowUp {  id: string;
  message: AgentMessageInput;
  streamOptions: AgentExecutionOptions;
  subscription: AgentThreadSubscription;
  runId: Promise<string | null>;
  resolveRunId: (runId: string | null) => void;
}

export class WorkSession {
  readonly resourceId: string;
  readonly scope: string;
  private currentThreadId: string;
  private readonly agent: Agent;
  private readonly subscriptions = new Map<AgentThreadSubscription, string>();
  private readonly followUps: QueuedFollowUp[] = [];
  private readonly followUpTargets = new Map<string, QueuedFollowUp>();
  private followUpMonitor?: Promise<AgentThreadSubscription>;
  private followUpMonitorConsumer?: Promise<void>;
  private executionDefaults: AgentExecutionOptions = {};
  private readonly categoryGrants = new Set<ToolCategory>();
  private readonly toolGrants = new Set<string>();
  private state: WorkSessionState = {};
  private modeId = "plan";
  private followUpCount = 0;

  constructor(options: { resourceId: string; scope: string; threadId: string; agent?: Agent }) {
    this.resourceId = options.resourceId;
    this.scope = options.scope;
    this.currentThreadId = options.threadId;
    this.agent = options.agent ?? mastraWorkAgent;
  }

  get threadId(): string {
    return this.currentThreadId;
  }

  bindThread(threadId: string): void {
    if (threadId === this.currentThreadId) return;
    this.clearFollowUps();
    for (const [subscription, subscribedThreadId] of this.subscriptions) {
      if (subscribedThreadId === this.currentThreadId) this.releaseSubscription(subscription);
    }
    this.currentThreadId = threadId;
  }

  setMode(modeId: string): void {
    this.modeId = modeId;
  }

  setExecutionDefaults(options: AgentExecutionOptions): void {
    this.executionDefaults = {
      ...options,
      requestContext: mergeRequestContexts(options.requestContext, undefined),
    };
  }

  getState(): WorkSessionState {
    return { ...this.state };
  }

  setState(updates: unknown): WorkSessionState {
    if (typeof updates !== "object" || updates === null || Array.isArray(updates)) {
      throw new Error("Session state updates must be an object");
    }
    const parsed = workSessionStateSchema.parse({ ...this.state, ...updates });
    this.state = parsed;
    return this.getState();
  }

  grantCategory(category: ToolCategory): void {
    this.categoryGrants.add(category);
  }

  revokeCategory(category: ToolCategory): void {
    this.categoryGrants.delete(category);
  }

  grantTool(toolName: string): void {
    this.toolGrants.add(toolName);
  }

  revokeTool(toolName: string): void {
    this.toolGrants.delete(toolName);
  }

  getGrants(): WorkSessionGrants {
    return {
      categories: [...this.categoryGrants],
      tools: [...this.toolGrants],
    };
  }

  async subscribe(threadId = this.currentThreadId): Promise<AgentThreadSubscription> {
    this.bindThread(threadId);
    const subscription = await this.agent.subscribeToThread({
      resourceId: this.resourceId,
      threadId,
    });
    this.subscriptions.set(subscription, threadId);
    return subscription;
  }

  async subscribeFollowUp(
    followUpId: string,
  ): Promise<{ subscription: AgentThreadSubscription; runId: string } | null> {
    const target = this.followUpTargets.get(followUpId);
    if (!target) return null;
    const runId = await target.runId;
    return runId ? { subscription: target.subscription, runId } : null;
  }

  releaseSubscription(subscription: AgentThreadSubscription): void {
    if (this.subscriptions.has(subscription)) {
      subscription.unsubscribe();
      this.subscriptions.delete(subscription);
    }
    for (const [followUpId, target] of this.followUpTargets) {
      if (target.subscription !== subscription) continue;
      target.resolveRunId(null);
      target.subscription.unsubscribe();
      this.followUpTargets.delete(followUpId);
    }
  }

  applyRequestContext(requestContext: RequestContext): void {
    withSessionGrants(requestContext, this.getGrants(), this.state);
  }

  sendMessage(message: AgentMessageInput, streamOptions: AgentExecutionOptions = {}) {
    const effectiveOptions = {
      ...this.executionDefaults,
      ...streamOptions,
      requestContext: mergeRequestContexts(
        this.executionDefaults.requestContext,
        streamOptions.requestContext,
      ),
    };
    withSessionGrants(effectiveOptions.requestContext, this.getGrants(), this.state);
    return this.agent.sendMessage(message, {
      ...(effectiveOptions.runId ? { runId: effectiveOptions.runId } : {}),
      resourceId: this.resourceId,
      threadId: this.currentThreadId,
      ifActive: { behavior: "deliver" },
      ifIdle: { behavior: "wake", streamOptions: effectiveOptions },
    });
  }

  async followUp(message: AgentMessageInput, streamOptions: AgentExecutionOptions = {}) {
    const effectiveOptions = {
      ...this.executionDefaults,
      ...streamOptions,
      requestContext: mergeRequestContexts(
        this.executionDefaults.requestContext,
        streamOptions.requestContext,
      ),
    };
    withSessionGrants(effectiveOptions.requestContext, this.getGrants(), this.state);
    const subscription = await this.agent.subscribeToThread({
      resourceId: this.resourceId,
      threadId: this.currentThreadId,
    });
    let resolveRunId!: (runId: string | null) => void;
    const target: QueuedFollowUp = {
      id: randomUUID(),
      message,
      streamOptions: effectiveOptions,
      subscription,
      runId: new Promise((resolve) => {
        resolveRunId = resolve;
      }),
      resolveRunId: (runId) => resolveRunId(runId),
    };
    this.followUpTargets.set(target.id, target);

    // Establish the monitor before checking the run, but do not consume it until
    // the target is queued. A terminal chunk that arrives in this window stays
    // buffered and cannot overtake the local, steer-cancellable queue.
    let monitor:
      | {
          pending: Promise<AgentThreadSubscription>;
          subscription: AgentThreadSubscription;
        }
      | undefined;
    try {
      monitor = await this.ensureFollowUpMonitor();
    } catch {
      target.resolveRunId(null);
      target.subscription.unsubscribe();
      this.followUpTargets.delete(target.id);
      return { action: "blocked" as const, followUpId: target.id };
    }
    if (!monitor || !this.followUpTargets.has(target.id)) {
      target.resolveRunId(null);
      target.subscription.unsubscribe();
      this.followUpTargets.delete(target.id);
      return { action: "blocked" as const, followUpId: target.id };
    }
    if (
      this.agent.getActiveThreadRunId({
        resourceId: this.resourceId,
        threadId: this.currentThreadId,
      })
    ) {
      this.followUps.push(target);
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
      if ("runId" in accepted && accepted.action !== "blocked") {
        target.resolveRunId(accepted.runId);
        return true;
      }
      target.resolveRunId(null);
    } catch {
      target.resolveRunId(null);
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

  /**
   * 会话策略变更(模式切换 / 工具类别或单个工具授权 / 审批规则改写)。
   *
   * instructions 只在请求开始时求值一次,所以中途改掉的 mode 与 grants 对
   * **当前正在跑的 run** 是不可见的 —— agent 会继续按旧约束推理。这条 reactive
   * 信号把变更直接送进运行中的 agent loop(docs/en/docs/harness/signals.mdx)。
   *
   * ifIdle 取 "discard" 而不是 "persist":线程空闲时下一次请求的 instructions
   * 本来就会带上新策略,persist 只会往历史里堆一条永远重复的提醒。
   */
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
    // 策略变更是尽力而为的旁路通知:投递失败不该让改模式的 HTTP 请求失败
    void result.accepted.catch(() => undefined);
  }

  /**
   * 外部事件 → 通知收件箱。ingress 阶段落库成 notification 记录,再由 agent 的
   * 投递策略决定是立刻发信号还是攒进 <notification-summary>(默认策略按优先级:
   * urgent 立即、low 两种情况都批量)。记录的全文由 notification_inbox 工具读取。
   */
  sendNotification(notification: WorkNotificationInput) {
    return this.agent.sendNotificationSignal(notification, {
      resourceId: this.resourceId,
      threadId: this.currentThreadId,
    });
  }

  abort(): boolean {    const subscription = [...this.subscriptions].find(
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
      followUp.resolveRunId(null);
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

  dispose(): void {
    for (const subscription of this.subscriptions.keys()) subscription.unsubscribe();
    this.subscriptions.clear();
    this.clearFollowUps();
  }
}

export class WorkSessionHost {
  private readonly sessions = new Map<string, WorkSession>();

  getOrCreate(options: { resourceId: string; scope?: string; threadId: string }): WorkSession {
    const scope = options.scope?.trim() || SESSION_SCOPE_DEFAULT;
    const key = sessionKey(options.resourceId, scope);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.bindThread(options.threadId);
      return existing;
    }
    const session = new WorkSession({ ...options, scope });
    this.sessions.set(key, session);
    return session;
  }

  get(resourceId: string, scope = SESSION_SCOPE_DEFAULT): WorkSession | undefined {
    return this.sessions.get(sessionKey(resourceId, scope));
  }

  dispose(resourceId: string, scope = SESSION_SCOPE_DEFAULT): void {
    const key = sessionKey(resourceId, scope);
    this.sessions.get(key)?.dispose();
    this.sessions.delete(key);
  }
}

export const workSessionHost = new WorkSessionHost();
