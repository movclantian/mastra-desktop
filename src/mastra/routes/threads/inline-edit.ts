import { registerApiRoute } from "@mastra/core/server";
import { generateText, type LanguageModel } from "ai";
import { z } from "zod";
import { getAgentProfile } from "../../agents/custom";
import { resolveMode } from "../../agents/modes";
import { workError } from "../../errors";
import { resolveConfiguredModel, resolveDefaultLanguageModel } from "../../models";
import { getOwnedThread, getWorkMemoryForThread } from "./shared";
import type { ThreadMetadata } from "./types";

const inlineEditSchema = z.object({
  resourceId: z.string().min(1),
  path: z.string().min(1),
  language: z.string().max(40).optional(),
  selectedText: z.string().min(1).max(24_000),
  beforeContext: z.string().max(8_000).optional(),
  afterContext: z.string().max(8_000).optional(),
  instruction: z.string().max(2_000).optional(),
  modelSelection: z
    .object({ providerId: z.string().min(1), modelId: z.string().min(1) })
    .optional(),
});

const inlineCompletionSchema = z.object({
  resourceId: z.string().min(1),
  path: z.string().min(1),
  language: z.string().max(40).optional(),
  prefix: z.string().max(1_000).optional(),
  beforeContext: z.string().max(12_000).optional(),
  afterContext: z.string().max(8_000).optional(),
  modelSelection: z
    .object({ providerId: z.string().min(1), modelId: z.string().min(1) })
    .optional(),
});

function partText(message: { content?: { parts?: unknown[] } }): string {
  return (message.content?.parts ?? [])
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return (fenced?.[1] ?? trimmed).trim();
}

export const inlineEditRoute = registerApiRoute("/work/threads/:threadId/inline-edit", {
  method: "POST",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const parsed = inlineEditSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw workError("VALIDATION_FAILED", { text: "内联编辑参数无效" });
    }

    const input = parsed.data;
    const memory = await getWorkMemoryForThread(
      c.get("requestContext"),
      threadId,
      input.resourceId,
    );
    const thread = await getOwnedThread(memory, threadId, input.resourceId);
    if (!thread) throw workError("THREAD_NOT_FOUND");

    const metadata = (thread.metadata ?? {}) as ThreadMetadata;
    const mode = resolveMode(metadata.modeId);
    const snapshot = metadata.modelSelectionByMode?.[mode.id];
    const selectedModel = input.modelSelection ?? snapshot;
    const resolved = selectedModel
      ? await resolveConfiguredModel(selectedModel.providerId, selectedModel.modelId)
      : await resolveDefaultLanguageModel();
    if (!resolved) throw workError("MODEL_NOT_CONFIGURED");

    const recalled = await memory.recall({
      threadId,
      resourceId: input.resourceId,
      perPage: false,
    });
    const history = (recalled.messages ?? [])
      .map((message) => {
        const text = partText(message);
        return text ? `${message.role}: ${text.slice(0, 1_200)}` : "";
      })
      .filter(Boolean)
      .slice(-8)
      .join("\n\n");

    const profile = await getAgentProfile(metadata.agentProfileId);
    const instruction =
      input.instruction?.trim() || "改进选中的代码,保持原有行为、接口和外部可观察结果不变。";
    const prompt = [
      `文件: ${input.path}`,
      input.language ? `语言: ${input.language}` : "",
      "只返回需要替换选区的完整代码,不要 Markdown 代码围栏、解释或前后缀。",
      "如果用户要求无法安全完成,仍返回最小且可编译的选区代码。",
      `修改要求: ${instruction}`,
      "线程最近上下文:",
      history || "(无)",
      "选区前的代码:",
      input.beforeContext || "(无)",
      "待修改选区:",
      input.selectedText,
      "选区后的代码:",
      input.afterContext || "(无)",
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await generateText({
      model: resolved as unknown as LanguageModel,
      system: [
        "你是集成在代码编辑器中的内联重构助手。",
        "遵循当前 Agent 的工作指令,但只输出选区替换内容。",
        mode.instructions,
        profile.instructions,
      ].join("\n\n"),
      prompt,
      maxOutputTokens: 4_096,
    });
    const text = stripCodeFence(result.text);
    if (!text) throw workError("VALIDATION_FAILED", { text: "模型没有返回可替换的代码" });
    return c.json({ text });
  },
});

export const inlineCompletionRoute = registerApiRoute("/work/threads/:threadId/inline-completion", {
  method: "POST",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const parsed = inlineCompletionSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw workError("VALIDATION_FAILED", { text: "AI 补全参数无效" });
    }

    const input = parsed.data;
    const memory = await getWorkMemoryForThread(
      c.get("requestContext"),
      threadId,
      input.resourceId,
    );
    const thread = await getOwnedThread(memory, threadId, input.resourceId);
    if (!thread) throw workError("THREAD_NOT_FOUND");

    const metadata = (thread.metadata ?? {}) as ThreadMetadata;
    const mode = resolveMode(metadata.modeId);
    const snapshot = metadata.modelSelectionByMode?.[mode.id];
    const selectedModel = input.modelSelection ?? snapshot;
    const resolved = selectedModel
      ? await resolveConfiguredModel(selectedModel.providerId, selectedModel.modelId)
      : await resolveDefaultLanguageModel();
    if (!resolved) throw workError("MODEL_NOT_CONFIGURED");

    const recalled = await memory.recall({
      threadId,
      resourceId: input.resourceId,
      perPage: false,
    });
    const history = (recalled.messages ?? [])
      .map((message) => {
        const text = partText(message);
        return text ? `${message.role}: ${text.slice(0, 1_200)}` : "";
      })
      .filter(Boolean)
      .slice(-8)
      .join("\n\n");
    const profile = await getAgentProfile(metadata.agentProfileId);
    const prompt = [
      `文件: ${input.path}`,
      input.language ? `语言: ${input.language}` : "",
      "你正在编辑器光标处提供 AI 补全。只返回需要插入光标处的代码,不要 Markdown 围栏、解释、重复已有前缀或后缀。",
      `当前词前缀: ${input.prefix || "(无)"}`,
      "线程最近上下文:",
      history || "(无)",
      "光标前代码:",
      input.beforeContext || "(无)",
      "光标后代码:",
      input.afterContext || "(无)",
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await generateText({
      model: resolved as unknown as LanguageModel,
      system: [
        "你是集成在代码编辑器中的 AI 补全助手。",
        "遵循当前 Agent 的工作指令,但输出必须是可直接插入光标处的代码片段。",
        mode.instructions,
        profile.instructions,
      ].join("\n\n"),
      prompt,
      maxOutputTokens: 1_024,
    });
    const text = stripCodeFence(result.text);
    if (!text) return c.json({ text: "" });
    return c.json({ text });
  },
});
