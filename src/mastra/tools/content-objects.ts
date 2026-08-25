import {
  type ContentObjectMetadata,
  contentObjectReference,
  putContentObject,
  resourceIdFromContext,
} from "../storage";
import { WORKSPACE_RESOURCE_ID_CONTEXT_KEY, WORKSPACE_THREAD_ID_CONTEXT_KEY } from "../workspace";

export { contentObjectReference };

function requestValue(
  context: { requestContext?: { get?: (key: string) => unknown } },
  key: string,
) {
  const value = context.requestContext?.get?.(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function currentScope(context: { requestContext?: { get?: (key: string) => unknown } }) {
  const userId =
    requestValue(context, WORKSPACE_RESOURCE_ID_CONTEXT_KEY) ??
    resourceIdFromContext(context.requestContext);
  if (!userId) throw new Error("Authenticated user is required");
  const threadId = requestValue(context, WORKSPACE_THREAD_ID_CONTEXT_KEY);
  return { userId, threadId };
}

export function contentSummary(text: string, edgeCharacters = 1_200): string {
  if (text.length <= edgeCharacters * 2) return text;
  return `${text.slice(0, edgeCharacters)}\n...[摘要省略 ${text.length - edgeCharacters * 2} 字符]...\n${text.slice(-edgeCharacters)}`;
}

export function contentReferenceText(metadata: ContentObjectMetadata, label = "完整内容") {
  const reference = contentObjectReference(metadata);
  return `${label}已保存到当前用户内容对象。字符数：${metadata.characterCount ?? "未知"}，字节数：${metadata.byteSize}，SHA-256：${metadata.sha256}，内容引用：${reference.objectId}。请使用官方 mastra_workspace_read_file(path="${reference.workspacePath}", offset, limit) 按行分段读取，或使用官方 mastra_workspace_grep(pattern, path="${reference.workspacePath}") 按关键字/正则检索。`;
}

export async function archiveTextContent(
  text: string,
  context: { requestContext?: { get?: (key: string) => unknown } },
  options: { kind: "web" | "log"; source?: string; contentType?: string },
) {
  const { userId, threadId } = currentScope(context);
  return putContentObject(text, {
    userId,
    ...(options.kind === "log" && threadId ? { threadId } : {}),
    kind: options.kind,
    contentType: options.contentType ?? "text/plain; charset=utf-8",
    encoding: "utf8",
    source: options.source,
  });
}

export function archivedToolResult(
  value: unknown,
  context: { requestContext?: { get?: (key: string) => unknown } },
  options: { source?: string; contentType?: string } = {},
) {
  if (typeof value === "string") {
    return archiveTextContent(value, context, {
      kind: "web",
      source: options.source,
      contentType: options.contentType,
    }).then((metadata) => ({
      summary: contentSummary(value),
      reference: contentReferenceText(metadata),
      metadata: contentObjectReference(metadata),
    }));
  }
  return Promise.resolve(null);
}
