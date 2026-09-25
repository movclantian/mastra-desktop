/**
 * RAG (Retrieval-Augmented Generation) 模块入口 (docs/en/reference/rag/):
 * - document: 文档抽取与分块索引 (extract, indexing)
 * - retrieval: 向量检索、重排与 GraphRAG (searchLibrary)
 * - storage: 知识库资产、目录与分片上传 (assets, folders, upload, db)
 * - tools: 知识库工具 (library_vector_search, library_graph_search, library_document_chunker)
 * - settings: 全局 RAG 检索参数
 * - types: RAG 数据结构定义
 */

export {
  type LibraryIndexSettledEvent,
  libraryIndexSignals,
  recoverInterruptedLibraryIndexes,
  reindexAsset,
} from "./document/indexing";
export { searchLibrary } from "./retrieval/search";
export { getLibrarySettings, saveLibrarySettings } from "./settings";
export {
  attachAssetReference,
  deleteAsset,
  getAssetContext,
  getLibraryAssetId,
  isThreadAssetTransferWriteLocked,
  type LibraryAttachmentContext,
  listAssets,
  readAssetBytes,
  renameAsset,
  uploadAsset,
  uploadAssetFromFile,
  withThreadAssetTransferLock,
} from "./storage/assets";
export {
  ensureLibrarySchema,
  withClient,
} from "./storage/db";
export {
  createFolder,
  deleteFolder,
  listFolders,
  renameFolder,
} from "./storage/folders";
export {
  cancelLibraryUploadSession,
  completeLibraryUploadSession,
  createLibraryUploadSession,
  getLibraryUploadSession,
  saveLibraryUploadChunk,
} from "./storage/upload";
export {
  libraryDocumentChunkerTool,
  libraryGraphSearchTool,
  libraryVectorSearchTool,
} from "./tools";
export {
  DEFAULT_LIBRARY_SETTINGS,
  LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY,
  LIBRARY_ATTACHMENT_CAPABILITIES_CONTEXT_KEY,
  LIBRARY_ATTACHMENTS_CONTEXT_KEY,
  LIBRARY_ORIGIN_CONTEXT_KEY,
  LIBRARY_RERANK_MODEL_CONTEXT_KEY,
  LIBRARY_RESOURCE_CONTEXT_KEY,
  LIBRARY_THREAD_CONTEXT_KEY,
  LIBRARY_UPLOAD_CHUNK_BYTES,
  MAX_LIBRARY_INLINE_MEDIA_BYTES,
  type LibrarySettings,
  type LibrarySettingsUpdate,
  MAX_LIBRARY_FILE_BYTES,
  MAX_LIBRARY_FILES_PER_REQUEST,
  MAX_LIBRARY_TOTAL_BYTES_PER_REQUEST,
} from "./types";
