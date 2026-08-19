import type { InputProcessor } from "@mastra/core/processors";
import {
  getAssetContext,
  getLibraryAssetId,
  LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY,
  LIBRARY_ATTACHMENT_CAPABILITIES_CONTEXT_KEY,
  LIBRARY_RESOURCE_CONTEXT_KEY,
} from "../library";

/**
 * 资料库附件输入处理器(docs/en/docs/agents/input-processors.mdx):
 * 在请求到达模型之前,把消息里指向资料库的稳定 URL(/work/library/assets/:id/content)
 * 解析为真实内容 —— 已抽取文本按剩余 token 预算注入为文本,图片/音频在模型支持
 * 原生媒体时注入为 file 部分,其余降级为占位说明。预算与模型能力由 chat 路由
 * 写入 RequestContext,未携带 resourceId 时处理器直接放行。
 */
export const libraryAttachmentProcessor: InputProcessor = {
  id: "library-attachments",
  async processLLMRequest({ prompt, requestContext }) {
    const resourceId = requestContext?.get(LIBRARY_RESOURCE_CONTEXT_KEY) as string | undefined;
    if (!resourceId) return;
    const tokenBudget = requestContext?.get(LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY);
    const capabilities = requestContext?.get(LIBRARY_ATTACHMENT_CAPABILITIES_CONTEXT_KEY) as
      | { vision?: boolean; audio?: boolean }
      | undefined;
    let remainingTokens = typeof tokenBudget === "number" ? Math.max(0, tokenBudget) : 32_000;
    let changed = false;
    const resolvedPrompt = [...prompt];
    for (let messageIndex = prompt.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = prompt[messageIndex];
      if (message.role !== "user" && message.role !== "assistant") continue;
      const content = [];
      for (const part of message.content) {
        if (part.type !== "file") {
          content.push(part);
          continue;
        }
        const assetId = getLibraryAssetId(part.data);
        if (!assetId) {
          content.push(part);
          continue;
        }
        changed = true;
        const context = await getAssetContext(resourceId, assetId);
        if (!context) {
          content.push({
            type: "text" as const,
            text: `[附件不可用: ${part.filename ?? "未命名附件"}]`,
          });
          continue;
        }
        if (context.text) {
          const availableCharacters = Math.max(0, Math.floor(remainingTokens * 3));
          const availableText = context.text.slice(0, availableCharacters);
          remainingTokens = Math.max(0, remainingTokens - Math.ceil(availableText.length / 3));
          content.push({
            type: "text" as const,
            text: availableText
              ? `附件「${context.asset.filename}」内容:\n\n${availableText}${availableText.length < context.text.length ? "\n\n[附件内容已按剩余上下文窗口截断]" : ""}`
              : `[附件「${context.asset.filename}」未注入: 当前线程已没有可用的附件上下文预算]`,
          });
          continue;
        }
        if (context.dataUrl) {
          const supported = context.asset.mediaType.startsWith("image/")
            ? capabilities?.vision === true
            : context.asset.mediaType.startsWith("audio/") && capabilities?.audio === true;
          const estimatedTokens = context.asset.mediaType.startsWith("image/")
            ? Math.max(1_024, Math.ceil(context.asset.byteSize / 1_024))
            : Math.max(1_024, Math.ceil(context.asset.byteSize / 512));
          if (supported && estimatedTokens <= remainingTokens) {
            remainingTokens -= estimatedTokens;
            content.push({
              type: "file" as const,
              data: context.dataUrl,
              filename: context.asset.filename,
              mediaType: context.asset.mediaType,
            });
          } else {
            content.push({
              type: "text" as const,
              text: supported
                ? `[附件「${context.asset.filename}」未注入: 剩余上下文不足]`
                : `[附件「${context.asset.filename}」未注入: 当前模型不支持该原生媒体类型]`,
            });
          }
          continue;
        }
        content.push({
          type: "text" as const,
          text: `[已上传附件: ${context.asset.filename}; 当前格式不能直接发送给模型]`,
        });
      }
      // content 数组按联合推断成全部 part 类型的并集,直接赋回 LanguageModelV2Message
      // 会因角色 content 窄类型不兼容报 TS2322;各 part 均来自原消息或合法替换,断言即可。
      resolvedPrompt[messageIndex] = { ...message, content } as (typeof resolvedPrompt)[number];
    }
    return changed ? { prompt: resolvedPrompt } : undefined;
  },
};
