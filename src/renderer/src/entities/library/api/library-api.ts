import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import { apiError, type WorkErrorPayload } from "@/shared/lib";
import type {
  LibraryAsset,
  LibraryFolder,
  LibrarySettings,
  LibraryUploadSession,
  RenameTarget,
} from "../model/types";

function resourceQuery(resourceId: string): string {
  return `resourceId=${encodeURIComponent(resourceId)}`;
}

async function readJson<T extends object>(response: Response, fallback: string): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & Partial<WorkErrorPayload>;
  if (!response.ok) throw apiError(payload, fallback);
  return payload;
}

export async function fetchLibraryContents(resourceId: string): Promise<{
  assets: LibraryAsset[];
  folders: LibraryFolder[];
}> {
  const suffix = resourceQuery(resourceId);
  const [assetResponse, folderResponse] = await Promise.all([
    apiFetch(`${MASTRA_SERVER_URL}/work/library/assets?${suffix}`),
    apiFetch(`${MASTRA_SERVER_URL}/work/library/folders?${suffix}`),
  ]);
  const assets = await readJson<{ assets?: LibraryAsset[] }>(assetResponse, "读取资料库失败");
  const folders = await readJson<{ folders?: LibraryFolder[] }>(folderResponse, "读取资料库失败");
  return { assets: assets.assets ?? [], folders: folders.folders ?? [] };
}

export async function fetchLibrarySettings(): Promise<LibrarySettings> {
  const payload = await readJson<{ settings: LibrarySettings }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/library/settings`),
    "读取资料库设置失败",
  );
  return payload.settings;
}

export function libraryAssetContentUrl(assetId: string, resourceId: string): string {
  return `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(assetId)}/content?${resourceQuery(resourceId)}`;
}

export async function fetchLibraryAssetBlob(url: string): Promise<Blob> {
  const response = await apiFetch(url);
  if (!response.ok) throw new Error("文件加载失败");
  return response.blob();
}

export async function saveLibrarySettings(settings: LibrarySettings): Promise<LibrarySettings> {
  const payload = await readJson<{ settings: LibrarySettings }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/library/settings`, {
      method: "PUT",
      body: { ...settings },
    }),
    "保存资料库设置失败",
  );
  return payload.settings;
}

export async function createLibraryUploadSession(
  resourceId: string,
  body: {
    filename: string;
    mediaType: string;
    byteSize: number;
    folderId?: string;
    threadId?: string;
    resumeId?: string;
  },
): Promise<LibraryUploadSession> {
  const payload = await readJson<{ session?: LibraryUploadSession }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/library/uploads`, {
      method: "POST",
      body: { resourceId, ...body },
    }),
    "创建上传会话失败",
  );
  if (!payload.session) throw new Error("创建上传会话失败");
  return payload.session;
}

export function libraryUploadChunkUrl(
  sessionId: string,
  resourceId: string,
  index: number,
): string {
  return `${MASTRA_SERVER_URL}/work/library/uploads/${encodeURIComponent(sessionId)}/chunks/${index}?${resourceQuery(resourceId)}`;
}

export async function completeLibraryUpload(
  sessionId: string,
  resourceId: string,
): Promise<LibraryAsset> {
  const payload = await readJson<{ asset?: LibraryAsset }>(
    await apiFetch(
      `${MASTRA_SERVER_URL}/work/library/uploads/${encodeURIComponent(sessionId)}/complete`,
      { method: "POST", body: { resourceId } },
    ),
    "完成上传失败",
  );
  if (!payload.asset) throw new Error("完成上传失败");
  return payload.asset;
}

export function cancelLibraryUpload(sessionId: string, resourceId: string): Promise<void> {
  return apiFetch(
    `${MASTRA_SERVER_URL}/work/library/uploads/${encodeURIComponent(sessionId)}?${resourceQuery(resourceId)}`,
    { method: "DELETE" },
  ).then(async (response) => {
    await readJson(response, "取消上传失败");
  });
}

export async function createLibraryFolder(
  resourceId: string,
  name: string,
  parentId: string | null,
): Promise<void> {
  await readJson(
    await apiFetch(`${MASTRA_SERVER_URL}/work/library/folders`, {
      method: "POST",
      body: { resourceId, name, ...(parentId ? { parentId } : {}) },
    }),
    "创建文件夹失败",
  );
}

export async function deleteLibraryAsset(assetId: string, resourceId: string): Promise<void> {
  await readJson(
    await apiFetch(
      `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(assetId)}?${resourceQuery(resourceId)}`,
      { method: "DELETE" },
    ),
    "删除文件失败",
  );
}

export async function renameLibraryTarget(
  target: RenameTarget,
  resourceId: string,
  value: string,
): Promise<void> {
  const endpoint =
    target.kind === "asset"
      ? `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(target.id)}`
      : `${MASTRA_SERVER_URL}/work/library/folders/${encodeURIComponent(target.id)}`;
  await readJson(
    await apiFetch(endpoint, {
      method: "PATCH",
      body: {
        resourceId,
        ...(target.kind === "asset" ? { filename: value } : { name: value }),
      },
    }),
    "重命名失败",
  );
}

export async function deleteLibraryFolder(folderId: string, resourceId: string): Promise<void> {
  await readJson(
    await apiFetch(
      `${MASTRA_SERVER_URL}/work/library/folders/${encodeURIComponent(folderId)}?${resourceQuery(resourceId)}`,
      { method: "DELETE" },
    ),
    "删除文件夹失败",
  );
}

export async function reindexLibraryAsset(assetId: string, resourceId: string): Promise<void> {
  await readJson(
    await apiFetch(
      `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(assetId)}/reindex`,
      {
        method: "POST",
        body: { resourceId },
      },
    ),
    "重新索引失败",
  );
}

export async function reindexFailedLibraryAssets(resourceId: string): Promise<string[]> {
  const payload = await readJson<{ assetIds?: string[] }>(
    await apiFetch(`${MASTRA_SERVER_URL}/work/library/reindex-failed`, {
      method: "POST",
      body: { resourceId },
    }),
    "批量重新索引失败",
  );
  return payload.assetIds ?? [];
}
