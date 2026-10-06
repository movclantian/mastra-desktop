/**
 * RAG 知识库共享类型与常量 (docs/en/reference/rag/):
 * 被 RAG 内全部模块及 chat 路由 / Agent 处理器引用。
 */
import { z } from "zod";

/** Retrieval results keep the authenticated asset URL through tools and message history. */
export const librarySearchResultSchema = z.object({
  citationId: z.string().min(1),
  assetId: z.string().min(1),
  filename: z.string().min(1),
  url: z.url({ protocol: /^https?$/ }),
  text: z.string(),
  score: z.number(),
});

export type LibrarySearchResult = z.infer<typeof librarySearchResultSchema>;

function libraryCitationSource(result: LibrarySearchResult) {
  return {
    id: result.citationId,
    assetId: result.assetId,
    filename: result.filename,
    url: result.url,
    snippet: result.text.slice(0, 280),
    score: result.score,
  };
}

export type LibraryCitationSource = ReturnType<typeof libraryCitationSource>;

/** Shared projection for live tool output, automatic retrieval, and stored messages. */
export function libraryCitationSources(output: unknown): LibraryCitationSource[] {
  if (!output || typeof output !== "object" || !("results" in output)) return [];
  if (!Array.isArray(output.results)) return [];
  return output.results.flatMap((result) => {
    const parsed = librarySearchResultSchema.safeParse(result);
    if (!parsed.success) return [];
    const url = new URL(parsed.data.url);
    if (
      url.pathname !== `/work/library/assets/${encodeURIComponent(parsed.data.assetId)}/content` ||
      !url.searchParams.get("resourceId")
    )
      return [];
    return [libraryCitationSource(parsed.data)];
  });
}

export type LibraryIndexStage = "extract" | "chunk" | "embedding" | "vector" | "persist";
export type LibraryIndexRunStatus = "running" | "succeeded" | "unsupported" | "failed";

export const VALID_CHUNK_STRATEGIES = [
  "recursive",
  "character",
  "token",
  "markdown",
  "html",
  "json",
  "latex",
  "sentence",
  "semantic-markdown",
] as const;

export const LIBRARY_VECTOR_SEARCH_TOOL_ID = "library_vector_search";
export const LIBRARY_GRAPH_SEARCH_TOOL_ID = "library_graph_search";
export const LIBRARY_SEARCH_TOOL_NAMES = new Set([
  LIBRARY_VECTOR_SEARCH_TOOL_ID,
  LIBRARY_GRAPH_SEARCH_TOOL_ID,
]);

// RequestContext 键(chat 路由写入,库内工具 / Agent 处理器读取)
export const LIBRARY_RESOURCE_CONTEXT_KEY = "libraryResourceId";
export const LIBRARY_THREAD_CONTEXT_KEY = "libraryThreadId";
export const LIBRARY_ORIGIN_CONTEXT_KEY = "libraryOrigin";
export const LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY = "libraryAttachmentTokenBudget";
export const LIBRARY_ATTACHMENT_CAPABILITIES_CONTEXT_KEY = "libraryAttachmentCapabilities";
export const LIBRARY_ATTACHMENTS_CONTEXT_KEY = "libraryAttachments";

// 上传限制(路由层校验用)
export const MAX_LIBRARY_FILE_BYTES = 50 * 1024 * 1024;
/** Maximum media bytes allowed to become an in-memory model data URL. */
export const MAX_LIBRARY_INLINE_MEDIA_BYTES = Math.floor((5 * 1024 * 1024 - 64) / 4) * 3;
export const MAX_LIBRARY_INLINE_TOTAL_MEDIA_BYTES = 8 * 1024 * 1024;
export const MAX_LIBRARY_EXTRACT_BYTES = 8 * 1024 * 1024;
export const MAX_LIBRARY_EXTRACT_CHARACTERS = 200_000;
export const MAX_LIBRARY_FILES_PER_REQUEST = 10;
export const MAX_LIBRARY_TOTAL_BYTES_PER_REQUEST = 100 * 1024 * 1024;
// The chunk endpoint and resumable-session default must share one limit.
export const LIBRARY_UPLOAD_CHUNK_BYTES = 20 * 1024 * 1024;
export const MAX_LIBRARY_UPLOAD_CHUNK_BYTES = 20 * 1024 * 1024;
export const MIN_LIBRARY_UPLOAD_CHUNK_BYTES = 100 * 1024;

export interface LibrarySettings {
  chunkSize: number;
  chunkOverlap: number;
  chunkStrategy:
    | "recursive"
    | "character"
    | "token"
    | "markdown"
    | "html"
    | "json"
    | "latex"
    | "sentence"
    | "semantic-markdown";
  topK: number;
  minScore: number;
  graphRag: boolean;
  graphThreshold: number;
  graphRandomWalkSteps: number;
  graphRestartProb: number;
  rerank: boolean;
  rerankScorer: "model" | "mastra-agent";
  rerankSemanticWeight: number;
  rerankVectorWeight: number;
  rerankPositionWeight: number;
  extractTitle: boolean;
  extractSummary: boolean;
  extractQuestions: boolean;
  extractKeywords: boolean;
}

export type LibrarySettingsUpdate = Partial<LibrarySettings>;

export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = {
  // chunkSize/chunkOverlap/topK/minScore 为项目自定(官方 chunk.mdx 默认 maxSize=4000, overlap=50;retrieval 示例 topK=10)。
  chunkSize: 1200,
  chunkOverlap: 160,
  chunkStrategy: "recursive",
  topK: 8,
  minScore: 0.15,
  graphRag: false,
  // 以下三项为 GraphRAG 官方默认值,见 docs/en/reference/rag/graph-rag.mdx:
  //   threshold defaultValue='0.7'、randomWalkSteps defaultValue='100'、restartProb defaultValue='0.15'。
  graphThreshold: 0.7,
  graphRandomWalkSteps: 100,
  graphRestartProb: 0.15,
  rerank: false,
  rerankScorer: "model",
  // 以下三项为 rerank() 官方默认权重,见 docs/en/reference/rag/rerank.mdx:
  //   semantic default='0.4'、vector default='0.4'、position default='0.2'。
  rerankSemanticWeight: 0.4,
  rerankVectorWeight: 0.4,
  rerankPositionWeight: 0.2,
  extractTitle: false,
  extractSummary: false,
  extractQuestions: false,
  extractKeywords: false,
};

export interface LibraryAsset {
  localPath: string | null;
  id: string;
  resourceId: string;
  folderIds: string[];
  threadIds: string[];
  /** True when the asset has a global (non-thread) library reference. */
  hasLibraryReference: boolean;
  filename: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  status: "ready" | "indexing" | "unsupported" | "error";
  extractedText: string | null;
  indexAttempt: number;
  indexStage: LibraryIndexStage | null;
  indexError: string | null;
  indexStartedAt: string | null;
  indexCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryIndexRunSummary {
  assetId: string;
  attempt: number;
  status: LibraryIndexRunStatus;
  stage: LibraryIndexStage;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface LibraryFolder {
  id: string;
  resourceId: string;
  parentId: string | null;
  threadId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryUploadSession {
  id: string;
  resourceId: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  chunkSize: number;
  totalChunks: number;
  folderId?: string;
  threadId?: string;
  completedChunks: number[];
  createdAt: string;
  updatedAt: string;
}
