/**
 * 资料库路由(/work/library/*):资产 CRUD、分片断点续传、目录管理与重建索引。
 * RAG 主体见 src/mastra/rag/(docs/en/reference/rag/overview.mdx)。
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "@fastify/busboy";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { registerApiRoute } from "@mastra/core/server";
import { nanoid } from "nanoid";
import { errorText, workError } from "../errors";
import {
  cancelLibraryUploadSession,
  completeLibraryUploadSession,
  createFolder,
  createLibraryUploadSession,
  deleteAsset,
  deleteFolder,
  getLibrarySettings,
  getLibraryUploadSession,
  LIBRARY_UPLOAD_CHUNK_BYTES,
  listAssets,
  listFolders,
  MAX_LIBRARY_FILE_BYTES,
  MAX_LIBRARY_FILES_PER_REQUEST,
  MAX_LIBRARY_TOTAL_BYTES_PER_REQUEST,
  readAssetBytes,
  reindexAsset,
  renameAsset,
  renameFolder,
  saveLibrarySettings,
  saveLibraryUploadChunk,
  uploadAsset,
} from "../rag";

interface ParsedUpload {
  filename: string;
  mediaType: string;
  tempPath: string;
  byteSize: number;
  sha256: string;
}

async function parseUploadChunk(
  request: Request,
): Promise<Omit<ParsedUpload, "filename" | "mediaType">> {
  if (!request.body) throw new Error("上传分片没有内容");
  const directory = join(tmpdir(), "mastra-work-library-upload");
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `${nanoid()}.chunk`);
  const hash = createHash("sha256");
  let byteSize = 0;
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.byteLength;
      if (byteSize > LIBRARY_UPLOAD_CHUNK_BYTES) {
        callback(new Error("上传分片超过 5 MB"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(request.body as never), digest, createWriteStream(tempPath));
    return { tempPath, byteSize, sha256: hash.digest("hex") };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function parseMultipartUpload(
  request: Request,
): Promise<{ fields: Record<string, string>; files: ParsedUpload[] }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data"))
    throw new Error("必须使用 multipart/form-data");
  if (!request.body) throw new Error("上传请求没有内容");
  const directory = join(tmpdir(), "mastra-work-library-upload");
  await mkdir(directory, { recursive: true });
  const fields: Record<string, string> = {};
  const files: Array<ParsedUpload | undefined> = [];
  const tempPaths: string[] = [];
  const filePipelines: Promise<void>[] = [];
  let totalBytes = 0;
  let parserError: Error | undefined;
  const busboy = Busboy({
    headers: { "content-type": contentType },
    limits: {
      files: MAX_LIBRARY_FILES_PER_REQUEST,
      fileSize: MAX_LIBRARY_FILE_BYTES,
      fields: 8,
      parts: MAX_LIBRARY_FILES_PER_REQUEST + 8,
    },
  });
  busboy.on("field", (name, value) => {
    fields[name] = value;
  });
  busboy.on("file", (name, stream, filename, _encoding, mimeType) => {
    if (name !== "files") {
      stream.resume();
      parserError ??= new Error("文件字段必须命名为 files");
      return;
    }
    const tempPath = join(directory, `${nanoid()}.upload`);
    tempPaths.push(tempPath);
    const index = files.length;
    files.push(undefined);
    const hash = createHash("sha256");
    let byteSize = 0;
    const digest = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += chunk.byteLength;
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_LIBRARY_TOTAL_BYTES_PER_REQUEST) {
          callback(new Error("一次上传总大小不能超过 100 MB"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const task = pipeline(stream, digest, createWriteStream(tempPath))
      .then(() => {
        if (stream.truncated) {
          throw new Error(`单个附件超过 ${MAX_LIBRARY_FILE_BYTES / (1024 * 1024)} MB`);
        }
        files[index] = {
          filename,
          mediaType: mimeType || "application/octet-stream",
          tempPath,
          byteSize,
          sha256: hash.digest("hex"),
        };
      })
      .catch((error) => {
        parserError ??= error instanceof Error ? error : new Error("附件写入失败");
        if (!busboy.destroyed) busboy.destroy(parserError);
        throw error;
      });
    filePipelines.push(task);
  });
  busboy.on("filesLimit", () => {
    parserError ??= new Error(`一次最多上传 ${MAX_LIBRARY_FILES_PER_REQUEST} 个文件`);
    busboy.destroy(parserError);
  });
  busboy.on("fieldsLimit", () => {
    parserError ??= new Error("上传字段数量超出限制");
    busboy.destroy(parserError);
  });
  busboy.on("partsLimit", () => {
    parserError ??= new Error("上传内容数量超出限制");
    busboy.destroy(parserError);
  });
  const source = Readable.fromWeb(request.body as never);
  const parsed = pipeline(source, busboy);
  try {
    await parsed;
    await Promise.all(filePipelines);
    if (parserError) throw parserError;
  } catch (error) {
    await Promise.allSettled(filePipelines);
    await Promise.all(tempPaths.map((path) => rm(path, { force: true }).catch(() => undefined)));
    throw error instanceof Error ? error : (parserError ?? new Error("上传解析失败"));
  }
  const resolvedFiles = files.filter((file): file is ParsedUpload => Boolean(file));
  if (resolvedFiles.length === 0) throw new Error("至少上传一个文件");
  if (resolvedFiles.length > MAX_LIBRARY_FILES_PER_REQUEST)
    throw new Error(`一次最多上传 ${MAX_LIBRARY_FILES_PER_REQUEST} 个文件`);
  if (
    resolvedFiles.reduce((sum, file) => sum + file.byteSize, 0) >
    MAX_LIBRARY_TOTAL_BYTES_PER_REQUEST
  )
    throw new Error("一次上传总大小不能超过 100 MB");
  return { fields, files: resolvedFiles };
}

function requireResourceId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const libraryAssetsRoute = registerApiRoute("/work/library/assets", {
  method: "GET",
  handler: async (c) => {
    const resourceId = requireResourceId(c.req.query("resourceId"));
    if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    let assets = await listAssets(resourceId, c.req.query("threadId"));
    const folderId = c.req.query("folderId");
    if (folderId) {
      assets = assets.filter((asset) => asset.folderIds.includes(folderId));
    }
    return c.json({ assets });
  },
});

export const uploadLibraryAssetsRoute = registerApiRoute("/work/library/assets", {
  method: "POST",
  handler: async (c) => {
    let parsed: Awaited<ReturnType<typeof parseMultipartUpload>> | undefined;
    try {
      parsed = await parseMultipartUpload(c.req.raw);
      const resourceId = requireResourceId(parsed.fields.resourceId);
      if (!resourceId) throw new Error("resourceId is required");
      const folderId = requireResourceId(parsed.fields.folderId) ?? undefined;
      const threadId = requireResourceId(parsed.fields.threadId) ?? undefined;
      const assets = [];
      for (const file of parsed.files) {
        const bytes = await readFile(file.tempPath);
        assets.push(
          await uploadAsset({
            resourceId,
            folderId,
            threadId,
            filename: file.filename,
            bytes,
            mediaType: file.mediaType,
          }),
        );
        await rm(file.tempPath, { force: true }).catch(() => undefined);
      }
      return c.json({ assets });
    } catch (error) {
      if (parsed) {
        await Promise.all(
          parsed.files.map((file) => rm(file.tempPath, { force: true }).catch(() => undefined)),
        );
      }
      throw workError("LIBRARY_FILE_TOO_LARGE", {
        text: errorText(error, "上传失败"),
        cause: error,
      });
    }
  },
});

export const libraryUploadSessionsRoute = registerApiRoute("/work/library/uploads", {
  method: "POST",
  handler: async (c) => {
    try {
      const body = (await c.req.json()) as {
        resourceId?: string;
        filename?: string;
        mediaType?: string;
        byteSize?: number;
        folderId?: string;
        threadId?: string;
      };
      const resourceId = requireResourceId(body.resourceId);
      if (!resourceId || !body.filename?.trim() || typeof body.byteSize !== "number") {
        throw workError("VALIDATION_FAILED", {
          text: "resourceId, filename and byteSize are required",
        });
      }
      const session = await createLibraryUploadSession({
        resourceId,
        filename: body.filename,
        mediaType: body.mediaType || "application/octet-stream",
        byteSize: body.byteSize,
        folderId: requireResourceId(body.folderId) ?? undefined,
        threadId: requireResourceId(body.threadId) ?? undefined,
      });
      return c.json({ session }, 201);
    } catch (error) {
      throw workError("LIBRARY_UPLOAD_FAILED", {
        text: errorText(error, "创建上传会话失败"),
        cause: error,
      });
    }
  },
});

export const libraryUploadSessionRoute = registerApiRoute("/work/library/uploads/:uploadId", {
  method: "GET",
  handler: async (c) => {
    const resourceId = requireResourceId(c.req.query("resourceId"));
    if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    const session = await getLibraryUploadSession(resourceId, c.req.param("uploadId"));
    if (!session) throw workError("LIBRARY_UPLOAD_SESSION_NOT_FOUND");
    return c.json({ session });
  },
});

export const libraryUploadChunkRoute = registerApiRoute(
  "/work/library/uploads/:uploadId/chunks/:chunkIndex",
  {
    method: "PUT",
    handler: async (c) => {
      let chunk: Awaited<ReturnType<typeof parseUploadChunk>> | undefined;
      try {
        const resourceId = requireResourceId(c.req.query("resourceId"));
        const chunkIndex = Number(c.req.param("chunkIndex"));
        if (!resourceId || !Number.isInteger(chunkIndex)) {
          throw workError("VALIDATION_FAILED", {
            text: "resourceId and valid chunkIndex are required",
          });
        }
        chunk = await parseUploadChunk(c.req.raw);
        const bytes = await readFile(chunk.tempPath);
        const session = await saveLibraryUploadChunk({
          resourceId,
          sessionId: c.req.param("uploadId"),
          chunkIndex,
          bytes,
          expectedSha256: chunk.sha256,
        });
        await rm(chunk.tempPath, { force: true }).catch(() => undefined);
        return c.json({ session });
      } catch (error) {
        if (chunk) await rm(chunk.tempPath, { force: true }).catch(() => undefined);
        throw workError("LIBRARY_UPLOAD_FAILED", {
          text: errorText(error, "上传分片失败"),
          cause: error,
        });
      }
    },
  },
);

export const completeLibraryUploadRoute = registerApiRoute(
  "/work/library/uploads/:uploadId/complete",
  {
    method: "POST",
    handler: async (c) => {
      try {
        const body = (await c.req.json()) as { resourceId?: string };
        const resourceId = requireResourceId(body.resourceId);
        if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
        return c.json({
          asset: await completeLibraryUploadSession(resourceId, c.req.param("uploadId")),
        });
      } catch (error) {
        throw workError("LIBRARY_UPLOAD_FAILED", {
          text: errorText(error, "完成上传失败"),
          cause: error,
        });
      }
    },
  },
);

export const cancelLibraryUploadRoute = registerApiRoute("/work/library/uploads/:uploadId", {
  method: "DELETE",
  handler: async (c) => {
    const resourceId = requireResourceId(c.req.query("resourceId"));
    if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    const deleted = await cancelLibraryUploadSession(resourceId, c.req.param("uploadId"));
    if (!deleted) throw workError("LIBRARY_UPLOAD_SESSION_NOT_FOUND");
    return c.json({ ok: true });
  },
});

export const libraryAssetContentRoute = registerApiRoute("/work/library/assets/:assetId/content", {
  method: "GET",
  handler: async (c) => {
    const resourceId = requireResourceId(c.req.query("resourceId"));
    const assetId = c.req.param("assetId");
    if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    const result = await readAssetBytes(resourceId, assetId);
    if (!result) throw workError("LIBRARY_ASSET_NOT_FOUND");
    return c.body(Buffer.from(result.bytes) as never, 200, {
      "Content-Type": result.asset.mediaType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(result.asset.filename)}`,
      "Cache-Control": "private, max-age=3600",
    });
  },
});

export const deleteLibraryAssetRoute = registerApiRoute("/work/library/assets/:assetId", {
  method: "DELETE",
  handler: async (c) => {
    const resourceId = requireResourceId(c.req.query("resourceId"));
    if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    const deleted = await deleteAsset(resourceId, c.req.param("assetId"));
    if (!deleted) throw workError("LIBRARY_ASSET_NOT_FOUND");
    return c.json({ ok: true });
  },
});

export const renameLibraryAssetRoute = registerApiRoute("/work/library/assets/:assetId", {
  method: "PATCH",
  handler: async (c) => {
    const body = (await c.req.json()) as { resourceId?: string; filename?: string };
    const resourceId = requireResourceId(body.resourceId);
    if (!resourceId || !body.filename?.trim()) {
      throw workError("VALIDATION_FAILED", { text: "resourceId and filename are required" });
    }
    const asset = await renameAsset(resourceId, c.req.param("assetId"), body.filename);
    if (!asset) throw workError("LIBRARY_ASSET_NOT_FOUND");
    return c.json({ asset });
  },
});

export const reindexLibraryAssetRoute = registerApiRoute("/work/library/assets/:assetId/reindex", {
  method: "POST",
  handler: async (c) => {
    try {
      const body = (await c.req.json()) as { resourceId?: string };
      const resourceId = requireResourceId(body.resourceId);
      if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
      const asset = (await listAssets(resourceId)).find(
        (candidate) => candidate.id === c.req.param("assetId"),
      );
      if (!asset) throw workError("LIBRARY_ASSET_NOT_FOUND");
      const settings = await getLibrarySettings(resourceId);
      void reindexAsset(resourceId, c.req.param("assetId"), settings).catch(() => undefined);
      return c.json({ assetId: c.req.param("assetId"), status: "indexing" }, 202);
    } catch (error) {
      throw workError("LIBRARY_UPLOAD_FAILED", {
        text: errorText(error, "重新索引失败"),
        cause: error,
      });
    }
  },
});

export const reindexFailedLibraryAssetsRoute = registerApiRoute("/work/library/reindex-failed", {
  method: "POST",
  handler: async (c) => {
    try {
      const body = (await c.req.json()) as { resourceId?: string };
      const resourceId = requireResourceId(body.resourceId);
      if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
      const settings = await getLibrarySettings(resourceId);
      const assets = await listAssets(resourceId);
      const retryable = assets.filter(
        (asset) => asset.status === "error" || asset.status === "indexing",
      );
      for (const asset of retryable) {
        void reindexAsset(resourceId, asset.id, settings).catch(() => undefined);
      }
      return c.json({ assetIds: retryable.map((asset) => asset.id), status: "indexing" }, 202);
    } catch (error) {
      throw workError("LIBRARY_UPLOAD_FAILED", {
        text: errorText(error, "批量重新索引失败"),
        cause: error,
      });
    }
  },
});

export const libraryFoldersRoute = registerApiRoute("/work/library/folders", {
  method: "GET",
  handler: async (c) => {
    const resourceId = requireResourceId(c.req.query("resourceId"));
    if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    return c.json({ folders: await listFolders(resourceId, c.req.query("threadId")) });
  },
});

export const createLibraryFolderRoute = registerApiRoute("/work/library/folders", {
  method: "POST",
  handler: async (c) => {
    const body = (await c.req.json()) as {
      resourceId?: string;
      name?: string;
      parentId?: string;
      threadId?: string;
    };
    const resourceId = requireResourceId(body.resourceId);
    if (!resourceId || !body.name?.trim())
      throw workError("VALIDATION_FAILED", { text: "resourceId and name are required" });
    return c.json(
      {
        folder: await createFolder({
          resourceId,
          name: body.name,
          parentId: body.parentId,
          threadId: body.threadId,
        }),
      },
      201,
    );
  },
});

export const updateLibraryFolderRoute = registerApiRoute("/work/library/folders/:folderId", {
  method: "PATCH",
  handler: async (c) => {
    const body = (await c.req.json()) as { resourceId?: string; name?: string };
    const resourceId = requireResourceId(body.resourceId);
    if (!resourceId || !body.name?.trim()) {
      throw workError("VALIDATION_FAILED", { text: "resourceId and name are required" });
    }
    const folder = await renameFolder(resourceId, c.req.param("folderId"), body.name);
    if (!folder) throw workError("LIBRARY_FOLDER_NOT_FOUND");
    return c.json({ folder });
  },
});

export const deleteLibraryFolderRoute = registerApiRoute("/work/library/folders/:folderId", {
  method: "DELETE",
  handler: async (c) => {
    const resourceId = requireResourceId(c.req.query("resourceId"));
    if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    const deleted = await deleteFolder(resourceId, c.req.param("folderId"));
    if (!deleted) throw workError("LIBRARY_FOLDER_NOT_FOUND");
    return c.json({ ok: true });
  },
});

export const librarySettingsRoute = registerApiRoute("/work/library/settings", {
  method: "GET",
  handler: async (c) =>
    c.json({
      settings: await getLibrarySettings(
        c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string,
      ),
    }),
});

export const saveLibrarySettingsRoute = registerApiRoute("/work/library/settings", {
  method: "PUT",
  handler: async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    return c.json({
      settings: await saveLibrarySettings(
        body,
        c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string,
      ),
    });
  },
});
