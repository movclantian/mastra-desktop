/**
 * 资料库共享类型与常量:被库内全部模块及 chat 路由 / Agent 处理器引用,
 * 不依赖任何其他模块,是依赖图的最底层。
 */

export const LIBRARY_INDEX_NAMES = {
  small: "library_vectors_fastembed_small",
  base: "library_vectors_fastembed_base",
} as const;
export type LibraryEmbeddingModel = keyof typeof LIBRARY_INDEX_NAMES | `${string}/${string}`;

export type LibraryIndexStage = "extract" | "chunk" | "embedding" | "vector" | "persist";
export type LibraryIndexRunStatus = "running" | "succeeded" | "unsupported" | "failed";

// RequestContext 键(chat 路由写入,库内工具 / Agent 处理器读取)
export const LIBRARY_RESOURCE_CONTEXT_KEY = "libraryResourceId";
export const LIBRARY_THREAD_CONTEXT_KEY = "libraryThreadId";
export const LIBRARY_SEARCH_CONTEXT_KEY = "librarySearchContext";
export const LIBRARY_ORIGIN_CONTEXT_KEY = "libraryOrigin";
export const LIBRARY_RERANK_MODEL_CONTEXT_KEY = "libraryRerankModel";
export const LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY = "libraryAttachmentTokenBudget";
export const LIBRARY_ATTACHMENT_CAPABILITIES_CONTEXT_KEY = "libraryAttachmentCapabilities";

// 上传限制(路由层校验用)
export const MAX_LIBRARY_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_LIBRARY_FILES_PER_REQUEST = 10;
export const MAX_LIBRARY_TOTAL_BYTES_PER_REQUEST = 100 * 1024 * 1024;
export const LIBRARY_UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;

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
  embeddingModel: LibraryEmbeddingModel;
  extractTitle: boolean;
  extractSummary: boolean;
  extractQuestions: boolean;
  extractKeywords: boolean;
}

export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = {
  chunkSize: 1200,
  chunkOverlap: 160,
  chunkStrategy: "recursive",
  topK: 8,
  minScore: 0.15,
  graphRag: false,
  graphThreshold: 0.7,
  graphRandomWalkSteps: 100,
  graphRestartProb: 0.15,
  rerank: false,
  rerankScorer: "model",
  rerankSemanticWeight: 0.4,
  rerankVectorWeight: 0.4,
  rerankPositionWeight: 0.2,
  embeddingModel: "small",
  extractTitle: false,
  extractSummary: false,
  extractQuestions: false,
  extractKeywords: false,
};

export interface LibraryAsset {
  id: string;
  resourceId: string;
  folderIds: string[];
  threadIds: string[];
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
