import { basename, extname } from "node:path";

/**
 * 文件名规范、媒体类型推断与文本抽取(docx/xlsx/pdf 按需动态导入官方解析库)。
 */

export function normalizeFilename(filename: string): string {
  const name = basename(filename)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 清洗文件名中的非法字符与控制字符是本函数的目的
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim();
  return name || "未命名附件";
}

export function isTextLike(filename: string, mediaType: string): boolean {
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
