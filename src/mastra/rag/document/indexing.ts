/**
 * 向量索引管线:抽取文本 → MDocument 分块 → embedMany 嵌入 → LibSQLVector upsert。
 * 官方文档:docs/en/reference/rag/chunking-and-embedding.mdx、embeddings.mdx、
 * vector-databases.mdx;索引终态经 onLibraryIndexSettled 回调对外广播。
 */
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { MastraLanguageModel } from "@mastra/core/agent";
import { SignalProvider } from "@mastra/core/signals";
import { fastembed } from "@mastra/fastembed";
import { LibSQLVector } from "@mastra/libsql";
import { MDocument } from "@mastra/rag";
import { embedMany } from "ai";
import { errorText } from "../../errors";
import { resolveDefaultLanguageModel } from "../../models/providers";
import { getStorageDirectory, getStorageUrl } from "../../storage/database";
import {
  beginLibraryIndexRun,
  ensureLibrarySchema,
  finishLibraryIndexRun,
  getLibrarySettings,
  now,
  rowToAsset,
  updateLibraryIndexRunStage,
  withClient,
  withLibraryAssetLock,
} from "../storage/db";
import type { LibraryAsset, LibraryIndexStage, LibrarySettings } from "../types";

/**
 * 文件名规范、媒体类型推断与文本抽取 (docs/en/reference/rag/extract-params.mdx):
 * docx/xlsx/pdf 按需动态导入官方解析库。
 */

export function normalizeFilename(filename: string): string {
  const name = basename(filename)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 清洗文件名中的非法字符与控制字符
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim();
  return name || "未命名附件";
}

function isTextLike(filename: string, mediaType: string): boolean {
  if (mediaType.startsWith("text/")) return true;
  return /\.(txt|md|markdown|json|csv|tsv|xml|yaml|yml|html|htm|js|jsx|ts|tsx|css|scss|less|py|go|rs|java|c|cpp|h|hpp|sql|sh|ps1|log)$/i.test(
    filename,
  );
}

export function isExtractable(filename: string, mediaType: string): boolean {
  if (isTextLike(filename, mediaType)) return true;
  if (mediaType === "application/pdf") return true;
  return [".docx", ".xlsx", ".xls", ".csv", ".pdf"].includes(extname(filename).toLowerCase());
}

export function resolveMediaType(filename: string, supplied: string): string {
  if (supplied && supplied !== "application/octet-stream") return supplied;
  const byExtension: Record<string, string> = {
    ".aac": "audio/aac",
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".gif": "image/gif",
    ".htm": "text/html",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".m4a": "audio/mp4",
    ".md": "text/markdown",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".oga": "audio/ogg",
    ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".zip": "application/zip",
  };
  return byExtension[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export async function extractText(
  bytes: Uint8Array,
  filename: string,
  mediaType: string,
): Promise<string | null> {
  if (isTextLike(filename, mediaType)) return Buffer.from(bytes).toString("utf8");
  const extension = extname(filename).toLowerCase();
  if (extension === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return result.value;
  }
  if ([".xlsx", ".xls", ".csv"].includes(extension)) {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(bytes, { type: "array" });
    return workbook.SheetNames.map(
      (sheet) => `# ${sheet}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[sheet])}`,
    ).join("\n\n");
  }
  if (extension === ".pdf" || mediaType === "application/pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: bytes });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  return null;
}

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

/** Called after all library requests and indexing jobs have settled. */
export async function closeLibraryVector(): Promise<void> {
  await (await vectorPromise)?.close();
}

export function libraryEmbedder() {
  return fastembed.small;
}

export function libraryIndexName(): string {
  return "library_vectors_fastembed_small";
}

export async function deleteAssetVectors(resourceId: string, assetId: string): Promise<void> {
  const vector = await getVector();
  const indexName = libraryIndexName();
  if (!(await vector.listIndexes()).includes(indexName)) return;
  await vector.deleteVectors({ indexName, filter: { resourceId, assetId } });
}

export function createDocument(text: string, filename = "", mediaType = ""): MDocument {
  const extension = filename.includes(".")
    ? filename.toLowerCase().slice(filename.lastIndexOf("."))
    : "";
  if (mediaType === "text/markdown" || extension === ".md" || extension === ".markdown") {
    return MDocument.fromMarkdown(text);
  }
  if (
    mediaType === "text/html" ||
    mediaType === "application/xhtml+xml" ||
    extension === ".html" ||
    extension === ".htm"
  ) {
    return MDocument.fromHTML(text);
  }
  if (mediaType === "application/json" || extension === ".json") {
    return MDocument.fromJSON(text);
  }
  return MDocument.fromText(text);
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
  const chunkOverlap = Math.min(settings.chunkOverlap, Math.max(0, settings.chunkSize - 1));
  if (settings.chunkStrategy === "markdown") {
    // The default Markdown splitter can reinsert its heading regex as text.
    // Split literal headings first, retaining their text and hierarchy metadata.
    await doc.chunk({
      strategy: "markdown",
      headers: [
        ["#", "Header 1"],
        ["##", "Header 2"],
        ["###", "Header 3"],
        ["####", "Header 4"],
        ["#####", "Header 5"],
        ["######", "Header 6"],
      ],
      stripHeaders: false,
    });
    // Header splitting alone ignores maxSize/overlap in the current dependency.
    return doc.chunk({
      strategy: "recursive",
      maxSize: settings.chunkSize,
      overlap: chunkOverlap,
    });
  }
  const params = {
    strategy: settings.chunkStrategy,
    maxSize: settings.chunkSize,
    overlap: chunkOverlap,
    ...(settings.chunkStrategy === "html"
      ? {
          headers: [
            ["h1", "Header 1"],
            ["h2", "Header 2"],
            ["h3", "Header 3"],
          ],
        }
      : {}),
  } as Parameters<MDocument["chunk"]>[0];
  return doc.chunk(params);
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
 * LibraryIndexSignalProvider 在 start/stop 中订阅事件并写入官方通知收件箱。
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

function onLibraryIndexSettled(handler: (event: LibraryIndexSettledEvent) => void): () => void {
  indexSettledHandler = handler;
  return () => {
    if (indexSettledHandler === handler) indexSettledHandler = undefined;
  };
}

function emitIndexSettled(event: LibraryIndexSettledEvent): void {
  if (!indexSettledHandler || event.threadIds.length === 0) return;
  try {
    indexSettledHandler(event);
  } catch {
    // 通知是旁路能力:投递失败不影响索引本身的结果
  }
}

export function queueAssetIndex(
  target: Pick<LibraryAsset, "id" | "resourceId">,
  settings: LibrarySettings,
): Promise<void> {
  const key = `${target.resourceId}\u0000${target.id}`;
  const next = withLibraryAssetLock(target.id, async () => {
    await ensureLibrarySchema();
    const result = await withClient((client) =>
      client.execute({
        sql: "SELECT * FROM library_assets WHERE id = ? AND resource_id = ? LIMIT 1",
        args: [target.id, target.resourceId],
      }),
    );
    const row = result.rows[0];
    if (!row) return;
    const asset = rowToAsset(row);
    const refs = await withClient((client) =>
      client.execute({
        sql: "SELECT DISTINCT thread_id FROM library_asset_refs WHERE asset_id = ? AND resource_id = ? AND thread_id != ''",
        args: [asset.id, asset.resourceId],
      }),
    );
    asset.threadIds = refs.rows.map((ref) => String(ref.thread_id));
    let stage: LibraryIndexStage = "extract";
    const run = await beginLibraryIndexRun(asset.resourceId, asset.id);
    try {
      await withClient((client) =>
        client.execute({
          sql: "UPDATE library_assets SET status = 'indexing', updated_at = ? WHERE id = ? AND resource_id = ?",
          args: [now(), asset.id, asset.resourceId],
        }),
      );
      let text = isExtractable(asset.filename, asset.mediaType) ? asset.extractedText : null;
      if (!text && isExtractable(asset.filename, asset.mediaType)) {
        text = await extractText(
          await readFile(join(getStorageDirectory(), String(row.storage_path))),
          asset.filename,
          asset.mediaType,
        );
      }
      await withClient((client) =>
        client.execute({
          sql: "UPDATE library_assets SET extracted_text = ?, updated_at = ? WHERE id = ? AND resource_id = ?",
          args: [text, now(), asset.id, asset.resourceId],
        }),
      );
      stage = "chunk";
      await updateLibraryIndexRunStage(run.id, "chunk");
      let chunks: Awaited<ReturnType<typeof chunkDocument>> = [];
      if (text?.trim()) {
        const doc = createDocument(text, asset.filename, asset.mediaType);
        await extractMetadata(doc, settings, undefined, asset.resourceId);
        chunks = (await chunkDocument(doc, settings)).filter((chunk) => chunk.text.trim());
      }
      if (chunks.length === 0) {
        await deleteAssetVectors(asset.resourceId, asset.id);
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
        model: libraryEmbedder(),
        values: chunkTexts,
      });
      const dimension = observedEmbeddingDimension(embeddings);
      const vector = await getVector();
      const indexName = await ensureVectorIndex(vector, dimension);

      stage = "vector";
      await updateLibraryIndexRunStage(run.id, "vector");
      const vectorIds = chunks.map((_, index) => `${asset.id}_${index}`);
      const vectorMetadatas = chunks.map((chunk, index) => ({
        ...(chunk.metadata ?? {}),
        assetId: asset.id,
        resourceId: asset.resourceId,
        filename: asset.filename,
        chunkIndex: index,
        text: chunk.text,
      }));
      await vector.deleteVectors({
        indexName,
        filter: { resourceId: asset.resourceId, assetId: asset.id },
      });
      await vector.upsert({
        indexName,
        vectors: embeddings,
        ids: vectorIds,
        metadata: vectorMetadatas,
      });

      stage = "persist";
      await updateLibraryIndexRunStage(run.id, "persist");
      await withClient((client) =>
        client.execute({
          sql: "UPDATE library_assets SET status = 'ready', updated_at = ? WHERE id = ? AND resource_id = ?",
          args: [now(), asset.id, asset.resourceId],
        }),
      );
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
      const message = errorText(error, "文档索引失败");
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
  }).finally(() => {
    if (indexingPromises.get(key) === next) indexingPromises.delete(key);
  });
  indexingPromises.set(key, next);
  return next;
}

export async function waitForAssetIndexing(resourceId: string, assetId: string): Promise<void> {
  const promise = indexingPromises.get(`${resourceId}\u0000${assetId}`);
  if (promise) await promise;
}

export async function reindexAsset(
  resourceId: string,
  assetId: string,
  settings: LibrarySettings,
): Promise<LibraryAsset | null> {
  return withLibraryAssetLock(assetId, async () => {
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
    await withClient((client) =>
      client.execute({
        sql: "UPDATE library_assets SET status = 'indexing', updated_at = ? WHERE id = ? AND resource_id = ?",
        args: [now(), asset.id, asset.resourceId],
      }),
    );
    void queueAssetIndex(asset, settings).catch((error) => {
      console.error("[library-index] reindex failed", error);
    });
    return { ...asset, status: "indexing" };
  });
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
      await queueAssetIndex(asset, settings);
    })().catch(() => undefined);
  }
}

/** Native provider lifecycle owns recovery and library notifications. */
class LibraryIndexSignalProvider extends SignalProvider {
  readonly id = "library-index-signals";
  private listenerCleanup?: () => void;
  private recovery?: Promise<void>;
  private notifications = new Set<Promise<void>>();

  async start(): Promise<void> {
    this.listenerCleanup?.();
    this.listenerCleanup = onLibraryIndexSettled((event) => {
      const summary =
        event.outcome === "succeeded"
          ? `Library indexing finished for "${event.filename}" (${event.chunkCount ?? 0} chunks). It is now retrievable.`
          : event.outcome === "unsupported"
            ? `Library indexing skipped "${event.filename}": no usable text could be extracted.`
            : `Library indexing failed for "${event.filename}"${event.error ? `: ${event.error}` : "."}`;
      for (const threadId of event.threadIds) {
        const pending = this.notify(
          {
            source: "library",
            kind: `index-${event.outcome}`,
            priority: event.outcome === "succeeded" ? "low" : "medium",
            summary,
            payload: {
              assetId: event.assetId,
              filename: event.filename,
              outcome: event.outcome,
              chunkCount: event.chunkCount,
              error: event.error,
            },
            dedupeKey: `library:index:${event.assetId}`,
          },
          { resourceId: event.resourceId, threadId },
        ).catch((error) => {
          this.mastra?.getLogger().error("Library notification failed", { error, threadId });
        });
        this.notifications.add(pending);
        void pending.finally(() => this.notifications.delete(pending));
      }
    });
    this.recovery = recoverInterruptedLibraryIndexes();
    await this.recovery;
  }

  stop(): void {
    this.listenerCleanup?.();
    this.listenerCleanup = undefined;
    super.stop();
  }

  async settled(): Promise<void> {
    await this.recovery;
    await Promise.all([...indexingPromises.values(), ...this.notifications]);
  }
}

export const libraryIndexSignals = new LibraryIndexSignalProvider();
