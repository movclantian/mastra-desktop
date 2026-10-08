import { inlineCompletionRoute, inlineEditRoute } from "../workspace/inline-edit";
/**
 * MastraWork 工作台 API 路由汇总。
 * 注意:Mastra 保留 /api 前缀给内置路由,自定义路由统一使用 /work/*。
 * apiRoutes 在 src/mastra/index.ts 注册。
 */

import {
  agentProfileCapabilitiesRoute,
  agentProfilesRoute,
  assistAgentProfileRoute,
  deleteAgentProfileRoute,
} from "./agents";
import { authLoginRoute, authLogoutRoute, authMeRoute, authRegisterRoute } from "./auth";
import { backgroundTaskRoutes } from "./background-tasks";
import { browserRoutes } from "./browser";
import { contentObjectRoute } from "./contents";
import { conversationWorkflowRoutes } from "./conversation-runs";
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
  localLibraryAssetRoute,
  promoteLibraryAssetRoute,
  referenceLibraryAssetRoute,
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
import { memoryConfigRoute, memoryProfileRoute, saveMemoryConfigRoute } from "./memory";
import { messageQueueRoutes } from "./message-queue";
import { pluginRoutes } from "./plugins";
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
import { storageInfoRoute } from "./storage";
import { threadRoutes } from "./threads/threads";
import { computerRoutes, saveToolsConfigRoute, toolsConfigRoute } from "./tools";
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
  ...pluginRoutes,
  ...conversationWorkflowRoutes,
  contentObjectRoute,
  inlineCompletionRoute,
  inlineEditRoute,
  authLoginRoute,
  authRegisterRoute,
  authLogoutRoute,
  authMeRoute,
  ...backgroundTaskRoutes,
  agentProfilesRoute,
  agentProfileCapabilitiesRoute,
  deleteAgentProfileRoute,
  assistAgentProfileRoute,
  ...browserRoutes,
  ...computerRoutes,
  ...proxyRoutes,
  ...threadRoutes,
  ...signalRoutes,
  ...sessionRoutes,
  ...messageQueueRoutes,
  ...scheduleRoutes,
  shutdownRoute,
  libraryAssetsRoute,
  localLibraryAssetRoute,
  libraryUploadSessionsRoute,
  libraryUploadSessionRoute,
  libraryUploadChunkRoute,
  completeLibraryUploadRoute,
  cancelLibraryUploadRoute,
  uploadLibraryAssetsRoute,
  libraryAssetContentRoute,
  deleteLibraryAssetRoute,
  promoteLibraryAssetRoute,
  referenceLibraryAssetRoute,
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
];
