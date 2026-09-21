import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("library attachment processor handles both Mastra message shapes", () => {
  const processor = read("src/mastra/agents/processors.ts");
  assert.match(processor, /const rawContent = message\.content as unknown/);
  assert.match(processor, /message\.role !== "signal"/);
  assert.match(processor, /Array\.isArray\(rawContent\)/);
  assert.match(
    processor,
    /getLibraryAssetId\(record\.data\)[\s\S]*getLibraryAssetId\(record\.url\)[\s\S]*getLibraryAssetId\(record\.image\)/,
  );
  assert.match(processor, /content: Array\.isArray\(rawContent\)/);
  assert.match(processor, /processLLMRequest/);
});

test("first attachment send defers route selection until persistence succeeds", () => {
  const mutation = read("src/renderer/src/entities/workbench/model/queries/threads.ts");
  const panel = read("src/renderer/src/widgets/chat-panel/ui/chat-panel.tsx");
  assert.match(mutation, /deferSelection\?: boolean/);
  assert.match(mutation, /input\?\.deferSelection !== true/);
  assert.match(panel, /deferThreadSelection = files\.length > 0/);
  assert.match(panel, /deferSelection: true/);
  assert.match(panel, /selectThread\(targetThreadId\)/);
  assert.match(panel, /transient history\/API failure must not erase/);
  assert.doesNotMatch(
    panel,
    /catch\(\(\) => \{[\s\S]{0,220}activeThreadIdRef\.current === threadId[\s\S]{0,120}setMessages\(\[\]\)/,
  );
});

test("protected library content remains a renderer-only URL contract", () => {
  const api = read("src/renderer/src/widgets/chat-panel/api/chat-api.ts");
  const route = read("src/mastra/routes/library.ts");
  assert.match(api, /\/work\/library\/assets\//);
  assert.match(route, /libraryAssetContentRoute/);
  assert.match(route, /requireResourceId\(c\.req\.query\("resourceId"\)\)/);
});

test("renderer CSP allows protected Mastra asset images", () => {
  const main = read("src/main/index.ts");
  assert.match(main, /const MASTRA_SERVER_URL = "http:\/\/localhost:4111"/);
  assert.match(main, /img-src[^\n]*\$\{MASTRA_SERVER_URL\}/);
});

test("mixed chat attachments report rejected filenames instead of silently dropping them", () => {
  const promptInput = read("src/renderer/src/shared/ui/ai-elements/prompt-input.tsx");
  const chatPrompt = read("src/renderer/src/widgets/chat-panel/ui/prompt-input.tsx");
  assert.match(promptInput, /const rejected = incoming\.filter\(\(f\) => !matchesAccept\(f\)\)/);
  assert.match(promptInput, /unsupportedFileTypes"\)\}: \$\{rejected/);
  assert.match(promptInput, /rejected[\s\S]{0,180}file\.name[\s\S]{0,80}join\(", "\)/);
  assert.match(chatPrompt, /const acceptedFileTypes = \[/);
  assert.doesNotMatch(chatPrompt, /acceptedFileTypes[\s\S]{0,600}\.zip/);
});

test("attachment extraction boundary is explicit for unsupported binary formats", () => {
  const extract = read("src/mastra/rag/document/extract.ts");
  const processor = read("src/mastra/agents/processors.ts");
  assert.match(extract, /return \["\.docx", "\.xlsx", "\.xls", "\.csv", "\.pdf"\]/);
  assert.match(extract, /"\.zip": "application\/zip"/);
  assert.match(processor, /当前格式不能直接发送给模型/);
  assert.match(processor, /startsWith\("image\/"\)/);
  assert.match(processor, /startsWith\("audio\/"\)/);
});

test("provider boundary does not forward unknown file media types", () => {
  const processor = read("src/mastra/agents/processors.ts");
  assert.match(processor, /UNKNOWN_ATTACHMENT_MEDIA_TYPE/);
  assert.match(processor, /hasUnknownAttachmentMediaType\(record\.mediaType\)/);
  assert.match(processor, /hasUnknownAttachmentMediaType\(part\.mediaType\)/);
  assert.match(processor, /无法识别文件类型，请重新上传或选择支持的格式/);
});

test("unknown media helpers classify blank and octet-stream parts", () => {
  const processor = read("src/mastra/agents/processors.ts");
  const helperSource = processor.match(
    /function hasUnknownAttachmentMediaType\([\s\S]*?^}\r?\n\r?\nfunction unsupportedAttachmentText[\s\S]*?^}/m,
  )?.[0];
  assert.ok(helperSource, "attachment boundary helpers must remain pure and discoverable");
  const helpers = vm.runInNewContext(
    `${stripTypeScriptTypes(helperSource)}; ({ hasUnknownAttachmentMediaType, unsupportedAttachmentText })`,
    { UNKNOWN_ATTACHMENT_MEDIA_TYPE: "application/octet-stream" },
  );
  assert.equal(helpers.hasUnknownAttachmentMediaType("application/octet-stream"), true);
  assert.equal(helpers.hasUnknownAttachmentMediaType(""), true);
  assert.equal(helpers.hasUnknownAttachmentMediaType(undefined), true);
  assert.equal(helpers.hasUnknownAttachmentMediaType("image/png"), false);
  assert.match(helpers.unsupportedAttachmentText("archive.bin"), /archive\.bin/);
});

test("assistant trace coalesces replayed tool snapshots by toolCallId", () => {
  const types = read("src/renderer/src/widgets/chat-panel/model/types.ts");
  assert.match(types, /export function normalizeTraceParts\(parts: TracePart\[\]\)/);
  assert.match(types, /toolPositions\.get\(toolCallId\)/);
  assert.match(types, /toolCallId\.trim\(\)\.length > 0/);
  assert.match(types, /parts: normalizeTraceParts\(traceParts\)/);
});

test("assistant trace keeps tool parts with missing ids separate", () => {
  const types = read("src/renderer/src/widgets/chat-panel/model/types.ts");
  const declaration = types.match(/export function normalizeTraceParts\([\s\S]*?^}\r?$/m)?.[0];
  assert.ok(declaration, "trace normalizer must remain a standalone pure function");
  const normalizeTraceParts = vm.runInNewContext(
    `${stripTypeScriptTypes(declaration).replace("export function", "function")}; normalizeTraceParts`,
    {
      isToolUIPart: (part) => typeof part?.type === "string" && part.type.startsWith("tool-"),
    },
  );
  const result = normalizeTraceParts([
    { type: "tool-read", toolCallId: "call-1", state: "input-available" },
    { type: "tool-read", toolCallId: "call-1", state: "output-available" },
    { type: "tool-read", toolCallId: "", state: "input-available" },
    { type: "tool-read", toolCallId: "", state: "output-available" },
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[0].state, "output-available");
  assert.equal(result[1].toolCallId, "");
  assert.equal(result[2].toolCallId, "");
});

test("prompt width measurement does not mutate ResizeObserver targets", () => {
  const promptInput = read("src/renderer/src/widgets/chat-panel/ui/prompt-input.tsx");
  assert.match(promptInput, /cloneNode\(true\)/);
  assert.match(promptInput, /window\.requestAnimationFrame/);
  assert.match(promptInput, /const observer = new ResizeObserver\(scheduleMeasure\)/);
  assert.doesNotMatch(promptInput, /element\.style\.minWidth = "max-content"/);
});

test("attachment capability matrix keeps upload, extraction and model injection boundaries explicit", () => {
  const chatPrompt = read("src/renderer/src/widgets/chat-panel/ui/prompt-input.tsx");
  const extract = read("src/mastra/rag/document/extract.ts");
  const processor = read("src/mastra/agents/processors.ts");

  for (const extension of [".txt", ".md", ".json", ".csv", ".pdf", ".docx", ".xlsx", ".xls"]) {
    assert.match(chatPrompt, new RegExp(`"${extension}"`));
  }
  for (const extension of [".txt", ".md", ".json", ".csv", ".pdf", ".docx", ".xlsx", ".xls"]) {
    assert.match(extract, new RegExp(`\\${extension}`));
  }

  // ZIP/PPT/PPTX are deliberately not silently advertised as chat inputs:
  // library storage may retain them, but no extractor or native model path exists.
  for (const extension of [".zip", ".ppt", ".pptx"]) {
    assert.doesNotMatch(chatPrompt, new RegExp(`\\${extension}`));
  }
  assert.match(extract, /application\/zip/);
  assert.doesNotMatch(extract, /extractText[\s\S]{0,1200}pptx/);
  assert.doesNotMatch(processor, /startsWith\("video\/"\)/);
});

test("attachment actions preserve native semantics when rendered as links", () => {
  const attachment = read("src/renderer/src/shared/ui/attachment.tsx");
  assert.match(attachment, /nativeButton=\{props\.render \? false : props\.nativeButton\}/);
});

test("library upload menu explains storage, indexing, and model boundaries", () => {
  const page = read("src/renderer/src/pages/library/ui/knowledge-library-page.tsx");
  const zh = read("src/renderer/src/shared/i18n/locales/zh.ts");
  const en = read("src/renderer/src/shared/i18n/locales/en.ts");
  assert.match(page, /DropdownMenuLabel[\s\S]{0,220}library:uploadCapabilities/);
  assert.match(zh, /statusNotIndexed: "已保存，未建立文本索引"/);
  assert.match(en, /statusNotIndexed: "Saved, not text-indexed"/);
});

test("chat document uploads retain the thread ref and promote extractable files", () => {
  const api = read("src/renderer/src/widgets/chat-panel/api/chat-api.ts");
  const route = read("src/mastra/routes/library.ts");
  const assets = read("src/mastra/rag/storage/assets.ts");
  assert.match(api, /form\.set\("promoteToLibrary", "true"\)/);
  assert.match(route, /parsed\.fields\.promoteToLibrary === "true"/);
  assert.match(route, /promoteToLibrary,/);
  assert.match(assets, /input\.promoteToLibrary && isExtractable\(asset\.filename, asset\.mediaType\)/);
  assert.match(assets, /input\.promoteToLibrary && extractable && input\.threadId/);
  assert.match(assets, /asset\.hasLibraryReference = libraryAssetIds\.has\(asset\.id\)/);
});

test("promoted chat documents remain visible in the document directory", () => {
  const page = read("src/renderer/src/pages/library/ui/knowledge-library-page.tsx");
  const types = read("src/renderer/src/entities/library/model/types.ts");
  assert.match(page, /asset\.hasLibraryReference/);
  assert.match(types, /hasLibraryReference: boolean/);
});

test("chat upload invalidates the shared library query", () => {
  const panel = read("src/renderer/src/widgets/chat-panel/ui/chat-panel.tsx");
  assert.match(panel, /useQueryClient/);
  assert.match(panel, /queryClient\.invalidateQueries\(\{ queryKey: qk\.libraryContents\(user\.id\) \}\)/);
});
