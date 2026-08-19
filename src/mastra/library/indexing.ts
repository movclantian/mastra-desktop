import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MastraLanguageModel } from "@mastra/core/agent";
import { fastembed } from "@mastra/fastembed";
import { LibSQLVector } from "@mastra/libsql";
import { MDocument } from "@mastra/rag";
import { embedMany } from "ai";
import { nanoid } from "nanoid";
import { resolveConfiguredEmbeddingModelForUse, resolveDefaultLanguageModel } from "../agents/llm";
import { getStorageDirectory, getStorageUrl } from "../storage";
import {
  beginLibraryIndexRun,
  ensureLibrarySchema,
  finishLibraryIndexRun,
  now,
  rowToAsset,
  updateLibraryIndexRunStage,
  withClient,
} from "./db";
import { extractText } from "./extract";
import {
  LIBRARY_INDEX_NAMES,
  type LibraryAsset,
  type LibraryIndexStage,
  type LibrarySettings,
} from "./types";

/**
 * 向量索引层:FastEmbed 或供应商 embedding + LibSQLVector 索引 + MDocument 分块。
 * settings 由调用方传入(分块/嵌入参数跟随当时的库设置),本模块不回读配置,
 * 保持 settings → indexing 单向依赖。
 */

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
  // includes("/") 分支已排除 provider 形态,此处必为 fastembed 档位键
  return LIBRARY_INDEX_NAMES[settings.embeddingModel as keyof typeof LIBRARY_INDEX_NAMES];
}

async function ensureVectorIndex(dimension: number, indexName: string): Promise<LibSQLVector> {
  const vector = await getVector();
  let vectorIndexPromise = vectorIndexPromises.get(indexName);
  if (!vectorIndexPromise) {
    vectorIndexPromise = (async () => {
      const indexes = await vector.listIndexes();
      if (!indexes.includes(indexName)) {
        await vector.createIndex({
          indexName,
          dimension,
          metric: "cosine",
        });
      }
    })().catch((error) => {
      vectorIndexPromises.delete(indexName);
      throw error;
    });
    vectorIndexPromises.set(indexName, vectorIndexPromise);
  }
  await vectorIndexPromise;
  return vector;
}

async function resolveLibraryModel(): Promise<MastraLanguageModel | undefined> {
  return (await resolveDefaultLanguageModel()) as MastraLanguageModel | undefined;
}

export async function chunkDocument(document: MDocument, settings: LibrarySettings) {
  const extractionEnabled =
    settings.extractTitle ||
    settings.extractSummary ||
    settings.extractQuestions ||
    settings.extractKeywords;
  const model = extractionEnabled ? await resolveLibraryModel() : undefined;
  if (extractionEnabled && !model) {
    throw new Error("元数据抽取需要当前选中 OpenAI、Anthropic 或 Gemini 模型");
  }
  const extract = model
    ? {
        ...(settings.extractTitle ? { title: { llm: model } } : {}),
        ...(settings.extractSummary ? { summary: { llm: model } } : {}),
        ...(settings.extractQuestions ? { questions: { llm: model } } : {}),
        ...(settings.extractKeywords ? { keywords: { llm: model } } : {}),
      }
    : undefined;
  const common = { maxSize: settings.chunkSize, overlap: settings.chunkOverlap, extract };
  switch (settings.chunkStrategy) {
    case "character":
      return document.chunk({ strategy: "character", ...common });
    case "token":
      return document.chunk({ strategy: "token", ...common });
    case "markdown":
      return document.chunk({ strategy: "markdown", ...common });
    case "html":
      return document.chunk({ strategy: "html", headers: [["h1", "h1"]], ...common });
    case "json":
      return document.chunk({ strategy: "json", ...common });
    case "latex":
      return document.chunk({ strategy: "latex", ...common });
    case "sentence":
      return document.chunk({
        strategy: "sentence",
        maxSize: settings.chunkSize,
        overlap: settings.chunkOverlap,
        extract,
      });
    case "semantic-markdown":
      return document.chunk({ strategy: "semantic-markdown", ...common });
    default:
      return document.chunk({ strategy: "recursive", ...common });
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000) || "索引任务失败";
}

async function markIndexFailure(
  asset: LibraryAsset,
  runId: string | undefined,
  defaultStage: LibraryIndexStage,
  error: unknown,
): Promise<void> {
  const message = errorMessage(error);
  let stage = defaultStage;
  if (runId) {
    try {
      const latest = await withClient((client) =>
        client.execute({ sql: "SELECT stage FROM library_index_runs WHERE id = ?", args: [runId] }),
      );
      const value = String(latest.rows[0]?.stage ?? defaultStage);
      if (["extract", "chunk", "embedding", "vector", "persist"].includes(value)) {
        stage = value as LibraryIndexStage;
      }
    } catch {
      // 保留默认阶段,不让诊断查询覆盖原始索引错误。
    }
    await finishLibraryIndexRun(runId, "failed", stage, message).catch(() => undefined);
  }
  await setAssetStatus(asset, "error").catch(() => undefined);
}

async function setAssetStatus(asset: LibraryAsset, status: LibraryAsset["status"]): Promise<void> {
  await withClient((client) =>
    client.execute({
      sql: "UPDATE library_assets SET status = ?, updated_at = ? WHERE id = ? AND resource_id = ?",
      args: [status, now(), asset.id, asset.resourceId],
    }),
  );
}

async function indexAsset(
  asset: LibraryAsset,
  text: string,
  settings: LibrarySettings,
  runId: string,
): Promise<void> {
  const indexName = libraryIndexName(settings);
  const document = MDocument.fromText(text, {
    assetId: asset.id,
    filename: asset.filename,
  });
  await updateLibraryIndexRunStage(runId, "chunk");
  const chunks = (await chunkDocument(document, settings)).filter((chunk) => Boolean(chunk.text));
  const values = chunks.map((chunk) => chunk.text);
  if (values.length === 0) {
    await setAssetStatus(asset, "unsupported");
    await finishLibraryIndexRun(runId, "unsupported", "chunk");
    return;
  }
  await updateLibraryIndexRunStage(runId, "embedding");
  const embeddingModel = await embeddingModelFor(settings);
  const { embeddings } = await embedMany({ model: embeddingModel, values });
  if (embeddings.length !== values.length || !embeddings[0]?.length) {
    throw new Error("嵌入模型没有返回完整的向量结果");
  }
  await updateLibraryIndexRunStage(runId, "vector");
  const vector = await ensureVectorIndex(embeddings[0]?.length ?? 384, indexName);
  const chunkIds = chunks.slice(0, embeddings.length).map(() => nanoid());
  const timestamp = now();
  await withClient(async (client) => {
    await client.batch([
      {
        sql: "DELETE FROM library_chunks WHERE asset_id = ?",
        args: [asset.id],
      },
      ...chunks.slice(0, embeddings.length).map((chunk, index) => ({
        sql: `INSERT INTO library_chunks (id, asset_id, chunk_index, text, metadata, created_at)
          SELECT ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM library_assets WHERE id = ? AND resource_id = ?)`,
        args: [
          chunkIds[index],
          asset.id,
          index,
          chunk.text,
          JSON.stringify(chunk.metadata ?? {}),
          timestamp,
          asset.id,
          asset.resourceId,
        ],
      })),
    ]);
  });
  const exists = await withClient((client) =>
    client.execute({
      sql: "SELECT id FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
      args: [asset.id, asset.resourceId],
    }),
  );
  if (exists.rows.length === 0) {
    await withClient((client) =>
      client.execute({
        sql: "DELETE FROM library_chunks WHERE asset_id = ?",
        args: [asset.id],
      }),
    );
    throw new Error("资料库资产在索引过程中已被删除");
  }
  await vector.deleteVectors({
    indexName,
    filter: { assetId: asset.id },
  });
  const allIndexes = await vector.listIndexes();
  await Promise.all(
    allIndexes
      .filter((name) => name.startsWith("library_vectors_") && name !== indexName)
      .map((name) =>
        vector
          .deleteVectors({ indexName: name, filter: { assetId: asset.id } })
          .catch(() => undefined),
      ),
  );
  await vector.upsert({
    indexName,
    ids: chunkIds,
    vectors: embeddings.slice(0, chunkIds.length),
    metadata: chunks.slice(0, chunkIds.length).map((chunk, index) => ({
      assetId: asset.id,
      resourceId: asset.resourceId,
      chunkId: chunkIds[index],
      text: chunk.text,
      filename: asset.filename,
    })),
  });
  await updateLibraryIndexRunStage(runId, "persist");
  const markedReady = await withClient((client) =>
    client.execute({
      sql: "UPDATE library_assets SET status = ?, updated_at = ? WHERE id = ? AND resource_id = ?",
      args: ["ready", now(), asset.id, asset.resourceId],
    }),
  );
  if (markedReady.rowsAffected === 0) {
    await vector.deleteVectors({ indexName, filter: { assetId: asset.id } }).catch(() => undefined);
    throw new Error("资料库资产在索引完成前已被删除");
  }
  await finishLibraryIndexRun(runId, "succeeded", "persist");
}

/** 排队索引同一资产的任务(进行中直接复用,避免并发重建) */
export function queueAssetIndex(
  asset: LibraryAsset,
  text: string,
  settings: LibrarySettings,
): Promise<void> {
  const current = indexingPromises.get(asset.id);
  if (current) return current;
  let task: Promise<void>;
  task = (async () => {
    let runId: string | undefined;
    const stage: LibraryIndexStage = "chunk";
    try {
      await ensureLibrarySchema();
      const run = await beginLibraryIndexRun(asset.resourceId, asset.id);
      runId = run.id;
      await setAssetStatus(asset, "indexing");
      await updateLibraryIndexRunStage(runId, stage);
      await indexAsset(asset, text, settings, runId);
    } catch (error) {
      await markIndexFailure(asset, runId, stage, error);
      throw error;
    }
  })().finally(() => {
    if (indexingPromises.get(asset.id) === task) indexingPromises.delete(asset.id);
  });
  indexingPromises.set(asset.id, task);
  return task;
}

/** 从原文件重新抽取并完整重建资产索引。用于失败重试与进程重启恢复。 */
export function reindexAsset(
  resourceId: string,
  assetId: string,
  settings: LibrarySettings,
): Promise<void> {
  const current = indexingPromises.get(assetId);
  if (current) return current;
  let task: Promise<void>;
  task = (async () => {
    await ensureLibrarySchema();
    const result = await withClient((client) =>
      client.execute({
        sql: "SELECT * FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
        args: [assetId, resourceId],
      }),
    );
    const row = result.rows[0];
    if (!row) throw new Error("资料库文件不存在");
    const asset = rowToAsset(row);
    const storagePath = String(row.storage_path);
    let runId: string | undefined;
    const stage: LibraryIndexStage = "extract";
    try {
      const run = await beginLibraryIndexRun(resourceId, assetId);
      runId = run.id;
      await setAssetStatus(asset, "indexing");
      await updateLibraryIndexRunStage(runId, stage);
      await withClient((client) =>
        client.execute({
          sql: "UPDATE library_assets SET extracted_text = NULL, updated_at = ? WHERE id = ? AND resource_id = ?",
          args: [now(), assetId, resourceId],
        }),
      );
      const bytes = new Uint8Array(await readFile(join(getStorageDirectory(), storagePath)));
      const text = await extractText(bytes, asset.filename, asset.mediaType);
      if (!text?.trim()) {
        await setAssetStatus(asset, "unsupported");
        await finishLibraryIndexRun(runId, "unsupported", "extract");
        return;
      }
      await withClient((client) =>
        client.execute({
          sql: "UPDATE library_assets SET extracted_text = ?, updated_at = ? WHERE id = ? AND resource_id = ?",
          args: [text, now(), assetId, resourceId],
        }),
      );
      await updateLibraryIndexRunStage(runId, "chunk");
      await indexAsset({ ...asset, extractedText: text }, text, settings, runId);
    } catch (error) {
      await markIndexFailure(asset, runId, stage, error);
      throw error;
    }
  })().finally(() => {
    if (indexingPromises.get(assetId) === task) indexingPromises.delete(assetId);
  });
  indexingPromises.set(assetId, task);
  return task;
}

/** 启动时把上次中断的 indexing 资产重新加入索引队列。 */
export async function recoverInterruptedLibraryIndexes(settings: LibrarySettings): Promise<void> {
  await ensureLibrarySchema();
  const result = await withClient((client) =>
    client.execute({
      sql: `SELECT id, resource_id
        FROM library_assets
        WHERE status = ?
        UNION
        SELECT a.id, a.resource_id
        FROM library_assets a
        JOIN library_index_runs r ON r.asset_id = a.id AND r.resource_id = a.resource_id
        WHERE r.status = ?`,
      args: ["indexing", "running"],
    }),
  );
  const interrupted = await withClient((client) =>
    client.execute({
      sql: "SELECT id, stage FROM library_index_runs WHERE status = ?",
      args: ["running"],
    }),
  );
  await Promise.all(
    interrupted.rows.map((row) =>
      finishLibraryIndexRun(
        String(row.id),
        "failed",
        String(row.stage) as LibraryIndexStage,
        "应用进程在索引完成前退出",
      ).catch(() => undefined),
    ),
  );
  await Promise.all(
    result.rows.map((row) =>
      reindexAsset(String(row.resource_id), String(row.id), settings).catch(() => undefined),
    ),
  );
}

/** 等待某资产正在进行的索引任务结束(重命名/删除前调用,避免旧任务写回) */
export async function waitForAssetIndexing(assetId: string): Promise<void> {
  await indexingPromises.get(assetId)?.catch(() => undefined);
}
