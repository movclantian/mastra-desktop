/**
 * 资料库目录树 CRUD。
 */
import { nanoid } from "nanoid";
import type { LibraryFolder } from "../types";
import { ensureLibrarySchema, now, withClient } from "./db";

/**
 * 文件夹管理层:
 * 资料库树形目录 CRUD。
 */

export async function listFolders(resourceId: string, threadId?: string): Promise<LibraryFolder[]> {
  await ensureLibrarySchema();
  const result = await withClient((client) =>
    client.execute({
      sql: `SELECT * FROM library_folders
        WHERE resource_id = ?
          AND (? IS NULL OR thread_id IS NULL OR thread_id = '' OR thread_id = ?)
        ORDER BY created_at ASC`,
      args: [resourceId, threadId ?? null, threadId ?? ""],
    }),
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    resourceId: String(row.resource_id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    threadId: row.thread_id ? String(row.thread_id) : null,
    name: String(row.name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export async function createFolder(input: {
  resourceId: string;
  name: string;
  parentId?: string | null;
  threadId?: string | null;
}): Promise<LibraryFolder> {
  const name = input.name.trim();
  if (!name) throw new Error("文件夹名称不能为空");
  await ensureLibrarySchema();
  const id = nanoid();
  const timestamp = now();
  const parentId = input.parentId;
  if (parentId) {
    const parent = await withClient((client) =>
      client.execute({
        sql: "SELECT thread_id FROM library_folders WHERE id = ? AND resource_id = ? LIMIT 1",
        args: [parentId, input.resourceId],
      }),
    );
    const parentThreadId = parent.rows[0]?.thread_id
      ? String(parent.rows[0].thread_id)
      : undefined;
    if (!parent.rows[0]) throw new Error("父目录不存在或不属于当前账户");
    if ((parentThreadId ?? "") !== (input.threadId ?? "")) {
      throw new Error("不能把会话目录挂到其他作用域下");
    }
  }
  await withClient((client) =>
    client.execute({
      sql: `INSERT INTO library_folders (id, resource_id, parent_id, thread_id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.resourceId,
        input.parentId ?? null,
        input.threadId ?? null,
        name,
        timestamp,
        timestamp,
      ],
    }),
  );
  return {
    id,
    resourceId: input.resourceId,
    parentId: input.parentId ?? null,
    threadId: input.threadId ?? null,
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** A folder and its asset references must belong to the same library/thread scope. */
export async function ensureFolderReference(
  resourceId: string,
  folderId?: string,
  threadId?: string,
): Promise<void> {
  if (!folderId) return;
  const result = await withClient((client) =>
    client.execute({
      sql: "SELECT thread_id FROM library_folders WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [folderId, resourceId],
    }),
  );
  const row = result.rows[0];
  if (!row) throw new Error("资料库目录不存在或不属于当前账户");
  const folderThreadId = row.thread_id ? String(row.thread_id) : undefined;
  if (folderThreadId !== (threadId || undefined)) {
    throw new Error("资料库目录作用域与文件所属会话不一致");
  }
}

export async function renameFolder(
  resourceId: string,
  id: string,
  name: string,
): Promise<LibraryFolder | null> {
  const nextName = name.trim();
  if (!nextName) throw new Error("文件夹名称不能为空");
  await ensureLibrarySchema();
  const timestamp = now();
  const row = await withClient(async (client) => {
    await client.execute({
      sql: "UPDATE library_folders SET name = ?, updated_at = ? WHERE id = ? AND resource_id = ?",
      args: [nextName, timestamp, id, resourceId],
    });
    const result = await client.execute({
      sql: "SELECT * FROM library_folders WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    });
    return result.rows[0];
  });
  if (!row) return null;
  return {
    id: String(row.id),
    resourceId: String(row.resource_id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    threadId: row.thread_id ? String(row.thread_id) : null,
    name: String(row.name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function deleteFolder(
  resourceId: string,
  id: string,
  cascade = false,
): Promise<boolean> {
  await ensureLibrarySchema();
  return withClient(async (client) => {
    if (cascade) {
      await client.batch([
        {
          sql: "DELETE FROM library_asset_refs WHERE folder_id = ? AND resource_id = ?",
          args: [id, resourceId],
        },
        {
          sql: "DELETE FROM library_folders WHERE id = ? AND resource_id = ?",
          args: [id, resourceId],
        },
      ]);
      return true;
    }
    const hasChildren = await client.execute({
      sql: "SELECT 1 FROM library_folders WHERE parent_id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    });
    if (hasChildren.rows.length > 0) throw new Error("不能删除含有子文件夹的目录");
    await client.batch([
      {
        sql: "DELETE FROM library_asset_refs WHERE folder_id = ? AND resource_id = ?",
        args: [id, resourceId],
      },
      {
        sql: "DELETE FROM library_folders WHERE id = ? AND resource_id = ?",
        args: [id, resourceId],
      },
    ]);
    return true;
  });
}
