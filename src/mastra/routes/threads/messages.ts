/** Desktop message presentation, using the official AI SDK converter. */
import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import type { MastraDBMessage } from "@mastra/core/agent";
import { normalizeChatHistoryMessages } from "./shared";

const LIBRARY_SEARCH_TOOL_NAMES = new Set(["library_vector_search", "library_graph_search"]);

function getLibraryToolName(part: Record<string, unknown>): string | undefined {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" ? part.toolName : undefined;
  }
  if (typeof part.type !== "string" || !part.type.startsWith("tool-")) return undefined;
  return part.type.slice("tool-".length);
}

function appendLibrarySourceParts<Message extends { id?: string; role: string; parts: unknown[] }>(
  messages: Message[],
): Message[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    if (
      message.parts.some(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "data-library-sources",
      )
    ) {
      return message;
    }

    const sources = new Map<string, Record<string, unknown>>();
    for (const rawPart of message.parts) {
      if (typeof rawPart !== "object" || rawPart === null) continue;
      const part = rawPart as Record<string, unknown>;
      const toolName = getLibraryToolName(part);
      if (!toolName || !LIBRARY_SEARCH_TOOL_NAMES.has(toolName)) continue;
      const output = part.output;
      if (typeof output !== "object" || output === null) continue;
      const results = (output as { results?: unknown }).results;
      if (!Array.isArray(results)) continue;

      for (const rawResult of results) {
        if (typeof rawResult !== "object" || rawResult === null) continue;
        const result = rawResult as Record<string, unknown>;
        const assetId = typeof result.assetId === "string" ? result.assetId : "";
        const url = typeof result.url === "string" ? result.url : "";
        if (!assetId || !url) continue;
        try {
          const parsed = new URL(url);
          if (!parsed.pathname.startsWith("/work/library/assets/")) continue;
        } catch {
          continue;
        }
        const id =
          typeof result.citationId === "string" && result.citationId
            ? result.citationId
            : `library-${assetId}`;
        sources.set(id, {
          id,
          assetId,
          filename:
            typeof result.filename === "string" && result.filename ? result.filename : "资料库文件",
          url,
          snippet: typeof result.text === "string" ? result.text.slice(0, 280) : "",
          score:
            typeof result.score === "number" && Number.isFinite(result.score) ? result.score : 0,
        });
      }
    }
    if (sources.size === 0) return message;
    return {
      ...message,
      parts: [
        ...message.parts,
        {
          type: "data-library-sources",
          id: `${message.id ?? "assistant"}:library-sources`,
          data: [...sources.values()],
        },
      ],
    };
  });
}

/**
 * toAISdkMessages(v7) 在转换 DB 的 ModelMessage file part({mimeType,data,filename})
 * 时会丢 filename —— UI part 只剩 {url,mediaType}。这里按 URL 匹配把落库的
 * filename 补回去,否则前端气泡只能显示「未命名附件」。
 */
function restoreFileFilenames(
  uiMessages: ReturnType<typeof toAISdkMessages>,
  rawMessages: Array<{ id?: string; role: string; content?: unknown }>,
): ReturnType<typeof toAISdkMessages> {
  const filenamesByMessage = rawMessages.map((raw) => {
    const map = new Map<string, string>();
    const parts =
      raw.content && typeof raw.content === "object"
        ? ((raw.content as { parts?: unknown[] }).parts ?? [])
        : [];
    for (const part of parts) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "file") {
        const { data, filename } = part as { data?: unknown; filename?: unknown };
        if (typeof data === "string" && typeof filename === "string") {
          map.set(data, filename);
        }
      }
    }
    return map;
  });

  return uiMessages.map((message, index) => {
    const map = filenamesByMessage[index];
    if (!map || map.size === 0) return message;
    let patched = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "file" || part.filename) return part;
      const filename = map.get(part.url);
      if (!filename) return part;
      patched = true;
      return { ...part, filename };
    });
    return patched ? { ...message, parts } : message;
  });
}

export function workbenchMessages(messages: MastraDBMessage[]) {
  const history = normalizeChatHistoryMessages(messages);
  return appendLibrarySourceParts(
    restoreFileFilenames(toAISdkMessages(history, { version: "v7" }), history),
  );
}
