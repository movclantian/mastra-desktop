/**
 * 提示建议(Suggestion pattern)。
 * 官方:docs/examples/suggestion.mdx —— 建议是一句可直接发送的短提示,
 * 点击即发,省去输入。本模块负责两件事:
 * 1. 读写用户级配置(app_config key = "suggestions"):开关 + 生成用模型;
 * 2. 依据最近对话生成建议(独立小模型调用,不进入主 Agent 的会话)。
 * 生成失败不影响对话本身,前端按空列表处理。
 */

import type { GatewayLanguageModel } from "@mastra/core/llm";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import { generateText, type LanguageModel } from "ai";
import { z } from "zod";
import {
  DEFAULT_SUGGESTION_CONFIG,
  MAX_PROMPT_SUGGESTIONS,
  type SuggestionConfig,
  SuggestionConfigSchema,
} from "../../shared/agent-contract";
import { workError } from "../errors";
import { resolveConfiguredModel } from "../models/providers";
import { getAppConfig, setAppConfig } from "../storage/database";

const SUGGESTIONS_CONFIG_KEY = "suggestions";
const MAX_PROMPT_CHARS = 6_000;

export async function getSuggestionsConfig(resourceId?: string): Promise<SuggestionConfig> {
  const raw = await getAppConfig(SUGGESTIONS_CONFIG_KEY, resourceId);
  if (!raw) return DEFAULT_SUGGESTION_CONFIG;
  const parsed = SuggestionConfigSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : DEFAULT_SUGGESTION_CONFIG;
}

export async function saveSuggestionsConfig(
  config: SuggestionConfig,
  resourceId?: string,
): Promise<void> {
  await setAppConfig(SUGGESTIONS_CONFIG_KEY, JSON.stringify(config), resourceId);
}

/** 从 "providerId/modelId" 解析出可用的语言模型;失败返回 undefined。 */
async function resolveSuggestionModel(
  routerId: string,
  resourceId?: string,
): Promise<GatewayLanguageModel | undefined> {
  if (!routerId.trim()) return undefined;
  const separator = routerId.indexOf("/");
  if (separator <= 0) return undefined;
  return resolveConfiguredModel(
    routerId.slice(0, separator),
    routerId.slice(separator + 1),
    resourceId,
  );
}

/** 把最近几轮对话压成一段可读上下文,超出预算时保留最新内容。 */
function buildTranscript(messages: Array<{ role: string; text: string }>): string {
  const lines = messages
    .filter((message) => message.text.trim())
    .map((message) => `${message.role === "user" ? "用户" : "助手"}: ${message.text.trim()}`);
  const transcript = lines.join("\n\n");
  return transcript.length > MAX_PROMPT_CHARS ? transcript.slice(-MAX_PROMPT_CHARS) : transcript;
}

/** 解析模型输出:一行一条,去掉编号/引号/项目符号,截断超长项。 */
function parseSuggestions(text: string): string[] {
  return text
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^[-*\d.、)\s]+/, "")
        .replace(/^["'「『]|["'」』]$/g, "")
        .trim(),
    )
    .filter((line) => line.length > 0 && line.length <= 120)
    .slice(0, MAX_PROMPT_SUGGESTIONS);
}

const suggestRequestSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: z.string().max(24_000),
          })
          .strict(),
      )
      .max(40),
    /** 当前会话模型,配置未指定模型时作为回退 */
    fallbackModel: z.string().max(512).optional(),
  })
  .strict();

export const suggestPromptsRoute = registerApiRoute("/work/suggestions", {
  method: "POST",
  handler: async (c) => {
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string | undefined;
    const parsed = suggestRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw workError("VALIDATION_FAILED", { text: "提示建议参数无效" });
    }

    const config = await getSuggestionsConfig(resourceId);
    if (!config.enabled) return c.json({ suggestions: [] as string[] });

    const model =
      (await resolveSuggestionModel(config.model, resourceId)) ??
      (await resolveSuggestionModel(parsed.data.fallbackModel ?? "", resourceId));
    if (!model) return c.json({ suggestions: [] as string[] });

    const transcript = buildTranscript(parsed.data.messages);
    if (!transcript) return c.json({ suggestions: [] as string[] });

    const abortSignal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(20_000)]);
    try {
      const result = await generateText({
        model: model as unknown as LanguageModel,
        system: [
          "你为编程助手生成下一步提示建议。",
          `基于下面的对话,给出最多 ${MAX_PROMPT_SUGGESTIONS} 条用户接下来最可能发送的短提示。`,
          "要求:每条不超过 20 个字,可直接发送;使用对话相同的语言;",
          "不要编号、不要引号、不要解释,每行一条。",
        ].join("\n"),
        prompt: transcript,
        maxOutputTokens: 512,
        maxRetries: 0,
        abortSignal,
      });
      return c.json({ suggestions: parseSuggestions(result.text) });
    } catch {
      // 建议是锦上添花:生成失败不该让对话报错,静默返回空列表。
      return c.json({ suggestions: [] as string[] });
    }
  },
});

export const suggestionsConfigRoute = registerApiRoute("/work/suggestions/config", {
  method: "GET",
  handler: async (c) => {
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string | undefined;
    return c.json(await getSuggestionsConfig(resourceId));
  },
});

export const saveSuggestionsConfigRoute = registerApiRoute("/work/suggestions/config", {
  method: "POST",
  handler: async (c) => {
    const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string | undefined;
    const parsed = SuggestionConfigSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw workError("VALIDATION_FAILED", { text: "提示建议配置无效" });
    }
    await saveSuggestionsConfig(parsed.data, resourceId);
    return c.json({ ok: true });
  },
});
