import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("library attachment processor keeps history lossless and expands only at provider boundary", () => {
  const processor = read("src/mastra/agents/processors.ts");
  const inputStep = processor.match(
    /async processInputStep\(\)[\s\S]*?^ {2}\},\r?\n {2}async processLLMRequest/m,
  )?.[0];
  assert.ok(inputStep, "input step must remain explicit");
  assert.match(inputStep, /return undefined/);
  assert.doesNotMatch(inputStep, /getAssetContext|附件「/);
  assert.match(processor, /getLibraryAssetId\(part\.data\)/);
  assert.match(processor, /getLibraryAssetId\(record\.url\)/);
  assert.match(processor, /getLibraryAssetId\(record\.image\)/);
  assert.match(processor, /getAssetContext\(resourceId, assetId/);
  assert.match(
    processor,
    /whose role union intentionally excludes Mastra's persisted `signal` role/,
  );
  assert.match(processor, /processLLMRequest/);
});

test("models keep protected library URLs out of Mastra's unauthenticated downloader", () => {
  const models = read("src/mastra/models/create-model.ts");
  assert.match(models, /LOCAL_LIBRARY_ASSET_URL/);
  assert.match(models, /withLocalLibraryAssetUrls/);
  assert.match(models, /supportedUrls/);
  assert.match(models, /work\\\/library\\\/assets/);
  assert.match(models, /return withLocalLibraryAssetUrls\(model\)/);
});

test("first attachment send defers route selection until persistence succeeds", () => {
  const mutation = read("src/renderer/src/entities/workbench/model/queries/threads.ts");
  const panel = read("src/renderer/src/widgets/chat-panel/ui/chat-panel.tsx");
  assert.match(mutation, /deferSelection\?: boolean/);
  assert.match(mutation, /input\?\.deferSelection !== true/);
  assert.match(panel, /deferThreadSelection = files\.length > 0/);
  assert.match(panel, /deferSelection: true/);
  assert.match(panel, /selectThread\(targetThreadId\)/);
  assert.match(panel, /transient history\/API failure must not erase/);
  assert.doesNotMatch(
    panel,
    /catch\(\(\) => \{[\s\S]{0,220}activeThreadIdRef\.current === threadId[\s\S]{0,120}setMessages\(\[\]\)/,
  );
});

test("protected library content remains a renderer-only URL contract", () => {
  const api = read("src/renderer/src/widgets/chat-panel/api/chat-api.ts");
  const route = read("src/mastra/routes/library.ts");
  assert.match(api, /\/work\/library\/assets\//);
  assert.match(route, /libraryAssetContentRoute/);
  assert.match(route, /authenticatedResourceId\(c\)/);
  assert.doesNotMatch(route, /requireResourceId\(c\.req\.query\("resourceId"\)\)/);
});

test("library routes never trust client resourceId as the tenant boundary", () => {
  const route = read("src/mastra/routes/library.ts");
  assert.match(route, /Never trust resourceId from query\/form\/json/);
  assert.match(route, /c\.get\("requestContext"\)\.get\(MASTRA_RESOURCE_ID_KEY\)/);
  assert.doesNotMatch(route, /const resourceId = requireResourceId\(body\.resourceId\)/);
  assert.doesNotMatch(
    route,
    /const resourceId = requireResourceId\(c\.req\.query\("resourceId"\)\)/,
  );
});

test("thread transfer has a durable intent and startup reconciliation path", () => {
  const db = read("src/mastra/rag/storage/db.ts");
  const assets = read("src/mastra/rag/storage/assets.ts");
  const threads = read("src/mastra/routes/threads/threads.ts");
  const transferRecovery = read("src/mastra/routes/threads/transfer-recovery.ts");
  const mastraIndex = read("src/mastra/index.ts");
  const routeIndex = read("src/mastra/routes/index.ts");
  const auth = read("src/mastra/routes/auth.ts");
  assert.match(db, /CREATE TABLE IF NOT EXISTS library_thread_transfers/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS library_thread_transfer_events/);
  assert.match(assets, /beginThreadAssetTransfer/);
  assert.match(assets, /requestThreadAssetTransfer/);
  assert.match(assets, /status: "awaiting_confirmation"/);
  assert.match(assets, /status IN \(\$\{placeholders\}\)/);
  assert.match(assets, /target_resource_id = \? AND status = 'awaiting_confirmation'/);
  assert.match(assets, /listThreadAssetTransfersForResource/);
  assert.match(assets, /markThreadAssetTransferAssetsMoved/);
  assert.match(assets, /markThreadAssetTransferAssetsPreparing/);
  assert.match(assets, /cleanupUnregisteredThreadAssetTransferCopies/);
  assert.match(assets, /asset_mappings/);
  assert.match(assets, /mode: "cloned"/);
  assert.match(assets, /storagePath: item\.storagePath/);
  assert.match(assets, /copyFile\(sourcePath, targetPath\)/);
  assert.match(assets, /ThreadAssetTransferCleanupPending/);
  assert.match(assets, /listPendingThreadAssetTransfers/);
  assert.match(threads, /recoverPendingThreadTransfers/);
  assert.match(mastraIndex, /await recoverPendingThreadTransfers\(\{\s+getMemory:/);
  assert.match(
    threads,
    /await recoverPendingThreadTransfers\(\{\s+transferId: transfer\.id,\s+getMemory: getWorkMemory/,
  );
  assert.match(threads, /decideThreadTransferRoute/);
  assert.match(threads, /threadTransferHistoryRoute/);
  assert.match(threads, /transfer\.targetResourceId !== currentUser\.id/);
  assert.match(transferRecovery, /owner === transfer\.targetResourceId/);
  assert.match(threads, /rewriteTransferredThreadMessages/);
  assert.match(threads, /markThreadAssetTransferMessagesRewritten/);
  assert.match(threads, /rollbackThreadAssetReferences/);
  assert.match(threads, /ensureThreadAssetReferences/);
  assert.match(threads, /getLibraryAssetId/);
  assert.match(threads, /clearTransferredWorkspaceBinding/);
  assert.match(routeIndex, /referenceLibraryAssetRoute/);
  assert.match(threads, /transferStatus = "reconciliation_pending"/);
  assert.match(threads, /const status = await executeThreadAssetTransfer/);
  assert.match(auth, /currentUser\.role !== "admin"/);
  assert.match(threads, /currentUser\.role !== "admin"/);
  const requestRoute = threads.match(
    /export const transferThreadRoute = registerApiRoute\([\s\S]*?^\}\);/m,
  )?.[0];
  assert.ok(requestRoute, "request endpoint must be independently auditable");
  assert.match(requestRoute, /requestThreadAssetTransfer/);
  assert.doesNotMatch(requestRoute, /transferThreadAssetReferences|updateThreadResourceId/);

  const rollbackBlock = threads.match(
    /if \(actualThread\?\.resourceId === targetResourceId\) \{[\s\S]*?\n {4}\}/,
  )?.[0];
  assert.ok(rollbackBlock, "an ambiguous Memory result must be reconciled before rollback");
  assert.match(rollbackBlock, /recoverPendingThreadTransfers/);
  assert.doesNotMatch(rollbackBlock, /rollbackThreadAssetReferences/);
  const sourceRecoveryBlock = transferRecovery.match(
    /if \(owner === transfer\.sourceResourceId \|\| !owner\) \{([\s\S]*?)\n\s+continue;/,
  )?.[0];
  assert.ok(sourceRecoveryBlock, "source-owned recovery branch must be explicit");
  assert.ok(
    sourceRecoveryBlock.indexOf("rewriteTransferredThreadMessages") <
      sourceRecoveryBlock.indexOf("rollbackThreadAssetReferences"),
    "message URLs must be restored before target assets are removed",
  );
  assert.match(
    transferRecovery,
    /if \(items\.length > 0\)[\s\S]*?rewriteTransferredThreadMessages\([\s\S]*?cleanupUnregisteredThreadAssetTransferCopies\(transfer\)/,
    "source-owned recovery must restore history and retry cleanup regardless of the pending phase",
  );
  assert.match(transferRecovery, /missingMappings\.every\(\(\[, mapping\]\) => mapping\.mode === "cloned"\)/);
  assert.match(transferRecovery, /enqueueTransferredAssetIndexing/);
  assert.match(transferRecovery, /items\.map\(\(item\) => \[item\.sourceAssetId, item\.targetAssetId\]\)/);
});

test("model library search is bound to the active thread and never accepts a thread override", () => {
  const tools = read("src/mastra/rag/tools.ts");
  const search = read("src/mastra/rag/retrieval/search.ts");
  const routes = read("src/mastra/routes/library.ts");
  const assets = read("src/mastra/rag/storage/assets.ts");
  const upload = read("src/mastra/rag/storage/upload.ts");
  assert.match(tools, /LIBRARY_THREAD_CONTEXT_KEY/);
  assert.match(tools, /execute: async \(\{ query \}, context\)/);
  assert.match(tools, /typeof threadIdValue === "string"/);
  assert.doesNotMatch(tools, /threadId: z\.string\(\)\.optional\(\)/);
  assert.match(search, /r\.thread_id = '' OR r\.thread_id = \?/);
  assert.match(search, /args: \[resourceId, threadId \?\? ""\]/);
  assert.doesNotMatch(search, /\? IS NULL OR r\.thread_id/);
  assert.match(routes, /if \(folderId && threadId\)/);
  assert.match(assets, /assertAssetReferenceScope\(input\.folderId, input\.threadId\)/);
  assert.match(assets, /assertAssetReferenceScope\(folderId, threadId\)/);
  assert.match(upload, /if \(input\.folderId && input\.threadId\)/);
});

test("library assets referenced in a new chat are registered on the thread", () => {
  const libraryApi = read("src/renderer/src/entities/library/api/library-api.ts");
  const libraryPage = read("src/renderer/src/pages/library/ui/knowledge-library-page.tsx");
  const routes = read("src/mastra/routes/library.ts");
  const routeIndex = read("src/mastra/routes/index.ts");
  assert.match(libraryApi, /referenceLibraryAssetInThread/);
  assert.match(libraryPage, /await referenceLibraryAssetInThread\(asset\.id, user\.id, thread\.id\)/);
  assert.match(routes, /export const referenceLibraryAssetRoute/);
  assert.match(routeIndex, /referenceLibraryAssetRoute,/);
});

test("Plan draft writer rejects a symlink target, including dangling links", () => {
  const writer = read("src/mastra/tools/plan-draft.ts");
  assert.match(writer, /import \{ lstat, mkdir, open, realpath, rename, unlink \}/);
  assert.match(writer, /const targetEntry = await lstat\(target\)/);
  assert.match(writer, /targetEntry\?\.isSymbolicLink\(\)/);
  assert.match(writer, /计划文件不能是符号链接/);
  assert.match(writer, /await temporaryFile\.sync\(\)/);
  assert.match(writer, /await rename\(temporaryTarget, target\)/);
  assert.doesNotMatch(writer, /writeFile\(target,/);
});

test("Plan permission set does not treat notification dismissal as read-only", () => {
  const permissions = read("src/mastra/agents/permissions.ts");
  assert.match(permissions, /notification_inbox: "edit"/);
  assert.match(permissions, /"notification-inbox": "edit"/);
  assert.doesNotMatch(permissions, /notification_inbox: "read"/);
  assert.doesNotMatch(permissions, /"notification-inbox": "read"/);
});

test("Electron build uses app-level locked dependencies for the Mastra bundle", () => {
  const packageJson = JSON.parse(read("package.json"));
  const builder = read("electron-builder.yml");
  const buildMastra = read("scripts/build-mastra.mjs");
  assert.match(packageJson.scripts.build, /node scripts\/build-mastra\.mjs/);
  assert.match(buildMastra, /MASTRA_BUILD_SKIP_INSTALL: "1"/);
  assert.match(builder, /!\.mastra\/output\/node_modules\/\*\*/);
  assert.match(builder, /production dependencies/);
});

test("recipient transfer inbox exposes decisions and audit history", () => {
  const api = read("src/renderer/src/entities/workbench/api/workbench-api.ts");
  const inbox = read("src/renderer/src/widgets/app-sidebar/ui/thread-transfer-inbox.tsx");
  const sidebar = read("src/renderer/src/widgets/app-sidebar/ui/app-sidebar.tsx");
  assert.match(api, /fetchThreadTransferHistory/);
  assert.match(api, /decideThreadTransferRequest/);
  assert.match(inbox, /transfer\.targetResourceId === userId/);
  assert.match(inbox, /decisionMutation\.mutateAsync/);
  assert.match(inbox, /transfer\.events\.map/);
  assert.match(sidebar, /ThreadTransferInboxDialog/);
});

test("browser routes use the authenticated resource, not the query string", () => {
  const browser = read("src/mastra/routes/browser.ts");
  assert.match(browser, /c\.get\("requestContext"\)\.get\(MASTRA_RESOURCE_ID_KEY\)/);
  assert.doesNotMatch(browser, /const resourceId = c\.req\.query\("resourceId"\)/);
});

test("browser stop events distinguish normal shutdown from an abnormal stream end", () => {
  const session = read("src/renderer/src/widgets/workspace-drawer/model/use-browser-session.ts");
  assert.match(session, /eventName === "stop"/);
  assert.match(session, /reason === "closed"/);
  assert.match(session, /reason === "stopped"/);
  assert.match(session, /setFrameState\("error"\)/);
  assert.match(session, /void refreshState\(\)/);
});

test("workspace folder context-menu labels always have a Menu.Group context", () => {
  const threadList = read("src/renderer/src/widgets/app-sidebar/ui/thread-list.tsx");
  const menu = threadList.match(
    /<ContextMenuContent className="w-44">[\s\S]*?<\/ContextMenuContent>/,
  )?.[0];
  assert.ok(menu, "folder context menu must remain present");
  assert.match(menu, /<ContextMenuGroup>[\s\S]*?<ContextMenuLabel[\s\S]*?<\/ContextMenuGroup>/);
});

test("renderer CSP allows protected Mastra asset images", () => {
  const main = read("src/main/index.ts");
  assert.match(main, /const MASTRA_SERVER_URL = "http:\/\/localhost:4111"/);
  assert.match(main, /img-src[^\n]*\$\{MASTRA_SERVER_URL\}/);
  assert.match(main, /connect-src 'self' blob:/);
  assert.match(main, /media-src 'self' data: blob:/);
  assert.match(main, /worker-src 'self' blob:/);
});

test("mixed chat attachments report rejected filenames instead of silently dropping them", () => {
  const promptInput = read("src/renderer/src/shared/ui/ai-elements/prompt-input.tsx");
  const chatPrompt = read("src/renderer/src/widgets/chat-panel/ui/prompt-input.tsx");
  assert.match(promptInput, /const rejected = incoming\.filter\(\(f\) => !matchesAccept\(f\)\)/);
  assert.match(promptInput, /unsupportedFileTypes"\)\}: \$\{rejected/);
  assert.match(promptInput, /rejected[\s\S]{0,180}file\.name[\s\S]{0,80}join\(", "\)/);
  assert.match(chatPrompt, /const acceptedFileTypes = \[/);
  assert.doesNotMatch(chatPrompt, /acceptedFileTypes[\s\S]{0,600}\.zip/);
});

test("attachment extraction boundary is explicit for unsupported binary formats", () => {
  const extract = read("src/mastra/rag/document/extract.ts");
  const processor = read("src/mastra/agents/processors.ts");
  assert.match(extract, /return \["\.docx", "\.xlsx", "\.xls", "\.csv", "\.pdf"\]/);
  assert.match(extract, /"\.zip": "application\/zip"/);
  assert.match(processor, /当前格式不能直接发送给模型/);
  assert.match(processor, /startsWith\("image\/"\)/);
  assert.match(processor, /startsWith\("audio\/"\)/);
});

test("provider boundary does not forward unknown file media types", () => {
  const processor = read("src/mastra/agents/processors.ts");
  assert.match(processor, /UNKNOWN_ATTACHMENT_MEDIA_TYPE/);
  assert.match(processor, /hasUnknownAttachmentMediaType\(part\.mediaType\)/);
  assert.match(processor, /无法识别文件类型，请重新上传或选择支持的格式/);
});

test("unknown media helpers classify blank and octet-stream parts", () => {
  const processor = read("src/mastra/agents/processors.ts");
  const helperSource = processor.match(
    /function hasUnknownAttachmentMediaType\([\s\S]*?^}\r?\n\r?\nfunction unsupportedAttachmentText[\s\S]*?^}/m,
  )?.[0];
  assert.ok(helperSource, "attachment boundary helpers must remain pure and discoverable");
  const helpers = vm.runInNewContext(
    `${stripTypeScriptTypes(helperSource)}; ({ hasUnknownAttachmentMediaType, unsupportedAttachmentText })`,
    { UNKNOWN_ATTACHMENT_MEDIA_TYPE: "application/octet-stream" },
  );
  assert.equal(helpers.hasUnknownAttachmentMediaType("application/octet-stream"), true);
  assert.equal(helpers.hasUnknownAttachmentMediaType(""), true);
  assert.equal(helpers.hasUnknownAttachmentMediaType(undefined), true);
  assert.equal(helpers.hasUnknownAttachmentMediaType("image/png"), false);
  assert.match(helpers.unsupportedAttachmentText("archive.bin"), /archive\.bin/);
});

test("assistant trace coalesces replayed tool snapshots by toolCallId", () => {
  const types = read("src/renderer/src/widgets/chat-panel/model/types.ts");
  assert.match(types, /export function normalizeTraceParts\(parts: TracePart\[\]\)/);
  assert.match(types, /toolPositions\.get\(toolCallId\)/);
  assert.match(types, /toolCallId\.trim\(\)\.length > 0/);
  assert.match(types, /parts: normalizeTraceParts\(traceParts\)/);
});

test("assistant trace keeps tool parts with missing ids separate", () => {
  const types = read("src/renderer/src/widgets/chat-panel/model/types.ts");
  const declaration = types.match(/export function normalizeTraceParts\([\s\S]*?^}\r?$/m)?.[0];
  assert.ok(declaration, "trace normalizer must remain a standalone pure function");
  const normalizeTraceParts = vm.runInNewContext(
    `${stripTypeScriptTypes(declaration).replace("export function", "function")}; normalizeTraceParts`,
    {
      isToolUIPart: (part) => typeof part?.type === "string" && part.type.startsWith("tool-"),
    },
  );
  const result = normalizeTraceParts([
    { type: "tool-read", toolCallId: "call-1", state: "input-available" },
    { type: "tool-read", toolCallId: "call-1", state: "output-available" },
    { type: "tool-read", toolCallId: "", state: "input-available" },
    { type: "tool-read", toolCallId: "", state: "output-available" },
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[0].state, "output-available");
  assert.equal(result[1].toolCallId, "");
  assert.equal(result[2].toolCallId, "");
});

test("prompt width measurement does not mutate ResizeObserver targets", () => {
  const promptInput = read("src/renderer/src/widgets/chat-panel/ui/prompt-input.tsx");
  assert.match(promptInput, /cloneNode\(true\)/);
  assert.match(promptInput, /window\.requestAnimationFrame/);
  assert.match(promptInput, /const observer = new ResizeObserver\(scheduleMeasure\)/);
  assert.doesNotMatch(promptInput, /element\.style\.minWidth = "max-content"/);
});

test("attachment capability matrix keeps upload, extraction and model injection boundaries explicit", () => {
  const chatPrompt = read("src/renderer/src/widgets/chat-panel/ui/prompt-input.tsx");
  const extract = read("src/mastra/rag/document/extract.ts");
  const processor = read("src/mastra/agents/processors.ts");

  for (const extension of [".txt", ".md", ".json", ".csv", ".pdf", ".docx", ".xlsx", ".xls"]) {
    assert.match(chatPrompt, new RegExp(`"${extension}"`));
  }
  for (const extension of [".txt", ".md", ".json", ".csv", ".pdf", ".docx", ".xlsx", ".xls"]) {
    assert.match(extract, new RegExp(`\\${extension}`));
  }

  // ZIP/PPT/PPTX are deliberately not silently advertised as chat inputs:
  // library storage may retain them, but no extractor or native model path exists.
  for (const extension of [".zip", ".ppt", ".pptx"]) {
    assert.doesNotMatch(chatPrompt, new RegExp(`\\${extension}`));
  }
  assert.match(extract, /application\/zip/);
  assert.doesNotMatch(extract, /extractText[\s\S]{0,1200}pptx/);
  assert.doesNotMatch(processor, /startsWith\("video\/"\)/);
});

test("attachment actions preserve native semantics when rendered as links", () => {
  const attachment = read("src/renderer/src/shared/ui/attachment.tsx");
  assert.match(attachment, /nativeButton=\{props\.render \? false : props\.nativeButton\}/);
});

test("library upload menu explains storage, indexing, and model boundaries", () => {
  const page = read("src/renderer/src/pages/library/ui/knowledge-library-page.tsx");
  const zh = read("src/renderer/src/shared/i18n/locales/zh.ts");
  const en = read("src/renderer/src/shared/i18n/locales/en.ts");
  assert.match(page, /DropdownMenuLabel[\s\S]{0,220}library:uploadCapabilities/);
  assert.match(
    page,
    /<DropdownMenuGroup>\s*<DropdownMenuLabel[\s\S]{0,220}library:uploadCapabilities/,
  );
  assert.match(zh, /statusNotIndexed: "已保存，未建立文本索引"/);
  assert.match(en, /statusNotIndexed: "Saved, not text-indexed"/);
});

test("library preview stays lazy without a duplicate static barrel export", () => {
  const barrel = read("src/renderer/src/features/library-upload/index.ts");
  const page = read("src/renderer/src/pages/library/ui/knowledge-library-page.tsx");
  assert.doesNotMatch(barrel, /file-preview/);
  assert.match(
    page,
    /React\.lazy\(\(\) => import\("@\/features\/library-upload\/file-preview"\)\)/,
  );
});

test("chat document uploads retain only the thread ref by default", () => {
  const api = read("src/renderer/src/widgets/chat-panel/api/chat-api.ts");
  const route = read("src/mastra/routes/library.ts");
  const assets = read("src/mastra/rag/storage/assets.ts");
  assert.doesNotMatch(api, /promoteToLibrary/);
  assert.doesNotMatch(route, /parsed\.fields\.promoteToLibrary/);
  assert.doesNotMatch(assets, /promoteToLibrary/);
  assert.match(route, /promoteLibraryAssetRoute/);
  assert.match(route, /attachAssetReference/);
  assert.match(route, /asset\.status === "unsupported"/);
  assert.match(assets, /asset\.hasLibraryReference = libraryAssetIds\.has\(asset\.id\)/);
});

test("promotion is an explicit library action and status is scoped to documents", () => {
  const page = read("src/renderer/src/pages/library/ui/knowledge-library-page.tsx");
  const api = read("src/renderer/src/entities/library/api/library-api.ts");
  const types = read("src/renderer/src/entities/library/model/types.ts");
  assert.match(api, /\/promote/);
  assert.match(page, /saveLibraryAssetToDocuments/);
  assert.match(page, /!isDocumentAsset/);
  assert.match(page, /asset\.status !== "unsupported"/);
  assert.match(page, /view === "documents"/);
  assert.match(types, /hasLibraryReference: boolean/);
});

test("chat upload invalidates the shared library query", () => {
  const panel = read("src/renderer/src/widgets/chat-panel/ui/chat-panel.tsx");
  assert.match(panel, /useQueryClient/);
  assert.match(
    panel,
    /queryClient\.invalidateQueries\(\{ queryKey: qk\.libraryContents\(user\.id\) \}\)/,
  );
});
