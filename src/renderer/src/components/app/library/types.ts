/** 资料库前端共享类型与工具(与后端 src/mastra/library 的 API 载荷一一对应) */

export interface LibraryAsset {
  id: string;
  resourceId: string;
  folderIds: string[];
  threadIds: string[];
  filename: string;
  mediaType: string;
  byteSize: number;
  status: "ready" | "indexing" | "unsupported" | "error";
  createdAt: string;
  updatedAt: string;
  indexAttempt: number;
  indexStage: "extract" | "chunk" | "embedding" | "vector" | "persist" | null;
  indexError: string | null;
  indexStartedAt: string | null;
  indexCompletedAt: string | null;
}

export interface LibraryFolder {
  id: string;
  parentId: string | null;
  threadId: string | null;
  name: string;
}

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
  embeddingModel: "small" | "base" | `${string}/${string}`;
  extractTitle: boolean;
  extractSummary: boolean;
  extractQuestions: boolean;
  extractKeywords: boolean;
}

export interface RenameTarget {
  kind: "asset" | "folder";
  id: string;
  name: string;
}

export interface LibraryUploadSession {
  id: string;
  chunkSize: number;
  totalChunks: number;
  completedChunks: number[];
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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function statusLabel(status: LibraryAsset["status"]): string {
  if (status === "ready") return "已索引";
  if (status === "indexing") return "索引中";
  if (status === "unsupported") return "未建立文本索引";
  return "索引失败";
}

export function indexStageLabel(stage: LibraryAsset["indexStage"]): string {
  if (stage === "extract") return "文本抽取";
  if (stage === "chunk") return "文档分块";
  if (stage === "embedding") return "生成嵌入";
  if (stage === "vector") return "写入向量库";
  if (stage === "persist") return "保存索引状态";
  return "未开始";
}
