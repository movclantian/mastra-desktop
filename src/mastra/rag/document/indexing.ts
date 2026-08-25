/**
 * 向量索引管线:抽取文本 → MDocument 分块 → embedMany 嵌入 → LibSQLVector upsert。
 * 官方文档:docs/en/reference/rag/chunking-and-embedding.mdx、embeddings.mdx、
 * vector-databases.mdx;索引终态经 onLibraryIndexSettled 回调对外广播。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MastraLanguageModel } from "@mastra/core/agent";
import { fastembed } from "@mastra/fastembed";
import { LibSQLVector } from "@mastra/libsql";
import { MDocument } from "@mastra/rag";
import { embedMany } from "ai";
import { nanoid } from "nanoid";
import { resolveDefaultLanguageModel } from "../../models";
import { getStorageDirectory, getStorageUrl } from "../../storage";
import { getLibrarySettings } from "../settings";
import {
  beginLibraryIndexRun,
  ensureLibrarySchema,
  finishLibraryIndexRun,
  now,
  rowToAsset,
  updateLibraryIndexRunStage,
  withClient,
} from "../storage/db";
import type { LibraryAsset, LibraryIndexStage, LibrarySettings } from "../types";
import { extractText } from "./extract";

let vectorPromise: Promise<LibSQLVector> | undefined;
const vectorIndexPromises = new Map<string, Promise<void>>();
const indexingPromises = new Map<string, Promise<void>>();
export const LIBRARY_EMBEDDING_DIMENSION = 384;

export async function getVector(): Promise<LibSQLVector> {
  if (!vectorPromise) {
    vectorPromise = Promise.resolve(
      new LibSQLVector({ id: "library-vector", url: getStorageUrl() }),
    );
  }
  return vectorPromise;
}

export function libraryEmbedder() {
  return fastembed.smallV2;
}

export function libraryIndexName(): string {
  return "library_vectors_fastembed_small";
}

export function observedEmbeddingDimension(embeddings: readonly number[][]): number {
  const dimensions = new Set(embeddings.map((embedding) => embedding.length));
  if (dimensions.size !== 1 || dimensions.has(0)) {
    throw new Error(`本地 FastEmbed 返回了不一致的维度: ${[...dimensions].join(", ") || "空结果"}`);
  }
  const dimension = [...dimensions][0];
  if (dimension !== LIBRARY_EMBEDDING_DIMENSION) {
    throw new Error(
      `本地 FastEmbed 维度不匹配: 预期 ${LIBRARY_EMBEDDING_DIMENSION},实际 ${dimension}`,
    );
  }
  return dimension;
}

async function ensureVectorIndex(vector: LibSQLVector, dimension: number): Promise<string> {
  const indexName = libraryIndexName();
  const pending = vectorIndexPromises.get(indexName);
  if (pending) {
    await pending;
    return indexName;
  }
  const createPromise = (async () => {
    const indexes = await vector.listIndexes();
    if (!indexes.includes(indexName)) {
      await vector.createIndex({
        indexName,
        dimension,
        metric: "cosine",
      });
    }
  })();
  vectorIndexPromises.set(indexName, createPromise);
  try {
    await createPromise;
    return indexName;
  } finally {
    vectorIndexPromises.delete(indexName);
  }
}

export async function chunkDocument(doc: MDocument, settings: LibrarySettings) {
  const options = {
    maxSize: settings.chunkSize,
    overlap: settings.chunkOverlap,
  };
  switch (settings.chunkStrategy) {
    case "character":
      return doc.chunk({ strategy: "character", ...options });
    case "token":
      return doc.chunk({ strategy: "token", ...options });
    case "markdown":
      return doc.chunk({ strategy: "markdown", ...options });
    case "html":
      return doc.chunk({
        strategy: "html",
        headers: [
          ["h1", "Header 1"],
          ["h2", "Header 2"],
          ["h3", "Header 3"],
        ],
        ...options,
      });
    case "json":
      return doc.chunk({ strategy: "json", ...options });
    case "latex":
      return doc.chunk({ strategy: "latex", ...options });
    case "sentence":
      return doc.chunk({ strategy: "sentence", ...options });
    case "semantic-markdown":
      return doc.chunk({ strategy: "semantic-markdown", ...options });
    default:
      return doc.chunk({ strategy: "recursive", ...options });
  }
}

async function extractMetadata(
  doc: MDocument,
  settings: LibrarySettings,
  modelOverride?: MastraLanguageModel,
  resourceId?: string,
) {
  if (
    !settings.extractTitle &&
    !settings.extractSummary &&
    !settings.extractQuestions &&
    !settings.extractKeywords
  ) {
    return;
  }
  const model = modelOverride ?? (await resolveDefaultLanguageModel(resourceId));
  if (!model) return;
  try {
    const llm = model as never;
    await doc.extractMetadata({
      ...(settings.extractTitle ? { title: { llm } } : {}),
      ...(settings.extractSummary ? { summary: { llm } } : {}),
      ...(settings.extractQuestions ? { questions: { llm } } : {}),
      ...(settings.extractKeywords ? { keywords: { llm } } : {}),
    });
  } catch {
    // 忽略元数据提取失败
  }
}

/**
 * 索引终态事件。
 *
 * 依赖反转的注册点:本模块不能 import agents/ —— agent 的检索工具反过来
 * 依赖这里。由顶层 src/mastra/index.ts 注册处理器,在那里把事件转成
 * agent.sendNotificationSignal() 的收件箱记录(docs/en/docs/harness/signals.mdx)。
 */
export interface LibraryIndexSettledEvent {
  resourceId: string;
  assetId: string;
  filename: string;
  /** 资产关联的会话线程;通知只投给这些线程 */
  threadIds: string[];
  outcome: "succeeded" | "failed" | "unsupported";
  chunkCount?: number;
  error?: string;
}

let indexSettledHandler: ((event: LibraryIndexSettledEvent) => void) | undefined;

export function onLibraryIndexSettled(handler: (event: LibraryIndexSettledEvent) => void): void {
  indexSettledHandler = handler;
}

function emitIndexSettled(event: LibraryIndexSettledEvent): void {
  if (!indexSettledHandler || event.threadIds.length === 0) return;
  try {
    indexSettledHandler(event);
  } catch {
    // 通知是旁路能力:投递失败不影响索引本身的结果
  }
}

function queueAssetIndex(
  asset: LibraryAsset,
  extractedText: string,
  settings: LibrarySettings,
): Promise<void> {
  const key = JSON.stringify([asset.resourceId, asset.id]);
  const previous = indexingPromises.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      let stage: LibraryIndexStage = "chunk";
      const run = await beginLibraryIndexRun(asset.resourceId, asset.id);
      try {
        await ensureLibrarySchema();
        const vector = await getVector();
        const embedder = libraryEmbedder();
        const doc = MDocument.fromText(extractedText);
        await updateLibraryIndexRunStage(run.id, "chunk");
        await extractMetadata(doc, settings, undefined, asset.resourceId);
        const chunks = await chunkDocument(doc, settings);
        if (chunks.length === 0) {
          await finishLibraryIndexRun(run.id, "unsupported", "chunk", "文档未能切分出有效文本块");
          await withClient((client) =>
            client.execute({
              sql: "UPDATE library_assets SET status = 'unsupported', updated_at = ? WHERE id = ? AND resource_id = ?",
              args: [now(), asset.id, asset.resourceId],
            }),
          );
          emitIndexSettled({
            resourceId: asset.resourceId,
            assetId: asset.id,
            filename: asset.filename,
            threadIds: asset.threadIds,
            outcome: "unsupported",
          });
          return;
        }

        stage = "embedding";
        await updateLibraryIndexRunStage(run.id, "embedding");
        const chunkTexts = chunks.map((chunk) => chunk.text);
        const { embeddings } = await embedMany({
          model: embedder,
          values: chunkTexts,
        });
        const dimension = observedEmbeddingDimension(embeddings);
        const indexName = await ensureVectorIndex(vector, dimension);

        stage = "vector";
        await updateLibraryIndexRunStage(run.id, "vector");
        const vectorIds = chunks.map((_, index) => `${asset.id}_${index}`);
        const vectorMetadatas = chunks.map((chunk, index) => ({
          assetId: asset.id,
          resourceId: asset.resourceId,
          filename: asset.filename,
          chunkIndex: index,
          text: chunk.text,
          ...(chunk.metadata ?? {}),
        }));
        await vector.upsert({
          indexName,
          vectors: embeddings,
          ids: vectorIds,
          metadata: vectorMetadatas,
        });

        stage = "persist";
        await updateLibraryIndexRunStage(run.id, "persist");
        await withClient(async (client) => {
          const statements = [
            {
              sql: "DELETE FROM library_chunks WHERE asset_id = ?",
              args: [asset.id],
            },
            ...chunks.map((chunk, index) => ({
              sql: `INSERT INTO library_chunks (id, asset_id, chunk_index, text, metadata, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
              args: [
                nanoid(),
                asset.id,
                index,
                chunk.text,
                JSON.stringify(chunk.metadata ?? {}),
                now(),
              ],
            })),
            {
              sql: "UPDATE library_assets SET status = 'ready', updated_at = ? WHERE id = ? AND resource_id = ?",
              args: [now(), asset.id, asset.resourceId],
            },
          ];
          await client.batch(statements);
        });
        await finishLibraryIndexRun(run.id, "succeeded", "persist");
        emitIndexSettled({
          resourceId: asset.resourceId,
          assetId: asset.id,
          filename: asset.filename,
          threadIds: asset.threadIds,
          outcome: "succeeded",
          chunkCount: chunks.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finishLibraryIndexRun(run.id, "failed", stage, message);
        await withClient((client) =>
          client.execute({
            sql: "UPDATE library_assets SET status = 'error', updated_at = ? WHERE id = ? AND resource_id = ?",
            args: [now(), asset.id, asset.resourceId],
          }),
        );
        emitIndexSettled({
          resourceId: asset.resourceId,
          assetId: asset.id,
          filename: asset.filename,
          threadIds: asset.threadIds,
          outcome: "failed",
          error: message,
        });
      }
    })
    .finally(() => {
      if (indexingPromises.get(key) === next) indexingPromises.delete(key);
    });
  indexingPromises.set(key, next);
  return next;
}

export async function waitForAssetIndexing(resourceId: string, assetId: string): Promise<void> {
  const promise = indexingPromises.get(JSON.stringify([resourceId, assetId]));
  if (promise) await promise;
}

export async function reindexAsset(
  resourceId: string,
  assetId: string,
  settings: LibrarySettings,
): Promise<LibraryAsset | null> {
  await ensureLibrarySchema();
  const result = await withClient((client) =>
    client.execute({
      sql: "SELECT * FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [assetId, resourceId],
    }),
  );
  const row = result.rows[0];
  if (!row) return null;
  const asset = rowToAsset(row);
  let text = asset.extractedText;
  if (!text) {
    const rawPath = String(row.storage_path || "");
    const absolute = join(getStorageDirectory(), rawPath);
    const bytes = await readFile(absolute).catch(() => null);
    if (bytes) {
      text = await extractText(bytes, asset.filename, asset.mediaType);
      if (text) {
        await withClient((client) =>
          client.execute({
            sql: "UPDATE library_assets SET extracted_text = ?, updated_at = ? WHERE id = ? AND resource_id = ?",
            args: [text, now(), asset.id, asset.resourceId],
          }),
        );
        asset.extractedText = text;
      }
    }
  }
  if (!text) {
    await withClient((client) =>
      client.execute({
        sql: "UPDATE library_assets SET status = 'unsupported', updated_at = ? WHERE id = ? AND resource_id = ?",
        args: [now(), asset.id, asset.resourceId],
      }),
    );
    return { ...asset, status: "unsupported" };
  }
  await withClient((client) =>
    client.execute({
      sql: "UPDATE library_assets SET status = 'indexing', updated_at = ? WHERE id = ? AND resource_id = ?",
      args: [now(), asset.id, asset.resourceId],
    }),
  );
  void queueAssetIndex(asset, text, settings);
  return { ...asset, status: "indexing" };
}

export async function recoverInterruptedLibraryIndexes(): Promise<void> {
  await ensureLibrarySchema();
  const result = await withClient((client) =>
    client.execute({
      sql: "SELECT * FROM library_assets WHERE status = 'indexing'",
      args: [],
    }),
  );
  for (const row of result.rows) {
    const asset = rowToAsset(row);
    void (async () => {
      const settings = await getLibrarySettings(asset.resourceId);
      if (asset.extractedText) {
        await queueAssetIndex(asset, asset.extractedText, settings);
      } else {
        await reindexAsset(asset.resourceId, asset.id, settings);
      }
    })().catch(() => undefined);
  }
}
