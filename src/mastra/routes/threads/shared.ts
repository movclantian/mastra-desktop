/**
 * 线程路由共享依赖:Memory 实例获取、resourceId 归属校验(getOwnedThread)、
 * 本地请求信任边界(isTrustedLocalRequest)与信号消息归一化。
 */
import type { MastraDBMessage } from "@mastra/core/agent/message-list";
import type { RequestContext } from "@mastra/core/request-context";
import type { ContextWithMastra } from "@mastra/core/server";
import type { Memory } from "@mastra/memory";

export type OwnedThread = Awaited<ReturnType<Memory["getThreadById"]>>;

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
 * settled() / summarizeThread() 等方法;实例本身就是 Memory(见 src/mastra/memory),
 * 因此在此处一次性收窄,调用方不必各自断言。
 */
export async function getWorkMemory(requestContext: RequestContext): Promise<Memory> {
  const { mastra } = await import("../../index");
  const agent = mastra.getAgentById("mastra-work-agent");
  const memory = await agent.getMemory({ requestContext });
  if (!memory) {
    throw new Error("Agent memory is not configured");
  }
  return memory as Memory;
}

/** Resolve the Memory instance used by thread routes. OM follows the request model. */
export async function getWorkMemoryForThread(
  requestContext: RequestContext,
  _threadId: string,
  _resourceId: string,
): Promise<Memory> {
  return getWorkMemory(requestContext);
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
