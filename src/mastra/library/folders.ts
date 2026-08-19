import { nanoid } from "nanoid";
import { ensureLibrarySchema, now, withClient } from "./db";
import type { LibraryFolder } from "./types";

/** 资料库文件夹:列表 / 新建 / 重命名 / 级联删除(递归清掉子文件夹的引用)。 */

function rowToFolder(row: Record<string, unknown>): LibraryFolder {
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

export async function listFolders(resourceId: string, threadId?: string): Promise<LibraryFolder[]> {
  await ensureLibrarySchema();
  const result = await withClient((client) =>
    client.execute({
      sql: "SELECT * FROM library_folders WHERE resource_id = ? AND (? IS NULL OR thread_id = ?) ORDER BY name COLLATE NOCASE",
      args: [resourceId, threadId ?? null, threadId ?? null],
    }),
  );
  return result.rows.map(rowToFolder);
}

export async function createFolder(
  resourceId: string,
  name: string,
  parentId?: string,
  threadId?: string,
): Promise<LibraryFolder> {
  await ensureLibrarySchema();
  const id = nanoid();
  const timestamp = now();
  const normalizedName = name.trim() || "新建文件夹";
  await withClient((client) =>
    client.execute({
      sql: "INSERT INTO library_folders (id, resource_id, parent_id, thread_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [
        id,
        resourceId,
        parentId ?? null,
        threadId ?? null,
        normalizedName,
        timestamp,
        timestamp,
      ],
    }),
  );
  return {
    id,
    resourceId,
    parentId: parentId ?? null,
    threadId: threadId ?? null,
    name: normalizedName,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function renameFolder(
  resourceId: string,
  id: string,
  name: string,
): Promise<LibraryFolder | null> {
  await ensureLibrarySchema();
  const normalized = name.trim();
  if (!normalized) throw new Error("文件夹名称不能为空");
  const timestamp = now();
  const updated = await withClient((client) =>
    client.execute({
      sql: "UPDATE library_folders SET name = ?, updated_at = ? WHERE id = ? AND resource_id = ?",
      args: [normalized, timestamp, id, resourceId],
    }),
  );
  if (updated.rowsAffected === 0) return null;
  const result = await withClient((client) =>
    client.execute({
      sql: "SELECT * FROM library_folders WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    }),
  );
  const row = result.rows[0];
  return row ? rowToFolder(row) : null;
}

export async function deleteFolder(resourceId: string, id: string): Promise<boolean> {
  await ensureLibrarySchema();
  const existing = await withClient((client) =>
    client.execute({
      sql: "SELECT id FROM library_folders WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [id, resourceId],
    }),
  );
  if (existing.rows.length === 0) return false;
  await withClient((client) =>
    client.batch([
      {
        sql: `WITH RECURSIVE descendants(id) AS (
          SELECT id FROM library_folders WHERE id = ? AND resource_id = ?
          UNION ALL
          SELECT folder.id FROM library_folders folder
          JOIN descendants parent ON folder.parent_id = parent.id
          WHERE folder.resource_id = ?
        )
        DELETE FROM library_asset_refs WHERE resource_id = ? AND folder_id IN (SELECT id FROM descendants)`,
        args: [id, resourceId, resourceId, resourceId],
      },
      {
        sql: `WITH RECURSIVE descendants(id) AS (
          SELECT id FROM library_folders WHERE id = ? AND resource_id = ?
          UNION ALL
          SELECT folder.id FROM library_folders folder
          JOIN descendants parent ON folder.parent_id = parent.id
          WHERE folder.resource_id = ?
        )
        DELETE FROM library_folders WHERE resource_id = ? AND id IN (SELECT id FROM descendants)`,
        args: [id, resourceId, resourceId, resourceId],
      },
    ]),
  );
  return true;
}
