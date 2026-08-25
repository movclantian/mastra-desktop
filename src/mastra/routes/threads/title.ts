/**
 * 显式线程标题生成。
 *
 * 首轮消息的自动标题由 Agent 的 `options.generateTitle` 官方路径处理；
 * 本路由只服务于用户从侧边栏手动触发的重新命名操作。
 */
import type { RequestContext } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import { workError } from "../../errors";
import { getMemoryConfig } from "../../memory";
import { getOwnedThread, getWorkMemoryForThread } from "./shared";

export async function generateThreadTitleHelper(options: {
  threadId: string;
  resourceId: string;
  userMessage?: string;
  force?: boolean;
  requestContext: RequestContext;
}): Promise<string | null> {
  const memory = await getWorkMemoryForThread(
    options.requestContext,
    options.threadId,
    options.resourceId,
  );
  await memory.settled();
  const thread = await getOwnedThread(memory, options.threadId, options.resourceId);
  if (!thread) return null;
  const storedTitle = thread.title?.trim() || "";

  const memoryConfig = await getMemoryConfig(options.resourceId);
  if (!options.force && !memoryConfig.generateTitle) {
    return storedTitle || "New Chat";
  }

  // 非强制模式下，如果标题已被用户显式修改且不是草稿/默认标题，则跳过
  if (!options.force && storedTitle && storedTitle !== "New Chat" && !thread.metadata?.draft) {
    return storedTitle;
  }

  let textContent = options.userMessage?.trim();
  if (!textContent) {
    const { messages } = await memory.recall({
      threadId: options.threadId,
      resourceId: options.resourceId,
      perPage: false,
    });
    const firstUserMsg = (messages ?? []).find((m) => m.role === "user");
    if (firstUserMsg) {
      textContent = (firstUserMsg.content.parts ?? [])
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join(" ")
        .trim();
    }
  }

  if (!textContent) return storedTitle || "New Chat";

  let generatedTitle = "";

  try {
    const { mastra } = await import("../../index");
    const agent = mastra.getAgentById("mastra-work-agent");
    const result = await agent.generateTitleFromUserMessage({
      message: textContent.slice(0, 600),
      requestContext: options.requestContext,
    });
    const raw = (result ?? "")
      .replace(/^["'“”‘`]+|["'“”‘`]+$/g, "")
      .replace(/^(标题|Title|主题)[:：]\s*/i, "")
      .replace(/[。，！？,!?#\n\r]/g, "")
      .trim();

    if (raw.length > 0) {
      generatedTitle = raw.slice(0, 20);
    }
  } catch {
    // 手动触发失败时继续使用确定性的首句标题。
  }

  // 兜底回退：取首行文字去除 Markdown 标记后前 15 字符
  if (!generatedTitle) {
    const cleanFallback = textContent
      .split("\n")[0]
      .replace(/^[#\-*>\s0-9.]+/, "")
      .replace(/[。，！？,!?#]/g, "")
      .trim();
    generatedTitle = cleanFallback.slice(0, 16) || "新对话";
  }

  await memory.updateThread({
    id: options.threadId,
    title: generatedTitle,
    metadata: {
      ...thread.metadata,
      draft: false,
    },
  });

  return generatedTitle;
}

// POST /work/threads/:threadId/generate-title
export const generateThreadTitleRoute = registerApiRoute("/work/threads/:threadId/generate-title", {
  method: "POST",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const body = (await c.req.json()) as {
      resourceId?: string;
      force?: boolean;
    };
    if (!body.resourceId) {
      throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    }
    const title = await generateThreadTitleHelper({
      threadId,
      resourceId: body.resourceId,
      force: body.force ?? true,
      requestContext: c.get("requestContext"),
    });
    if (!title) {
      throw workError("THREAD_NOT_FOUND");
    }
    return c.json({ title });
  },
});
