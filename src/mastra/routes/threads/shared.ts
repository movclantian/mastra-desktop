/**
 * 线程路由共享依赖:Memory 实例获取、resourceId 归属校验(getOwnedThread)、
 * 本地请求信任边界(isTrustedLocalRequest)与信号消息归一化。
 */
import type { MastraDBMessage } from "@mastra/core/agent/message-list";
import type { RequestContext } from "@mastra/core/request-context";
import type { ContextWithMastra } from "@mastra/core/server";
import type { Memory } from "@mastra/memory";
import { DEFAULT_AGENT_PROFILE_ID } from "../../../shared/agent-contract";

export type OwnedThread = Awaited<ReturnType<Memory["getThreadById"]>>;

// ponytail: one desktop host owns these writes; use storage transactions if hosts are shared.
const threadWrites = new Map<string, Promise<void>>();

/** State snapshots and deletion must not race: Mastra state signals save the whole thread. */
export async function withThreadWrite<T>(
  resourceId: string,
  threadId: string,
  write: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([resourceId, threadId]);
  const operation = (threadWrites.get(key) ?? Promise.resolve()).then(write);
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  threadWrites.set(key, settled);
  try {
    return await operation;
  } finally {
    if (threadWrites.get(key) === settled) threadWrites.delete(key);
  }
}

/** Invalidate derived observations before rewriting the source history. */
export async function deleteThreadMessages(
  memory: Memory,
  threadId: string,
  resourceId: string,
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) return;
  await memory.settled();
  await (await memory.omEngine)?.clear(threadId, resourceId);
  await memory.deleteMessages(messageIds);
  await memory.settled();
}

/** Restore session user signals to ordinary chat turns before conversion. */
export function normalizeChatHistoryMessages(messages: MastraDBMessage[]): MastraDBMessage[] {
  return messages.flatMap<MastraDBMessage>((message) => {
    if (message.role === "user" || message.role === "assistant") return [message];
    if (message.role !== "signal" || message.type !== "user") return [];

    const signalMetadata = message.content.metadata?.signal;
    const metadata =
      signalMetadata && typeof signalMetadata === "object"
        ? (signalMetadata as { metadata?: unknown }).metadata
        : undefined;
    return [
      {
        ...message,
        role: "user",
        type: "v2",
        content: {
          ...message.content,
          ...(metadata && typeof metadata === "object" ? { metadata } : {}),
        },
      } as MastraDBMessage,
    ];
  });
}

/**
 * 线程路由共享依赖:获取 Agent 的 Memory 实例。
 * 动态 import 规避路由模块与 Mastra 实例间的循环依赖
 * (index.ts 注册路由 → 路由取 mastra 实例)。
 *
 * agent.getMemory() 的静态返回类型是基类 MastraMemory,缺少 @mastra/memory 独有的
 * settled() 等方法;实例本身就是 Memory(见 src/mastra/memory),
 * 因此在此处一次性收窄,调用方不必各自断言。
 */
export async function getWorkMemory(requestContext: RequestContext): Promise<Memory> {
  const { mastra } = await import("../../index");
  const agent = mastra.getAgentById(DEFAULT_AGENT_PROFILE_ID);
  const memory = await agent.getMemory({ requestContext });
  if (!memory) {
    throw new Error("Agent memory is not configured");
  }
  return memory as Memory;
}

/**
 * 所有按 threadId 访问的业务路由都必须先经过这一个边界检查。
 * 线程 ID 属于不可信输入；resourceId 是当前桌面用户的唯一租户边界。
 */
export async function getOwnedThread(
  memory: Memory,
  threadId: string,
  resourceId: string | undefined,
): Promise<NonNullable<OwnedThread> | null> {
  if (!resourceId?.trim()) return null;
  const thread = await memory.getThreadById({ threadId });
  return thread && thread.resourceId === resourceId ? thread : null;
}

/**
 * 阻断网页对本机敏感 API 的跨站请求。打包后的 file:// 渲染器发送 null Origin，
 * 开发态渲染器使用 localhost；无 Origin 请求保留给 Mastra 内部和本地客户端。
 */
export function isTrustedLocalRequest(c: ContextWithMastra): boolean {
  const origin = c.req.header("origin");
  if (!origin || origin === "null") return true;
  try {
    const hostname = new URL(origin).hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

/**
 * 线程业务 metadata 类型:工作区绑定 / 模式 / 权限规则 / 原生模型选择 /
 * 子代理与草稿标记。
 */
export type ThreadMetadata = {
  /** 当前线程使用的 Agent 或 Agent 团队 profile。缺省为 mastra-work-agent。 */
  agentProfileId?: string;
  pinned?: boolean;
  archivedAt?: string | null;
  draft?: boolean;
  /**
   * 会话模式(plan / build / review,见 src/mastra/agents/permissions.ts)。
   * 缺省视为默认模式;非法值由 resolveMode 回落,故不需要在路由层校验。
   */
  currentModeId?: string;
  /**
   * 工具审批规则(官方 PermissionRules 形状,见 src/mastra/agents/permissions.ts)。
   * 缺省使用工作台默认规则；用户保存的分类和单工具规则覆盖默认值。
   */
  permissionRules?: {
    categories?: Record<string, string>;
    tools?: Record<string, string>;
  };
  /** Mastra Session.model persists one selected router ID per thread. */
  currentModelId?: string;
  reasoningEffort?: string;
  /**
   * 线程绑定的工作区目录(绝对路径)。首条消息时锁定:
   * - 显式绑定:用户在 promptInput 选择器选定的本地目录
   * - 隐式绑定:<threadsRoot>/<threadId>/(线程专属默认目录,用户同样可浏览)
   */
  workspacePath?: string;
  /** true = 用户显式选定的目录;false/缺省 = 隐式默认目录(两者都可浏览) */
  workspaceExplicit?: boolean;
  contextUsage?: Record<string, unknown> | null;
  contextUsageVersion?: number;
};
