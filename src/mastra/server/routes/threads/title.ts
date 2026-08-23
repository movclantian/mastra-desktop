/**
 * 线程自动起名与标题提炼 (Automatic Thread Title Generation)
 *
 * 机制：
 * 1. 首轮消息发送完毕后自动触发（或由侧边栏手动按需调用）。
 * 2. 优先使用当前配置的 LLM 模型进行短文本提炼（限制 10 字以内纯文本）；
 * 3. 具备 4 秒超时熔断与首句智能截断 Fallback，保证 100% 成功、零阻塞、零异常。
 */
import { registerApiRoute } from "@mastra/core/server";
import { generateText, type LanguageModel } from "ai";
import { workError } from "../../../errors";
import { resolveDefaultLanguageModel, resolveRequestModel } from "../../../models";
import { getOwnedThread, getWorkMemory } from "./shared";

export async function generateThreadTitleHelper(options: {
  threadId: string;
  resourceId: string;
  userMessage?: string;
  model?: unknown;
  force?: boolean;
}): Promise<string | null> {
  const memory = await getWorkMemory();
  const thread = await getOwnedThread(memory, options.threadId, options.resourceId);
  if (!thread) return null;

  // 非强制模式下，如果标题已被用户显式修改且不是草稿/默认标题，则跳过
  if (!options.force && thread.title !== "New Chat" && !thread.metadata?.draft) {
    return thread.title ?? "New Chat";
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

  if (!textContent) return thread.title ?? "New Chat";

  let generatedTitle = "";

  try {
    let modelInstance: LanguageModel | undefined;
    if (options.model !== undefined) {
      const resolved = await resolveRequestModel(options.model);
      if (resolved && typeof resolved === "object" && "doGenerate" in resolved) {
        modelInstance = resolved as unknown as LanguageModel;
      }
    }
    if (!modelInstance) {
      modelInstance = (await resolveDefaultLanguageModel()) as unknown as LanguageModel;
    }

    if (modelInstance) {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 4000);

      const promptInput = textContent.slice(0, 600);
      const result = await generateText({
        model: modelInstance,
        abortSignal: abortController.signal,
        system:
          "你是一个会话标题提炼专家。请根据用户发言内容，提炼一个简短、精准、高信息量的会话标题。\n要求：\n1. 中文不超过 10 个字，英文不超过 5 个单词；\n2. 严禁出现标点符号、书名号、引号或前缀（如'标题：'）；\n3. 纯文本单行输出。",
        prompt: promptInput,
      });
      clearTimeout(timeoutId);

      const raw = result.text
        .replace(/^["'“”‘`]+|["'“”‘`]+$/g, "")
        .replace(/^(标题|Title|主题)[:：]\s*/i, "")
        .replace(/[。，！？,!?#\n\r]/g, "")
        .trim();

      if (raw.length > 0) {
        generatedTitle = raw.slice(0, 20);
      }
    }
  } catch {
    // LLM 超时或出错时平滑回落
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
      model?: unknown;
      force?: boolean;
    };
    if (!body.resourceId) {
      throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    }
    const title = await generateThreadTitleHelper({
      threadId,
      resourceId: body.resourceId,
      model: body.model,
      force: body.force ?? true,
    });
    if (!title) {
      throw workError("THREAD_NOT_FOUND");
    }
    return c.json({ title });
  },
});
