import { z } from "zod";
import { workError } from "../errors";
import { applicationTool } from "../tools/application";
import { reindexAsset } from "./document/indexing";
import {
  attachAssetReference,
  createLibraryDocument,
  deleteAsset,
  getAssetFile,
  getLibraryAsset,
  libraryDocumentInputSchema,
  libraryDocumentVersionSchema,
  listAssets,
  readEditableDocument,
  renameAsset,
  saveLibraryDocumentVersion,
  uploadAssetFromBytes,
  uploadAssetFromFile,
} from "./storage/assets";
import { getLibrarySettings } from "./storage/db";
import { createFolder, deleteFolder, listFolders, renameFolder } from "./storage/folders";
import { type LibraryAsset, MAX_LIBRARY_FILE_BYTES } from "./types";

const id = z.string().trim().min(1).max(256);
const assetInput = z.object({ assetId: id }).strict();
const folderInput = z.object({ folderId: id }).strict();
const name = z.string().trim().min(1).max(256);
const domain = "library";

function assetSummary(asset: LibraryAsset) {
  return {
    id: asset.id,
    filename: asset.filename,
    folderIds: asset.folderIds,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
    status: asset.status,
    indexError: asset.indexError,
    mediaType: asset.mediaType,
  };
}

async function requireAsset(resourceId: string, assetId: string) {
  const asset = await getLibraryAsset(resourceId, assetId);
  if (!asset) throw workError("LIBRARY_ASSET_NOT_FOUND");
  return asset;
}

async function savedAsset(resourceId: string, assetId: string) {
  const asset = (await listAssets(resourceId)).find((entry) => entry.id === assetId);
  if (!asset) throw workError("LIBRARY_ASSET_NOT_FOUND");
  return assetSummary(asset);
}

const tools = [
  applicationTool({
    id: "app_read_library_list",
    domain,
    description:
      "List knowledge library files and folders. Find real asset/folder IDs before organizing documents. Library files may reference several folders; these are not disk directories.",
    inputSchema: z
      .object({
        folderId: id.optional(),
        query: z.string().max(200).optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict(),
    execute: async ({ folderId, query, offset, limit }, { resourceId }) => {
      const [assets, folders] = await Promise.all([
        listAssets(resourceId),
        listFolders(resourceId, ""),
      ]);
      if (folderId && !folders.some((folder) => folder.id === folderId))
        throw workError("LIBRARY_FOLDER_NOT_FOUND");
      const matches = assets.filter(
        (asset) =>
          (!folderId || asset.folderIds.includes(folderId)) &&
          (!query || asset.filename.toLowerCase().includes(query.toLowerCase())),
      );
      return {
        folders,
        total: matches.length,
        assets: matches.slice(offset, offset + limit).map(assetSummary),
      };
    },
  }),
  applicationTool({
    id: "app_read_library_document",
    domain,
    description:
      "Read a library document and its status/hash. Markdown, text and CSV use original bytes; PDF/Office use extracted text. Read all pages before editing; use sourceSha256 to save a new version.",
    inputSchema: assetInput.extend({
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(20000).default(12000),
    }),
    execute: async ({ assetId, offset, length }, { resourceId }) => {
      const asset = await requireAsset(resourceId, assetId);
      const document = /\.(md|markdown|txt|csv)$/i.test(asset.filename)
        ? await readEditableDocument(resourceId, assetId)
        : { content: asset.extractedText ?? "", sha256: asset.sha256 };
      return {
        ...assetSummary(asset),
        sha256: document.sha256,
        content: document.content.slice(offset, offset + length),
        totalCharacters: document.content.length,
        nextOffset: offset + length < document.content.length ? offset + length : null,
      };
    },
  }),
  applicationTool({
    id: "app_edit_library_create_folder",
    domain,
    description:
      "Create a knowledge library folder, optionally inside a parent folder. List first to avoid duplicate folders on retries.",
    inputSchema: z.object({ name, parentId: id.optional() }).strict(),
    execute: async (input, { resourceId }) => ({
      folder: await createFolder({ ...input, resourceId }),
    }),
  }),
  applicationTool({
    id: "app_edit_library_rename_folder",
    domain,
    description: "Rename an existing knowledge library folder by ID without changing its contents.",
    inputSchema: folderInput.extend({ name }),
    execute: async ({ folderId, name }, { resourceId }) => {
      const folder = await renameFolder(resourceId, folderId, name);
      if (!folder) throw workError("LIBRARY_FOLDER_NOT_FOUND");
      return { folder };
    },
  }),
  applicationTool({
    id: "app_edit_library_create_document",
    domain,
    description:
      "Create a Markdown, text or CSV document in the knowledge library. Supply a real folderId, or null for the library root. Identical bytes are deduplicated; verify returned ID and status before retrying.",
    inputSchema: libraryDocumentInputSchema,
    execute: async (input, { resourceId }) =>
      savedAsset(resourceId, (await createLibraryDocument(resourceId, input)).id),
  }),
  applicationTool({
    id: "app_edit_library_save_version",
    domain,
    description:
      "Save a new library document version after reading the source. Requires its sourceSha256. Does not overwrite the original or historical attachments; returns the resulting asset ID.",
    inputSchema: libraryDocumentVersionSchema.extend({ assetId: id }),
    execute: async ({ assetId, ...input }, { resourceId }) =>
      savedAsset(resourceId, (await saveLibraryDocumentVersion(resourceId, assetId, input)).id),
  }),
  applicationTool({
    id: "app_edit_library_import_file",
    domain,
    description:
      "Import an existing file from this run's authorized workspace into the knowledge library and optional folder. Copies bytes durably; never moves or deletes the source. Use workspace tools to create binary/Office files first.",
    inputSchema: z
      .object({ path: z.string().min(1), folderId: id.nullable(), filename: name.optional() })
      .strict(),
    execute: async ({ path, folderId, filename }, { resourceId, workspace, abortSignal }) => {
      const filesystem = workspace?.filesystem;
      if (!filesystem) throw new Error("The current run has no authorized workspace filesystem");
      const before = await filesystem.stat(path);
      if (before.type !== "file" || before.size < 1 || before.size > MAX_LIBRARY_FILE_BYTES)
        throw new Error("Select a regular file between 1 byte and 50 MiB");
      const content = await filesystem.readFile(path);
      const bytes = typeof content === "string" ? Buffer.from(content) : content;
      const after = await filesystem.stat(path);
      if (
        bytes.byteLength !== before.size ||
        after.size !== before.size ||
        after.modifiedAt.getTime() !== before.modifiedAt.getTime()
      )
        throw new Error("The source file changed during import; read it again before retrying");
      abortSignal?.throwIfAborted();
      const asset = await uploadAssetFromBytes({
        resourceId,
        filename: filename ?? before.name,
        folderId: folderId ?? undefined,
        bytes,
      });
      return savedAsset(resourceId, asset.id);
    },
  }),
  applicationTool({
    id: "app_edit_library_add_reference",
    domain,
    description:
      "Add an existing document to a library folder (or null for root) without removing other references. Local session attachments are copied into durable storage first. This is not a destructive move.",
    inputSchema: assetInput.extend({ folderId: id.nullable() }),
    execute: async ({ assetId, folderId }, { resourceId }) => {
      const asset = await requireAsset(resourceId, assetId);
      if (asset.status === "unsupported")
        throw new Error("This attachment format is not supported by the document library");
      if (asset.localPath) {
        const source = await getAssetFile(resourceId, assetId);
        if (!source) throw workError("LIBRARY_ASSET_NOT_FOUND");
        const durable = await uploadAssetFromFile({
          resourceId,
          filename: asset.filename,
          filePath: source.path,
          byteSize: source.asset.byteSize,
          folderId: folderId ?? undefined,
        });
        return savedAsset(resourceId, durable.id);
      }
      await attachAssetReference(resourceId, assetId, folderId ?? undefined);
      return savedAsset(resourceId, assetId);
    },
  }),
  applicationTool({
    id: "app_edit_library_rename_document",
    domain,
    description: "Rename a knowledge library asset by ID, preserving its bytes and references.",
    inputSchema: assetInput.extend({ filename: name }),
    execute: async ({ assetId, filename }, { resourceId }) => {
      if (!(await renameAsset(resourceId, assetId, filename)))
        throw workError("LIBRARY_ASSET_NOT_FOUND");
      return savedAsset(resourceId, assetId);
    },
  }),
  applicationTool({
    id: "app_edit_library_reindex",
    domain,
    description:
      "Start rebuilding a library document's search index. Read its status afterwards; accepting a reindex request is not proof of completed indexing.",
    inputSchema: assetInput,
    execute: async ({ assetId }, { resourceId }) => {
      await requireAsset(resourceId, assetId);
      await reindexAsset(resourceId, assetId, await getLibrarySettings(resourceId));
      return savedAsset(resourceId, assetId);
    },
  }),
  applicationTool({
    id: "app_delete_library_document",
    domain,
    description:
      "Permanently delete an owned library document, its search index and ALL folder/session references. Only use for an explicit deletion request, not to remove it from one folder.",
    inputSchema: assetInput,
    execute: async ({ assetId }, { resourceId }) => ({
      deleted: await deleteAsset(resourceId, assetId),
    }),
  }),
  applicationTool({
    id: "app_delete_library_folder",
    domain,
    description:
      "Remove a knowledge library folder and its references, not the document bytes. Refuses a folder with subfolders. Only use when the user requests deletion.",
    inputSchema: folderInput,
    execute: async ({ folderId }, { resourceId }) => {
      if (!(await listFolders(resourceId, "")).some((folder) => folder.id === folderId))
        throw workError("LIBRARY_FOLDER_NOT_FOUND");
      return { deleted: await deleteFolder(resourceId, folderId) };
    },
  }),
];

export const libraryApplicationTools = Object.fromEntries(tools.map((tool) => [tool.id, tool]));
