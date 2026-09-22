import { inlineCompletionRoute, inlineEditRoute } from "../workspace/inline-edit";
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
import {
  authLoginRoute,
  authLogoutRoute,
  authMeRoute,
  authRegisterRoute,
  workUsersRoute,
} from "./auth";
import { backgroundTaskRoutes } from "./background-tasks";
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
  promoteLibraryAssetRoute,
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
  authenticateMcpConfigRoute,
  deleteMcpConfigRoute,
  getMcpServerRoute,
  mcpConfigRoute,
  saveMcpConfigRoute,
  testMcpConfigRoute,
} from "./mcp";
import {
  memoryConfigRoute,
  memoryProfileRoute,
  observationalMemoryConfigRoute,
  saveMemoryConfigRoute,
  updateObservationalMemoryConfigRoute,
} from "./memory";
import {
  listProviderModelsRoute,
  modelsCatalogRoute,
  providerRegistryRoute,
  providersConfigRoute,
  saveProvidersConfigRoute,
  testProviderModelRoute,
} from "./providers";
import { proxyRoutes } from "./proxy";
import { scheduleRoutes } from "./schedules";
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
  skillsShAuditRoute,
  skillsShCuratedRoute,
  skillsShListRoute,
  skillsShSkillRoute,
  updateSkillRoute,
  uploadSkillRoute,
} from "./skills";
import { storageInfoRoute } from "./storage";
import { threadRoutes } from "./threads";
import { saveToolsConfigRoute, toolsConfigRoute } from "./tools";
import { usageSummaryRoute } from "./usage";
import {
  createThreadTreeEntryRoute,
  recentWorkspacesRoute,
  saveThreadFileRoute,
  saveWorkspaceConfigRoute,
  threadChangeContentRoute,
  threadChangesRoute,
  threadFileRoute,
  threadRawFileRoute,
  threadTreeRoute,
  workspaceConfigRoute,
} from "./workspace";

export const workRoutes = [
  inlineCompletionRoute,
  inlineEditRoute,
  authLoginRoute,
  authRegisterRoute,
  authLogoutRoute,
  authMeRoute,
  workUsersRoute,
  ...backgroundTaskRoutes,
  agentProfilesRoute,
  saveAgentProfileRoute,
  deleteAgentProfileRoute,
  assistAgentProfileRoute,
  ...browserRoutes,
  ...proxyRoutes,
  ...threadRoutes,
  ...signalRoutes,
  ...sessionRoutes,
  ...scheduleRoutes,
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
  promoteLibraryAssetRoute,
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
  testProviderModelRoute,
  providersConfigRoute,
  saveProvidersConfigRoute,
  storageInfoRoute,
  memoryConfigRoute,
  observationalMemoryConfigRoute,
  updateObservationalMemoryConfigRoute,
  saveMemoryConfigRoute,
  memoryProfileRoute,
  mcpConfigRoute,
  getMcpServerRoute,
  saveMcpConfigRoute,
  testMcpConfigRoute,
  deleteMcpConfigRoute,
  authenticateMcpConfigRoute,
  guardrailsConfigRoute,
  saveGuardrailsConfigRoute,
  guardrailsStatusRoute,
  workspaceConfigRoute,
  saveWorkspaceConfigRoute,
  recentWorkspacesRoute,
  threadChangesRoute,
  threadChangeContentRoute,
  threadTreeRoute,
  createThreadTreeEntryRoute,
  threadFileRoute,
  threadRawFileRoute,
  saveThreadFileRoute,
  toolsConfigRoute,
  saveToolsConfigRoute,
  usageSummaryRoute,
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
  skillsShAuditRoute,
  skillsShCuratedRoute,
  skillsShListRoute,
  skillsShSkillRoute,
  uploadSkillRoute,
  importSkillRoute,
  updateSkillRoute,
  deleteSkillRoute,
];

export { workChatRoute } from "./chat";
