/**
 * RAG 数据库存储层(docs/en/reference/rag/database-config.mdx):
 * 共享 LibSQL 客户端、library_* 表建表与索引运行状态记录。
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { nanoid } from "nanoid";
import { getLibsqlClient, getStorageDirectory } from "../../storage";
import type {
  LibraryAsset,
  LibraryIndexRunStatus,
  LibraryIndexRunSummary,
  LibraryIndexStage,
  LibraryUploadSession,
} from "../types";

export function now(): string {
  return new Date().toISOString();
}

export async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  return run(await getLibsqlClient());
}

const uploadChunksDirectory = () => join(getStorageDirectory(), "library", "_chunks");

const UPLOAD_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

async function cleanupOrphanedUploadDirectories(client: Client): Promise<void> {
  const entries = await readdir(uploadChunksDirectory(), { withFileTypes: true }).catch(() => []);
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length === 0) return;

  const placeholders = directories.map(() => "?").join(", ");
  const active = await client.execute({
    sql: `SELECT id FROM library_upload_sessions WHERE id IN (${placeholders})`,
    args: directories.map((entry) => entry.name),
  });
  const activeIds = new Set(active.rows.map((row) => String(row.id ?? "")));
  const cutoff = Date.now() - UPLOAD_ORPHAN_GRACE_MS;
  await Promise.all(
    directories.map(async (entry) => {
      if (activeIds.has(entry.name)) return;
      const directory = join(uploadChunksDirectory(), entry.name);
      const details = await stat(directory).catch(() => null);
      if (!details || details.mtimeMs > cutoff) return;
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }),
  );
}

async function cleanupExpiredUploadSessions(client: Client): Promise<void> {
  const expired = await client.execute({
    sql: "SELECT id FROM library_upload_sessions WHERE expires_at <= ?",
    args: [now()],
  });
  const sessionIds = expired.rows
    .map((row) => (typeof row.id === "string" ? row.id : String(row.id ?? "")))
    .filter(Boolean);
  if (sessionIds.length > 0) {
    const removedIds = (
      await Promise.all(
        sessionIds.map(async (sessionId) => {
          try {
            await rm(join(uploadChunksDirectory(), sessionId), { recursive: true, force: true });
            return sessionId;
          } catch {
            // Keep the database row so a later startup/request can retry the disk cleanup.
            return undefined;
          }
        }),
      )
    ).filter((sessionId): sessionId is string => Boolean(sessionId));
    if (removedIds.length > 0) {
      const removedPlaceholders = removedIds.map(() => "?").join(", ");
      await client.batch([
        {
          sql: `DELETE FROM library_upload_chunks WHERE session_id IN (${removedPlaceholders})`,
          args: removedIds,
        },
        {
          sql: `DELETE FROM library_upload_sessions WHERE id IN (${removedPlaceholders})`,
          args: removedIds,
        },
      ]);
    }
  }

  await cleanupOrphanedUploadDirectories(client);
}

let uploadCleanupPromise: Promise<void> | undefined;
let nextUploadCleanupAt = 0;

/** Best-effort maintenance: one scan at a time, at most once per five minutes. */
export function cleanupExpiredLibraryUploadSessions(): Promise<void> {
  if (uploadCleanupPromise) return uploadCleanupPromise;
  if (Date.now() < nextUploadCleanupAt) return Promise.resolve();
  uploadCleanupPromise = withClient((client) => cleanupExpiredUploadSessions(client)).finally(
    () => {
      nextUploadCleanupAt = Date.now() + 5 * 60 * 1000;
      uploadCleanupPromise = undefined;
    },
  );
  return uploadCleanupPromise;
}

let schemaPromise: Promise<void> | undefined;

export async function ensureLibrarySchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = withClient(async (client) => {
      await client.batch([
        {
          sql: `CREATE TABLE IF NOT EXISTS library_folders (
            id TEXT PRIMARY KEY,
            resource_id TEXT NOT NULL,
            parent_id TEXT,
            thread_id TEXT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )`,
          args: [],
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS library_assets (
            id TEXT PRIMARY KEY,
            resource_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            media_type TEXT NOT NULL,
            byte_size INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            storage_path TEXT NOT NULL,
            status TEXT NOT NULL,
            extracted_text TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(resource_id, sha256)
          )`,
          args: [],
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS library_asset_refs (
            asset_id TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            folder_id TEXT NOT NULL DEFAULT '',
            thread_id TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            PRIMARY KEY(asset_id, folder_id, thread_id)
          )`,
          args: [],
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS library_chunks (
            id TEXT PRIMARY KEY,
            asset_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            text TEXT NOT NULL,
            metadata TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(asset_id, chunk_index)
          )`,
          args: [],
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS library_index_runs (
            id TEXT PRIMARY KEY,
            asset_id TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            status TEXT NOT NULL,
            stage TEXT NOT NULL,
            error_message TEXT,
            started_at TEXT NOT NULL,
            completed_at TEXT
          )`,
          args: [],
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS library_upload_sessions (
            id TEXT PRIMARY KEY,
            resource_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            media_type TEXT NOT NULL,
            byte_size INTEGER NOT NULL,
            chunk_size INTEGER NOT NULL,
            total_chunks INTEGER NOT NULL,
            folder_id TEXT NOT NULL DEFAULT '',
            thread_id TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          )`,
          args: [],
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS library_upload_chunks (
            session_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            byte_size INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            storage_path TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(session_id, chunk_index)
          )`,
          args: [],
        },
        {
          sql: "CREATE INDEX IF NOT EXISTS library_assets_resource_idx ON library_assets(resource_id, updated_at)",
          args: [],
        },
        {
          sql: "CREATE INDEX IF NOT EXISTS library_asset_refs_thread_idx ON library_asset_refs(resource_id, thread_id, asset_id)",
          args: [],
        },
        {
          sql: "CREATE INDEX IF NOT EXISTS library_chunks_asset_idx ON library_chunks(asset_id, chunk_index)",
          args: [],
        },
        {
          sql: "CREATE INDEX IF NOT EXISTS library_index_runs_asset_idx ON library_index_runs(resource_id, asset_id, attempt)",
          args: [],
        },
        {
          sql: "CREATE INDEX IF NOT EXISTS library_upload_sessions_resource_idx ON library_upload_sessions(resource_id, updated_at)",
          args: [],
        },
        {
          sql: "CREATE INDEX IF NOT EXISTS library_upload_sessions_expires_idx ON library_upload_sessions(expires_at)",
          args: [],
        },
      ]);
      void cleanupExpiredLibraryUploadSessions().catch((error) => {
        console.warn("[library-upload] startup cleanup deferred", error);
      });
    });
  }
  await schemaPromise;
}

export function rowToAsset(row: Record<string, unknown>): LibraryAsset {
  return {
    id: String(row.id),
    resourceId: String(row.resource_id),
    folderIds: [],
    threadIds: [],
    hasLibraryReference: false,
    filename: String(row.filename),
    mediaType: String(row.media_type),
    byteSize: Number(row.byte_size),
    sha256: String(row.sha256),
    status: String(row.status) as LibraryAsset["status"],
    extractedText: row.extracted_text ? String(row.extracted_text) : null,
    indexAttempt: 0,
    indexStage: null,
    indexError: null,
    indexStartedAt: null,
    indexCompletedAt: null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function beginLibraryIndexRun(
  resourceId: string,
  assetId: string,
): Promise<{ id: string; attempt: number }> {
  const id = nanoid();
  const startedAt = now();
  return withClient(async (client) => {
    const latest = await client.execute({
      sql: "SELECT COALESCE(MAX(attempt), 0) AS attempt FROM library_index_runs WHERE resource_id = ? AND asset_id = ?",
      args: [resourceId, assetId],
    });
    const attempt = Number(latest.rows[0]?.attempt ?? 0) + 1;
    await client.execute({
      sql: `INSERT INTO library_index_runs
        (id, asset_id, resource_id, attempt, status, stage, error_message, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      args: [id, assetId, resourceId, attempt, "running", "extract", startedAt],
    });
    return { id, attempt };
  });
}

export async function updateLibraryIndexRunStage(
  runId: string,
  stage: LibraryIndexStage,
): Promise<void> {
  await withClient((client) =>
    client.execute({
      sql: "UPDATE library_index_runs SET stage = ?, status = ?, error_message = NULL WHERE id = ?",
      args: [stage, "running", runId],
    }),
  );
}

export async function finishLibraryIndexRun(
  runId: string,
  status: LibraryIndexRunStatus,
  stage: LibraryIndexStage,
  errorMessage?: string,
): Promise<void> {
  await withClient((client) =>
    client.execute({
      sql: "UPDATE library_index_runs SET status = ?, stage = ?, error_message = ?, completed_at = ? WHERE id = ?",
      args: [status, stage, errorMessage ?? null, now(), runId],
    }),
  );
}

export async function getLatestLibraryIndexRuns(
  resourceId: string,
): Promise<Map<string, LibraryIndexRunSummary>> {
  const result = await withClient((client) =>
    client.execute({
      sql: `SELECT r.asset_id, r.attempt, r.status, r.stage, r.error_message, r.started_at, r.completed_at
        FROM library_index_runs r
        JOIN (
          SELECT resource_id, asset_id, MAX(attempt) AS attempt
          FROM library_index_runs
          WHERE resource_id = ?
          GROUP BY resource_id, asset_id
        ) latest ON latest.resource_id = r.resource_id
          AND latest.asset_id = r.asset_id
          AND latest.attempt = r.attempt
        WHERE r.resource_id = ?`,
      args: [resourceId, resourceId],
    }),
  );
  return new Map(
    result.rows.map((row) => [
      String(row.asset_id),
      {
        assetId: String(row.asset_id),
        attempt: Number(row.attempt),
        status: String(row.status) as LibraryIndexRunStatus,
        stage: String(row.stage) as LibraryIndexStage,
        error: row.error_message ? String(row.error_message) : null,
        startedAt: String(row.started_at),
        completedAt: row.completed_at ? String(row.completed_at) : null,
      },
    ]),
  );
}

export function rowToUploadSession(
  row: Record<string, unknown>,
  completedChunks: number[] = [],
): LibraryUploadSession {
  return {
    id: String(row.id),
    resourceId: String(row.resource_id),
    filename: String(row.filename),
    mediaType: String(row.media_type),
    byteSize: Number(row.byte_size),
    chunkSize: Number(row.chunk_size),
    totalChunks: Number(row.total_chunks),
    folderId: String(row.folder_id || "") || undefined,
    threadId: String(row.thread_id || "") || undefined,
    completedChunks,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
