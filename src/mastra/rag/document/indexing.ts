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
import { resolveConfiguredEmbeddingModelForUse, resolveDefaultLanguageModel } from "../../models";
import { getStorageDirectory, getStorageUrl } from "../../storage";
import {
  beginLibraryIndexRun,
  ensureLibrarySchema,
  finishLibraryIndexRun,
  now,
  rowToAsset,
  updateLibraryIndexRunStage,
  withClient,
} from "../storage/db";
import {
  LIBRARY_INDEX_NAMES,
  type LibraryAsset,
  type LibraryIndexStage,
  type LibrarySettings,
} from "../types";
import { extractText } from "./extract";

let vectorPromise: Promise<LibSQLVector> | undefined;
const vectorIndexPromises = new Map<string, Promise<void>>();
const indexingPromises = new Map<string, Promise<void>>();

export async function getVector(): Promise<LibSQLVector> {
  if (!vectorPromise) {
    vectorPromise = Promise.resolve(
      new LibSQLVector({ id: "library-vector", url: getStorageUrl() }),
    );
  }
  return vectorPromise;
}

export async function embeddingModelFor(settings: LibrarySettings) {
  if (settings.embeddingModel.includes("/")) {
    const configured = await resolveConfiguredEmbeddingModelForUse(settings.embeddingModel);
    if (configured) return configured;
    throw new Error(`嵌入模型 ${settings.embeddingModel} 未配置或不可用`);
  }
  return settings.embeddingModel === "base" ? fastembed.base : fastembed.small;
}

export function libraryIndexName(settings: LibrarySettings): string {
  if (settings.embeddingModel.includes("/")) {
    const safeModel = settings.embeddingModel.replace(/[^a-zA-Z0-9_]+/g, "_");
    return `library_vectors_provider_${safeModel.slice(0, 38)}`;
  }
  return settings.embeddingModel === "base" ? LIBRARY_INDEX_NAMES.base : LIBRARY_INDEX_NAMES.small;
}

function embeddingDimensions(settings: LibrarySettings): number {
  if (settings.embeddingModel === "base") return 768;
  if (settings.embeddingModel === "small") return 384;
  return 1536;
}

async function ensureVectorIndex(vector: LibSQLVector, settings: LibrarySettings): Promise<string> {
  const indexName = libraryIndexName(settings);
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
        dimension: embeddingDimensions(settings),
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
) {
  if (
    !settings.extractTitle &&
    !settings.extractSummary &&
    !settings.extractQuestions &&
    !settings.extractKeywords
  ) {
    return;
  }
  const model = modelOverride ?? (await resolveDefaultLanguageModel());
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
  const key = `${asset.resourceId}:${asset.id}`;
  const previous = indexingPromises.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      let stage: LibraryIndexStage = "chunk";
      const run = await beginLibraryIndexRun(asset.resourceId, asset.id);
      try {
        await ensureLibrarySchema();
        const vector = await getVector();
        const indexName = await ensureVectorIndex(vector, settings);
        const embeddingModel = await embeddingModelFor(settings);
        const doc = MDocument.fromText(extractedText);
        await updateLibraryIndexRunStage(run.id, "chunk");
        await extractMetadata(doc, settings);
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
          model: embeddingModel,
          values: chunkTexts,
        });

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
  const promise = indexingPromises.get(`${resourceId}:${assetId}`);
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

export async function recoverInterruptedLibraryIndexes(settings: LibrarySettings): Promise<void> {
  await ensureLibrarySchema();
  const result = await withClient((client) =>
    client.execute({
      sql: "SELECT * FROM library_assets WHERE status = 'indexing'",
      args: [],
    }),
  );
  for (const row of result.rows) {
    const asset = rowToAsset(row);
    if (asset.extractedText) {
      void queueAssetIndex(asset, asset.extractedText, settings).catch(() => undefined);
    } else {
      void reindexAsset(asset.resourceId, asset.id, settings).catch(() => undefined);
    }
  }
}
