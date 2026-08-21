import { browserRoutes } from "./browser";
import {
  guardrailsConfigRoute,
  guardrailsStatusRoute,
  saveGuardrailsConfigRoute,
} from "./guardrails";
import {
  cancelLibraryUploadRoute,
  completeLibraryUploadRoute,
  createLibraryFolderRoute,
  deleteLibraryAssetRoute,
  deleteLibraryFolderRoute,
  libraryAssetContentRoute,
  libraryAssetsRoute,
  libraryFoldersRoute,
  librarySettingsRoute,
  libraryUploadChunkRoute,
  libraryUploadSessionRoute,
  libraryUploadSessionsRoute,
  reindexFailedLibraryAssetsRoute,
  reindexLibraryAssetRoute,
  renameLibraryAssetRoute,
  saveLibrarySettingsRoute,
  updateLibraryFolderRoute,
  uploadLibraryAssetsRoute,
} from "./library";
import {
  deleteMcpConfigRoute,
  mcpConfigRoute,
  saveMcpConfigRoute,
  testMcpConfigRoute,
} from "./mcp";
import { memoryConfigRoute, saveMemoryConfigRoute } from "./memory";
import {
  listProviderModelsRoute,
  modelsCatalogRoute,
  providerRegistryRoute,
  providersConfigRoute,
  saveProvidersConfigRoute,
} from "./providers";
import { sessionRoutes } from "./session";
import { shutdownRoute } from "./shutdown";
import { signalRoutes } from "./signals";
import {
  builtinSkillRoute,
  builtinSkillsRoute,
  deleteSkillMarketplaceRoute,
  deleteSkillRoute,
  importSkillRoute,
  installBuiltinSkillRoute,
  installMarketplaceSkillRoute,
  marketplaceSkillRoute,
  saveSkillMarketplaceRoute,
  skillMarketplacesRoute,
  skillRoute,
  skillsRoute,
  uploadSkillRoute,
} from "./skills";
import { storageInfoRoute } from "./storage";
import { threadRoutes } from "./threads";
import { saveToolsConfigRoute, toolsConfigRoute } from "./tools";
import {
  recentWorkspacesRoute,
  saveThreadFileRoute,
  saveWorkspaceConfigRoute,
  threadFileRoute,
  threadTreeRoute,
  workspaceConfigRoute,
} from "./workspace";

/**
 * MastraWork 工作台 API 路由汇总。
 * 注意:Mastra 保留 /api 前缀给内置路由,自定义路由统一使用 /work/*。
 * apiRoutes 在 src/mastra/index.ts 注册。
 */
export const workRoutes = [
  ...browserRoutes,
  ...threadRoutes,
  ...signalRoutes,
  ...sessionRoutes,
  shutdownRoute,
  libraryAssetsRoute,
  libraryUploadSessionsRoute,
  libraryUploadSessionRoute,
  libraryUploadChunkRoute,
  completeLibraryUploadRoute,
  cancelLibraryUploadRoute,
  uploadLibraryAssetsRoute,
  libraryAssetContentRoute,
  deleteLibraryAssetRoute,
  renameLibraryAssetRoute,
  reindexLibraryAssetRoute,
  reindexFailedLibraryAssetsRoute,
  libraryFoldersRoute,
  createLibraryFolderRoute,
  updateLibraryFolderRoute,
  deleteLibraryFolderRoute,
  librarySettingsRoute,
  saveLibrarySettingsRoute,
  providerRegistryRoute,
  modelsCatalogRoute,
  listProviderModelsRoute,
  providersConfigRoute,
  saveProvidersConfigRoute,
  storageInfoRoute,
  memoryConfigRoute,
  saveMemoryConfigRoute,
  mcpConfigRoute,
  saveMcpConfigRoute,
  testMcpConfigRoute,
  deleteMcpConfigRoute,
  guardrailsConfigRoute,
  saveGuardrailsConfigRoute,
  guardrailsStatusRoute,
  workspaceConfigRoute,
  saveWorkspaceConfigRoute,
  recentWorkspacesRoute,
  threadTreeRoute,
  threadFileRoute,
  saveThreadFileRoute,
  toolsConfigRoute,
  saveToolsConfigRoute,
  skillsRoute,
  builtinSkillsRoute,
  builtinSkillRoute,
  deleteSkillMarketplaceRoute,
  installBuiltinSkillRoute,
  installMarketplaceSkillRoute,
  marketplaceSkillRoute,
  saveSkillMarketplaceRoute,
  skillMarketplacesRoute,
  skillRoute,
  uploadSkillRoute,
  importSkillRoute,
  deleteSkillRoute,
];

export { workChatRoute } from "./chat";
export type { RegistryProvider } from "./providers";
export { getWorkMemory, type ThreadMetadata } from "./threads";
