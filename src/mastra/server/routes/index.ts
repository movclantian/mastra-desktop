/**
 * MastraWork 工作台 API 路由汇总。
 * 注意:Mastra 保留 /api 前缀给内置路由,自定义路由统一使用 /work/*。
 * apiRoutes 在 src/mastra/index.ts 注册。
 */

import {
  agentProfilesRoute,
  assistAgentProfileRoute,
  deleteAgentProfileRoute,
  saveAgentProfileRoute,
} from "./agents";
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
  installSkillsShSkillRoute,
  marketplaceSkillRoute,
  saveSkillMarketplaceRoute,
  skillMarketplacesRoute,
  skillRoute,
  skillsRoute,
  skillsShSkillRoute,
  uploadSkillRoute,
} from "./skills";
import { storageInfoRoute } from "./storage";
import { threadRoutes } from "./threads";
import { saveToolsConfigRoute, toolsConfigRoute } from "./tools";
import {
  createThreadTreeEntryRoute,
  detectedIdesRoute,
  openInAppRoute,
  recentWorkspacesRoute,
  saveThreadFileRoute,
  saveWorkspaceConfigRoute,
  threadChangesRoute,
  threadFileRoute,
  threadTreeRoute,
  workspaceConfigRoute,
} from "./workspace";

export const workRoutes = [
  detectedIdesRoute,
  openInAppRoute,
  agentProfilesRoute,
  saveAgentProfileRoute,
  deleteAgentProfileRoute,
  assistAgentProfileRoute,
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
  threadChangesRoute,
  threadTreeRoute,
  createThreadTreeEntryRoute,
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
  installSkillsShSkillRoute,
  marketplaceSkillRoute,
  saveSkillMarketplaceRoute,
  skillMarketplacesRoute,
  skillRoute,
  skillsShSkillRoute,
  uploadSkillRoute,
  importSkillRoute,
  deleteSkillRoute,
];

export { workChatRoute } from "./chat";
