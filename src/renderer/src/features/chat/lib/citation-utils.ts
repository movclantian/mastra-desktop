import type { UIMessage } from "ai";
import { defaultRehypePlugins, type StreamdownProps } from "streamdown";
import { asString } from "../types";

export interface CitationSource {
  url: string;
  title: string;
  description?: string;
}

export type CitationEntries = Map<string, CitationSource[]>;

const FOOTNOTE_DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/gm;
const FOOTNOTE_REFERENCE = /\[\^([^\]\s]+)\]/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>)\]]+/g;

interface LibrarySourcePart {
  type: "data-library-sources";
  data: Array<{ id: string; url: string; filename: string; snippet?: string }>;
}

interface HastElement {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastElement[];
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function isUsableUrl(url: string): boolean {
  try {
    return Boolean(new URL(url).hostname);
  } catch {
    return false;
  }
}

function parseDefinitionBody(body: string): CitationSource[] {
  const sources: CitationSource[] = [];
  const seen = new Set<string>();
  let rest = body;
  const push = (url: string, title?: string) => {
    if (!isUsableUrl(url) || seen.has(url)) return;
    seen.add(url);
    sources.push({ url, title: title?.trim() || hostnameOf(url) });
  };

  for (const match of body.matchAll(MARKDOWN_LINK)) {
    push(match[2], match[1]);
    rest = rest.replace(match[0], " ");
  }
  for (const match of rest.matchAll(BARE_URL)) push(match[0]);

  const description = rest
    .replace(BARE_URL, " ")
    .replace(/[\s—–|·]+/g, " ")
    .replace(/^[-:,;.]+|[-:,;]+$/g, "")
    .trim();
  if (description) for (const source of sources) source.description = description;
  return sources;
}

export function parseFootnoteEntries(markdown: string): CitationEntries {
  const entries: CitationEntries = new Map();
  for (const match of markdown.matchAll(FOOTNOTE_DEFINITION)) {
    const sources = parseDefinitionBody(match[2]);
    if (sources.length > 0) entries.set(match[1].toLowerCase(), sources);
  }
  return entries;
}

function harvestSourceDetails(
  value: unknown,
  into: Map<string, { title?: string; description?: string }>,
  depth = 0,
): void {
  if (depth > 6 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) harvestSourceDetails(item, into, depth + 1);
    return;
  }
  const row = value as Record<string, unknown>;
  const url = asString(row.url);
  if (url?.startsWith("http")) {
    const previous = into.get(url);
    into.set(url, {
      title: previous?.title ?? asString(row.title),
      description:
        previous?.description ??
        asString(row.snippet) ??
        asString(row.summary) ??
        asString(row.description),
    });
  }
  for (const child of Object.values(row)) harvestSourceDetails(child, into, depth + 1);
}

export function buildCitationEntries(parts: UIMessage["parts"]): CitationEntries {
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const entries = parseFootnoteEntries(text);
  for (const part of parts) {
    const libraryPart = part as unknown as LibrarySourcePart;
    if (libraryPart.type !== "data-library-sources" || !Array.isArray(libraryPart.data)) continue;
    for (const source of libraryPart.data) {
      if (!source.id || !isUsableUrl(source.url)) continue;
      entries.set(source.id.toLowerCase(), [
        {
          url: source.url,
          title: source.filename || hostnameOf(source.url),
          description: source.snippet,
        },
      ]);
    }
  }
  if (entries.size === 0) return entries;

  const details = new Map<string, { title?: string; description?: string }>();
  harvestSourceDetails(parts, details);
  for (const sources of entries.values()) {
    for (const source of sources) {
      const detail = details.get(source.url);
      if (!detail) continue;
      source.description ??= detail.description;
      if (detail.title && source.title === hostnameOf(source.url)) source.title = detail.title;
    }
  }
  return entries;
}

export function withResolvedFootnotes(text: string, entries: CitationEntries): string {
  const referenced = new Set(
    [...text.matchAll(FOOTNOTE_REFERENCE)].map((match) => match[1].toLowerCase()),
  );
  if (referenced.size === 0) return text;
  const defined = new Set(
    [...text.matchAll(FOOTNOTE_DEFINITION)].map((match) => match[1].toLowerCase()),
  );
  const missing = [...referenced].filter((id) => !defined.has(id));
  if (missing.length === 0) return text;
  const lines = missing.map((id) => {
    const sources = entries.get(id);
    return sources?.length
      ? `[^${id}]: ${sources.map((source) => `[${source.title}](${source.url})`).join(" ")}`
      : `[^${id}]: …`;
  });
  return `${text.trimEnd()}\n\n${lines.join("\n")}\n`;
}

function findFootnoteIds(node: unknown): string[] {
  const ids: string[] = [];
  for (const child of (node as HastElement | undefined)?.children ?? []) {
    const href = child.properties?.href;
    if (typeof href !== "string") continue;
    const match = /fn-(.+)$/.exec(href);
    if (match) ids.push(decodeURIComponent(match[1]).toLowerCase());
  }
  return ids;
}

const isFootnoteRef = (node: HastElement | undefined): boolean =>
  node?.tagName === "sup" && findFootnoteIds(node).length > 0;
const isBlankText = (node: HastElement | undefined): boolean =>
  node?.type === "text" && !node.value?.trim();

function mergeFootnoteRefRuns(children: HastElement[]): HastElement[] {
  const merged: HastElement[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const current = children[index];
    if (!isFootnoteRef(current)) {
      merged.push(current);
      continue;
    }
    const anchors = [...(current.children ?? [])];
    let cursor = index;
    while (cursor + 1 < children.length) {
      const next = isBlankText(children[cursor + 1]) ? cursor + 2 : cursor + 1;
      if (!isFootnoteRef(children[next])) break;
      anchors.push(...(children[next].children ?? []));
      cursor = next;
    }
    merged.push(cursor === index ? current : { ...current, children: anchors });
    index = cursor;
  }
  return merged;
}

function rehypeMergeFootnoteRefs() {
  return (tree: unknown) => {
    const walk = (node: HastElement) => {
      if (!node.children?.length) return;
      node.children = mergeFootnoteRefRuns(node.children);
      for (const child of node.children) walk(child);
    };
    walk(tree as HastElement);
  };
}

/**
 * 纯 Markdown 工具配置。通过工厂函数返回新数组,避免把可变插件数组作为
 * 组件模块导出,也避免 Fast Refresh 把它误判成组件导出。
 */
export function createCitationRehypePlugins(): NonNullable<StreamdownProps["rehypePlugins"]> {
  return [...Object.values(defaultRehypePlugins), rehypeMergeFootnoteRefs];
}
