/** Durable reconciliation between Mastra Memory and the library transfer journal. */
import { MASTRA_RESOURCE_ID_KEY, RequestContext } from "@mastra/core/request-context";
import type { Memory } from "@mastra/memory";
import {
  commitThreadAssetTransfer,
  cleanupUnregisteredThreadAssetTransferCopies,
  failThreadAssetTransfer,
  getLibraryAssetTransferDetails,
  listPendingThreadAssetTransfers,
  markThreadAssetTransferMessagesRewritten,
  rollbackThreadAssetReferences,
  type ThreadAssetTransferItem,
} from "../../rag/storage/assets";
import { queueAssetIndex } from "../../rag/document/indexing";
import { getLibrarySettings } from "../../rag/settings";
import { appStorage } from "../../storage";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function rewriteTransferredAssetUrl(
  value: string,
  mappings: Map<string, string>,
  targetResourceId: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value, "http://thread-transfer.invalid");
  } catch {
    return value;
  }
  const match = parsed.pathname.match(/^\/work\/library\/assets\/([^/]+)\/content$/);
  if (!match) return value;
  const targetAssetId = mappings.get(decodeURIComponent(match[1]));
  if (!targetAssetId) return value;
  parsed.pathname = `/work/library/assets/${encodeURIComponent(targetAssetId)}/content`;
  parsed.searchParams.set("resourceId", targetResourceId);
  if (/^https?:\/\//i.test(value)) return parsed.toString();
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function rewriteTransferredAssetValue(
  value: unknown,
  mappings: Map<string, string>,
  targetResourceId: string,
): unknown {
  if (typeof value === "string") {
    return rewriteTransferredAssetUrl(value, mappings, targetResourceId);
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteTransferredAssetValue(item, mappings, targetResourceId));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      rewriteTransferredAssetValue(item, mappings, targetResourceId),
    ]),
  );
}

/** Rewrite persisted file/citation URLs after a shared asset was copied. */
export async function rewriteTransferredThreadMessages(
  threadId: string,
  targetResourceId: string,
  items: ThreadAssetTransferItem[],
): Promise<void> {
  const mappings = new Map(
    items.map((item) => [item.sourceAssetId, item.targetAssetId]),
  );
  if (mappings.size === 0) return;
  const store = await appStorage.getStore("memory");
  if (!store) throw new Error("Memory storage is not configured");
  const result = await store.listMessages({
    threadId,
    resourceId: targetResourceId,
    perPage: false,
    orderBy: { field: "createdAt", direction: "ASC" },
  });
  const updates = result.messages.flatMap((message) => {
    const content = rewriteTransferredAssetValue(message.content, mappings, targetResourceId);
    if (JSON.stringify(content) === JSON.stringify(message.content)) return [];
    return [{ id: message.id, content }];
  });
  if (updates.length > 0) {
    await store.updateMessages({ messages: updates as never });
  }
}

function metadataWithoutWorkspace(metadata: unknown): Record<string, unknown> {
  const record =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const copy = { ...record };
  delete copy.workspacePath;
  delete copy.workspaceExplicit;
  return copy;
}

export async function clearTransferredWorkspaceBinding(
  memory: Memory,
  thread: { id?: string; title?: string | null; metadata?: unknown },
  threadId: string,
): Promise<void> {
  const metadata = thread.metadata;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("workspacePath" in metadata || "workspaceExplicit" in metadata)
  ) {
    return;
  }
  await memory.updateThread({
    id: thread.id ?? threadId,
    title: thread.title?.trim() || "New Chat",
    metadata: metadataWithoutWorkspace(metadata),
  });
  await memory.settled();
}

async function enqueueTransferredAssetIndexing(
  resourceId: string,
  items: ThreadAssetTransferItem[],
): Promise<void> {
  const settings = await getLibrarySettings(resourceId);
  for (const item of items) {
    if (item.mode === "linked" || item.asset.status === "unsupported") continue;
    void queueAssetIndex(item.asset, item.asset.extractedText ?? "", settings).catch(() => undefined);
  }
}

export async function recoverPendingThreadTransfers(options: {
  transferId?: string;
  getMemory: (context: RequestContext) => Promise<Memory>;
  enqueueAssetIndex?: (resourceId: string, items: ThreadAssetTransferItem[]) => Promise<void>;
}): Promise<void> {
  const pending = await listPendingThreadAssetTransfers(options.transferId);
  for (const transfer of pending) {
    try {
      const requestContext = new RequestContext();
      requestContext.setRaw(MASTRA_RESOURCE_ID_KEY, transfer.sourceResourceId);
      const memory = await options.getMemory(requestContext);
      await memory.settled();
      const thread = await memory.getThreadById({ threadId: transfer.threadId });
      const owner = thread?.resourceId;
      const mappings = Object.entries(transfer.assetMappings);
      const items: ThreadAssetTransferItem[] = [];
      for (const [sourceAssetId, mapping] of mappings) {
        const details = await getLibraryAssetTransferDetails(
          transfer.targetResourceId,
          mapping.targetAssetId,
        );
        if (!details) continue;
        items.push({
          sourceAssetId,
          targetAssetId: mapping.targetAssetId,
          mode: mapping.mode,
          storagePath: details.storagePath,
          asset: {
            ...details.asset,
            threadIds: [transfer.threadId],
            folderIds: [],
            hasLibraryReference: false,
          },
        });
      }
      // Older transfers only moved thread-exclusive assets and predate mappings.
      if (items.length === 0 && transfer.assetIds.length > 0) {
        for (const assetId of transfer.assetIds) {
          const details = await getLibraryAssetTransferDetails(transfer.targetResourceId, assetId);
          if (!details) continue;
          items.push({
            sourceAssetId: assetId,
            targetAssetId: assetId,
            mode: "moved",
            storagePath: details.storagePath,
            asset: { ...details.asset, threadIds: [transfer.threadId], folderIds: [] },
          });
        }
      }
      const recoveredSources = new Set(items.map((item) => item.sourceAssetId));
      const missingMappings = mappings.filter(([sourceAssetId]) => !recoveredSources.has(sourceAssetId));
      const safeCloneRemainder =
        (owner === transfer.sourceResourceId || !owner) &&
        missingMappings.length > 0 &&
        missingMappings.every(([, mapping]) => mapping.mode === "cloned");
      const expectedAssetCount = Math.max(
        Object.keys(transfer.assetMappings).length,
        transfer.assetIds.length,
      );
      if (owner === transfer.targetResourceId) {
        if (expectedAssetCount !== items.length) {
          throw new Error(
            `线程迁移资产记录不完整: expected=${expectedAssetCount}, recovered=${items.length}`,
          );
        }
      } else if (
        expectedAssetCount !== items.length &&
        !safeCloneRemainder &&
        !(transfer.status === "assets_preparing" && missingMappings.length === expectedAssetCount - items.length)
      ) {
        throw new Error(
          `线程迁移资产记录不完整: expected=${expectedAssetCount}, recovered=${items.length}`,
        );
      }
      if (owner === transfer.targetResourceId) {
        if (thread) await clearTransferredWorkspaceBinding(memory, thread, transfer.threadId);
        if (items.length > 0) {
          await rewriteTransferredThreadMessages(transfer.threadId, transfer.targetResourceId, items);
          await markThreadAssetTransferMessagesRewritten(transfer.id, transfer.targetResourceId);
        }
        await commitThreadAssetTransfer(transfer.id, transfer.targetResourceId);
        const indexableItems = items.filter(
          (item) => item.mode !== "linked" && item.asset.status !== "unsupported",
        );
        if (indexableItems.length === 0) continue;
        await (options.enqueueAssetIndex ?? enqueueTransferredAssetIndexing)(
          transfer.targetResourceId,
          indexableItems,
        );
        continue;
      }
      if (owner === transfer.sourceResourceId || !owner) {
        if (items.length > 0) {
          await rewriteTransferredThreadMessages(
            transfer.threadId,
            transfer.sourceResourceId,
            items.map((item) => ({
              ...item,
              sourceAssetId: item.targetAssetId,
              targetAssetId: item.sourceAssetId,
            })),
          );
        }
        if (items.length > 0) {
          await rollbackThreadAssetReferences(
            transfer.sourceResourceId,
            transfer.targetResourceId,
            transfer.threadId,
            items,
          );
        }
        await cleanupUnregisteredThreadAssetTransferCopies(transfer);
        await failThreadAssetTransfer(
          transfer.id,
          transfer.sourceResourceId,
          "Memory ownership did not move; library side rolled back after restart",
        );
        continue;
      }
      await failThreadAssetTransfer(
        transfer.id,
        transfer.sourceResourceId,
        `Thread owner ${owner} does not match transfer target`,
        true,
      );
    } catch (error) {
      await failThreadAssetTransfer(
        transfer.id,
        transfer.sourceResourceId,
        errorMessage(error),
        true,
      ).catch(() => undefined);
      console.warn("[thread-transfer] startup reconciliation deferred", {
        transferId: transfer.id,
        error,
      });
    }
  }
}
