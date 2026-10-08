/** Desktop message presentation, using the official AI SDK converter. */
import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import type { MastraDBMessage } from "@mastra/core/agent";
import { generatedMediaSchema, mediaGenerationStateSchema } from "../../../shared/agent-contract";
import {
  LIBRARY_SEARCH_TOOL_NAMES,
  type LibraryCitationSource,
  libraryCitationSources,
} from "../../rag/types";
import { normalizeChatHistoryMessages } from "./shared";

function getLibraryToolName(part: Record<string, unknown>): string | undefined {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" ? part.toolName : undefined;
  }
  if (typeof part.type !== "string" || !part.type.startsWith("tool-")) return undefined;
  return part.type.slice("tool-".length);
}

/** Direct generations and native generation tools reference the same library assets. */
export function generatedFilesInMessage(message: { parts: unknown[] }) {
  return message.parts.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const part = raw as Record<string, unknown>;
    const name = getLibraryToolName(part);
    const result =
      part.type === "data-media-generation"
        ? mediaGenerationStateSchema.safeParse(part.data).data?.result
        : (name === "generate_image" || name === "generate_video") &&
            part.state === "output-available"
          ? generatedMediaSchema.safeParse(part.output).data
          : undefined;
    return result?.files ?? [];
  });
}

function appendLibrarySourceParts<
  Message extends { id?: string; role: string; parts: unknown[]; metadata?: unknown },
>(messages: Message[]): Message[] {
  let turnSources: LibraryCitationSource[] = [];
  return messages.map((message) => {
    if (message.role === "user") {
      const metadata = message.metadata as { librarySources?: LibraryCitationSource[] } | undefined;
      turnSources = Array.isArray(metadata?.librarySources) ? metadata.librarySources : [];
    }
    if (message.role !== "assistant") return message;
    const sources = new Map(turnSources.map((source) => [source.id, source]));
    for (const rawPart of message.parts) {
      if (typeof rawPart !== "object" || rawPart === null) continue;
      const part = rawPart as Record<string, unknown>;
      const toolName = getLibraryToolName(part);
      if (!toolName || !LIBRARY_SEARCH_TOOL_NAMES.has(toolName)) continue;
      for (const source of libraryCitationSources(part.output)) {
        sources.set(source.id, source);
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
  const timestamps = new Map(history.map((message) => [message.id, message.createdAt]));
  return appendLibrarySourceParts(
    restoreFileFilenames(toAISdkMessages(history, { version: "v7" }), history),
  ).map((message) => {
    const metadata =
      message.metadata && typeof message.metadata === "object" ? message.metadata : {};
    const media = mediaGenerationStateSchema.safeParse(
      (metadata as Record<string, unknown>).mediaGeneration,
    );
    return {
      ...message,
      parts: media.success
        ? [
            ...message.parts,
            { type: "data-media-generation" as const, id: message.id, data: media.data },
          ]
        : message.parts,
      metadata: { ...metadata, createdAt: timestamps.get(message.id) },
    };
  });
}
