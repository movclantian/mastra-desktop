/**
 * 资料库模块入口(纯导出)。实现按关注点拆分:
 * - types:共享类型与常量(依赖图最底层)
 * - db:LibSQL 客户端、建表与行映射
 * - extract:文件名规范、媒体类型推断与文本抽取(docx/xlsx/pdf)
 * - settings:设置读写 + 变更触发的全量重建索引
 * - indexing:FastEmbed/供应商嵌入、LibSQLVector 索引、MDocument 分块与索引队列
 * - assets:资产上传/列表/重命名/读取/删除 + 附件上下文
 * - folders:文件夹 CRUD
 * - upload:大文件分片上传会话
 * - search:向量 + 重排 + GraphRAG 检索
 * - tools:暴露给 Agent 的资料库工具
 */

export {
  deleteAsset,
  getAssetContext,
  getLibraryAssetId,
  listAssets,
  readAssetBytes,
  renameAsset,
  uploadAsset,
} from "./assets";
export { ensureLibrarySchema } from "./db";
export { createFolder, deleteFolder, listFolders, renameFolder } from "./folders";
export {
  queueAssetIndex,
  recoverInterruptedLibraryIndexes,
  reindexAsset,
  waitForAssetIndexing,
} from "./indexing";
export { searchLibrary } from "./search";
export { getLibrarySettings, saveLibrarySettings } from "./settings";
export {
  libraryDocumentChunkerTool,
  libraryGraphSearchTool,
  libraryVectorSearchTool,
} from "./tools";
export * from "./types";
export {
  cancelLibraryUploadSession,
  completeLibraryUploadSession,
  createLibraryUploadSession,
  getLibraryUploadSession,
  saveLibraryUploadChunk,
} from "./upload";
