import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type MarketplaceCatalog,
  type MarketplaceListing,
  type MarketplaceQuery,
  type MarketplaceSource,
  marketplaceQuerySchema,
  marketplaceSourceSchema,
  type PluginSource,
  pluginSourceSchema,
} from "../../shared/plugin-contract";
import { listSkillsShSkillsWithOptions } from "../skills/marketplaces";
import { getAppConfig, setAppConfig } from "../storage/database";
import { directoryFiles, packagePath, pluginHash, withinRoot } from "./packages";
import { withPluginOperation } from "./registry";

const github = (repository: string): PluginSource => ({
  kind: "git",
  url: `https://github.com/${repository}`,
  ref: "main",
  path: "",
});
export const DEFAULT_PLUGIN_MARKETPLACES: MarketplaceSource[] = [
  {
    id: "anthropic-official",
    name: "Claude Plugins Official",
    source: github("anthropics/claude-plugins-official"),
    format: "claude",
    catalogPath: ".claude-plugin/marketplace.json",
    category: "official",
    enabled: true,
    builtin: true,
  },
  {
    id: "openai-curated",
    name: "OpenAI Plugins",
    source: github("openai/plugins"),
    format: "codex",
    catalogPath: ".agents/plugins/marketplace.json",
    category: "official",
    enabled: true,
    builtin: true,
  },
  {
    id: "anthropic-skills",
    name: "Anthropic Skills",
    source: github("anthropics/skills"),
    format: "claude",
    catalogPath: ".claude-plugin/marketplace.json",
    category: "official",
    enabled: true,
    builtin: true,
  },
  {
    id: "claude-community",
    name: "Claude Plugins Community",
    source: github("anthropics/claude-plugins-community"),
    format: "claude",
    catalogPath: ".claude-plugin/marketplace.json",
    category: "community",
    enabled: true,
    builtin: true,
  },
  {
    id: "skills-sh",
    name: "skills.sh",
    source: { kind: "archive", url: "https://skills.sh", path: "" },
    format: "skills-sh",
    catalogPath: "",
    category: "community",
    enabled: true,
    builtin: true,
  },
];
const SOURCES_KEY = "plugin-marketplaces";
const CACHE_TTL = 24 * 60 * 60 * 1_000;
const record = z.record(z.string(), z.unknown());
const catalogSchema = z.object({ plugins: z.array(record).max(5_000) });

export async function getPluginMarketplaces(owner: string): Promise<MarketplaceSource[]> {
  const raw = await getAppConfig(SOURCES_KEY, owner);
  if (!raw) return DEFAULT_PLUGIN_MARKETPLACES.map((source) => ({ ...source }));
  const saved = z.array(marketplaceSourceSchema).parse(JSON.parse(raw));
  return [
    ...saved,
    ...DEFAULT_PLUGIN_MARKETPLACES.filter((source) => !saved.some((item) => item.id === source.id)),
  ];
}

export async function savePluginMarketplace(
  input: MarketplaceSource,
  owner: string,
): Promise<MarketplaceSource> {
  return withPluginOperation(owner, "marketplace-sources", async () => {
    const source = marketplaceSourceSchema.parse(input);
    if (source.source.kind === "upload" || source.source.kind === "skills-sh")
      throw new Error("Invalid marketplace source");
    if (source.format !== "skills-sh" && source.format !== "skills")
      packagePath(source.catalogPath);
    if (source.format === "skills" && source.catalogPath) packagePath(source.catalogPath);
    const current = await getPluginMarketplaces(owner);
    const builtin = DEFAULT_PLUGIN_MARKETPLACES.find((item) => item.id === source.id);
    source.builtin = !!builtin;
    await setAppConfig(
      SOURCES_KEY,
      JSON.stringify([...current.filter((item) => item.id !== source.id), source]),
      owner,
    );
    return source;
  });
}

export async function removePluginMarketplace(id: string, owner: string): Promise<void> {
  await withPluginOperation(owner, "marketplace-sources", async () => {
    const sources = await getPluginMarketplaces(owner);
    const source = sources.find((item) => item.id === id);
    if (!source) throw new Error("Marketplace not found");
    if (source.builtin) source.enabled = false;
    await setAppConfig(
      SOURCES_KEY,
      JSON.stringify(source.builtin ? sources : sources.filter((item) => item.id !== id)),
      owner,
    );
  });
}

function relativeSource(base: PluginSource, path: string): PluginSource {
  const relative = path === "." || path === "./" ? "" : packagePath(path);
  if (base.kind === "local") return { kind: "local", path: withinRoot(base.path, relative) };
  if (
    base.kind === "git" ||
    (base.kind === "archive" && /\.zip$/i.test(new URL(base.url).pathname))
  )
    return { ...base, path: [base.path, relative].filter(Boolean).join("/") };
  throw new Error("This marketplace does not support relative package sources");
}

function skillDirectoryListings(paths: string[], source: MarketplaceSource): MarketplaceListing[] {
  const prefix = [source.source.kind === "git" ? source.source.path : "", source.catalogPath]
    .filter(Boolean)
    .join("/");
  return paths
    .filter(
      (path) =>
        (path === "SKILL.md" || path.endsWith("/SKILL.md")) &&
        (!prefix || path.startsWith(`${prefix}/`)),
    )
    .map((path) => {
      const directory = path === "SKILL.md" ? "" : path.slice(0, -"/SKILL.md".length);
      const base = source.source.kind === "git" ? { ...source.source, path: "" } : source.source;
      return {
        id: `listing_${pluginHash(`${source.id}\0${path}`).slice(0, 32)}`,
        sourceId: source.id,
        key: path,
        name: directory.split("/").at(-1) || source.name,
        description: "",
        source: relativeSource(base, directory || "."),
        format: "skills",
      };
    });
}

function entrySource(input: unknown, marketplace: MarketplaceSource): PluginSource {
  if (typeof input === "string") return relativeSource(marketplace.source, input);
  const source = record.parse(input);
  const type = z.string().parse(source.source);
  if (type === "local") return relativeSource(marketplace.source, z.string().parse(source.path));
  if (type === "archive")
    return pluginSourceSchema.parse({ kind: "archive", url: source.url, path: source.path ?? "" });
  if (["github", "git", "git-subdir", "url"].includes(type)) {
    const repository = z
      .string()
      .trim()
      .min(1)
      .parse(type === "github" ? source.repo : source.url);
    // Claude's git-subdir URL accepts the documented owner/repo GitHub shorthand.
    const url =
      type === "github"
        ? `https://github.com/${repository}`
        : type === "git-subdir" && /^[\w.-]+\/[\w.-]+$/.test(repository)
          ? `https://github.com/${repository}`
          : repository;
    if (!z.url({ protocol: /^https?$/ }).safeParse(url).success)
      throw new Error(
        "Plugin source URL must use HTTP(S); git-subdir also accepts a GitHub owner/repo. SSH and local Git URLs are not supported.",
      );
    return pluginSourceSchema.parse({
      kind: "git",
      url,
      path: source.path ?? "",
      ref: source.ref ?? "HEAD",
      commit: source.sha,
    });
  }
  throw new Error(`Unsupported plugin source: ${type}`);
}

export function parseMarketplace(
  document: unknown,
  marketplace: MarketplaceSource,
): MarketplaceListing[] {
  const catalog = catalogSchema.parse(document);
  const seen = new Set<string>();
  return catalog.plugins.map((entry) => {
    const key = z.string().min(1).max(128).parse(entry.name);
    if (seen.has(key)) throw new Error(`Duplicate marketplace entry: ${key}`);
    seen.add(key);
    let source = marketplace.source;
    let blockedReason: string | undefined;
    try {
      source = entrySource(entry.source, marketplace);
    } catch (error) {
      blockedReason =
        error instanceof z.ZodError
          ? z.prettifyError(error)
          : error instanceof Error
            ? error.message
            : "Invalid plugin source";
    }
    if (marketplace.format === "codex" && entry.policy !== undefined) {
      const policy = record.parse(entry.policy);
      if (policy.installation && policy.installation !== "AVAILABLE")
        blockedReason ??= `Unsupported required installation policy: ${String(policy.installation)}`;
      if (policy.authentication === "ON_INSTALL")
        blockedReason ??=
          "This plugin requires authorization during installation (ON_INSTALL). This desktop app does not implement the Codex host authorization flow. Install and authorize it in Codex.";
      else if (policy.authentication && policy.authentication !== "ON_USE")
        blockedReason ??= `Unsupported authentication policy: ${String(policy.authentication)}`;
    }
    const presentation =
      entry.interface && typeof entry.interface === "object" ? record.parse(entry.interface) : {};
    return {
      id: `listing_${pluginHash(`${marketplace.id}\0${key}`).slice(0, 32)}`,
      sourceId: marketplace.id,
      key,
      name:
        typeof presentation.displayName === "string"
          ? presentation.displayName
          : typeof entry.displayName === "string"
            ? entry.displayName
            : key,
      description: typeof entry.description === "string" ? entry.description : "",
      version: typeof entry.version === "string" ? entry.version : undefined,
      source,
      format: marketplace.format === "codex" ? "codex" : "claude",
      manifest: marketplace.format === "claude" ? entry : undefined,
      strict: entry.strict !== false,
      category: typeof entry.category === "string" ? entry.category : undefined,
      homepage: typeof entry.homepage === "string" ? entry.homepage : undefined,
      blockedReason,
    };
  });
}

function sourceCacheKey(source: MarketplaceSource): string {
  // Parsed catalog entries depend on the source normalization rules above.
  return `plugin-catalog:v2:${source.id}:${pluginHash(JSON.stringify([source.source, source.format, source.catalogPath]))}`;
}

function catalogCacheKey(source: MarketplaceSource, query: Partial<MarketplaceQuery> = {}) {
  return source.format === "skills-sh"
    ? `${sourceCacheKey(source)}:${pluginHash(JSON.stringify(marketplaceQuerySchema.parse(query)))}`
    : sourceCacheKey(source);
}

async function cachedCatalog(
  source: MarketplaceSource,
  owner: string,
  query: Partial<MarketplaceQuery> = {},
): Promise<MarketplaceCatalog | undefined> {
  const raw = await getAppConfig(catalogCacheKey(source, query), owner);
  return raw ? { ...(JSON.parse(raw) as MarketplaceCatalog), source } : undefined;
}

export async function getMarketplaceStatuses(sources: MarketplaceSource[], owner: string) {
  return Promise.all(
    sources.map(async (source) => {
      const cached = await cachedCatalog(source, owner);
      return {
        sourceId: source.id,
        fetchedAt: cached?.fetchedAt,
        checkedAt: cached?.checkedAt,
        error: cached?.error,
      };
    }),
  );
}

const refreshing = new Map<string, Promise<MarketplaceCatalog>>();
export async function refreshPluginCatalog(
  source: MarketplaceSource,
  owner: string,
  query: Partial<MarketplaceQuery> = {},
): Promise<MarketplaceCatalog> {
  const key = `${owner}\0${catalogCacheKey(source, query)}`;
  const pending = refreshing.get(key);
  if (pending) return pending;
  const refresh = (async () => {
    const cached = await cachedCatalog(source, owner, query);
    let next: MarketplaceCatalog = {
      source,
      listings: cached?.listings ?? [],
      fetchedAt: cached?.fetchedAt,
      checkedAt: new Date().toISOString(),
    };
    try {
      if (source.format === "skills-sh") {
        const options = marketplaceQuerySchema.parse(query);
        const result = await listSkillsShSkillsWithOptions({
          ...options,
          curated: options.curated === "1",
          owner: options.owner || undefined,
          perPage: 50,
          force: true,
        });
        next.page = result.page;
        next.total = result.total;
        next.hasMore = result.hasMore;
        next.listings = result.skills.map((skill) => ({
          id: `listing_${pluginHash(`${source.id}\0${skill.source}/${skill.slug}`).slice(0, 32)}`,
          sourceId: source.id,
          key: `${skill.source}/${skill.slug}`,
          name: skill.name,
          description: skill.description ?? "",
          source: { kind: "skills-sh", source: skill.source, slug: skill.slug },
          format: "skills",
          homepage: skill.url,
          installs: skill.installs,
        }));
      } else if (source.source.kind === "local") {
        if (source.format === "skills") {
          next.listings = skillDirectoryListings(
            [...(await directoryFiles(source.source.path)).keys()],
            source,
          );
        } else {
          const contents = await readFile(
            withinRoot(source.source.path, packagePath(source.catalogPath)),
            "utf8",
          );
          if (Buffer.byteLength(contents) > 5 * 1024 * 1024)
            throw new Error("Marketplace catalog exceeds 5 MB");
          next.listings = parseMarketplace(JSON.parse(contents), source);
        }
      } else {
        let url: string;
        if (source.source.kind === "git") {
          const repository = new URL(source.source.url);
          if (repository.hostname !== "github.com")
            throw new Error("Use a direct catalog URL for non-GitHub markets");
          const repo = repository.pathname.replace(/\.git\/?$/, "").replace(/^\/|\/$/g, "");
          url =
            source.format === "skills"
              ? `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(source.source.commit ?? source.source.ref)}?recursive=1`
              : `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(source.source.commit ?? source.source.ref)}/${[source.source.path, source.catalogPath].filter(Boolean).join("/").split("/").map(encodeURIComponent).join("/")}`;
        } else if (source.source.kind === "archive") url = source.source.url;
        else throw new Error("Unsupported marketplace transport");
        const response = await fetch(url, {
          headers: {
            ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
            ...(cached?.lastModified ? { "If-Modified-Since": cached.lastModified } : {}),
          },
          signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 304 && cached)
          next = { ...cached, source, checkedAt: next.checkedAt, error: undefined };
        else {
          if (!response.ok || !response.body)
            throw new Error(`Marketplace refresh failed (HTTP ${response.status})`);
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > 5 * 1024 * 1024) throw new Error("Marketplace catalog exceeds 5 MB");
            chunks.push(chunk);
          }
          const document = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (source.format === "skills") {
            if (source.source.kind !== "git")
              throw new Error(
                "Skill directory sources require a GitHub repository or local directory",
              );
            const tree = z
              .object({
                truncated: z.boolean(),
                tree: z.array(z.object({ path: z.string(), type: z.string(), mode: z.string() })),
              })
              .parse(document);
            if (tree.truncated)
              throw new Error(
                "GitHub returned an incomplete skill directory; select a smaller repository",
              );
            next.listings = skillDirectoryListings(
              tree.tree
                .filter((entry) => entry.type === "blob" && entry.mode !== "120000")
                .map((entry) => entry.path),
              source,
            );
          } else next.listings = parseMarketplace(document, source);
          next.etag = response.headers.get("etag") ?? undefined;
          next.lastModified = response.headers.get("last-modified") ?? undefined;
        }
      }
      next.fetchedAt = next.checkedAt;
    } catch (error) {
      next = {
        ...cached,
        ...next,
        error: error instanceof Error ? error.message : "Marketplace unavailable",
      };
    }
    await setAppConfig(catalogCacheKey(source, query), JSON.stringify(next), owner);
    return next;
  })();
  refreshing.set(key, refresh);
  try {
    return await refresh;
  } finally {
    refreshing.delete(key);
  }
}

export async function getPluginCatalog(
  sourceId: string,
  owner: string,
  refresh = false,
  query: Partial<MarketplaceQuery> = {},
): Promise<MarketplaceCatalog> {
  const source = (await getPluginMarketplaces(owner)).find((item) => item.id === sourceId);
  if (!source) throw new Error("Marketplace not found");
  if (!source.enabled) return { source, listings: [] };
  const cached = await cachedCatalog(source, owner, query);
  if (refresh || !cached) return refreshPluginCatalog(source, owner, query);
  if (!cached.checkedAt || Date.now() - Date.parse(cached.checkedAt) > CACHE_TTL) {
    void refreshPluginCatalog(source, owner, query).catch(() => undefined);
    return { ...cached, refreshing: true };
  }
  return { ...cached, refreshing: refreshing.has(`${owner}\0${catalogCacheKey(source, query)}`) };
}

export async function getMarketplaceListing(
  sourceId: string,
  key: string,
  owner: string,
  refresh = false,
): Promise<MarketplaceListing> {
  const catalog = await getPluginCatalog(sourceId, owner, refresh);
  if (refresh && catalog.error) throw new Error(catalog.error);
  const listing = catalog.listings.find((item) => item.key === key);
  if (!listing && catalog.source.enabled && catalog.source.format === "skills-sh") {
    const match =
      /^([a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/.exec(
        key,
      );
    if (!match) throw new Error("Invalid skills.sh listing identity");
    return {
      id: `listing_${pluginHash(`${sourceId}\0${key}`).slice(0, 32)}`,
      sourceId,
      key,
      name: match[2],
      description: "",
      source: { kind: "skills-sh", source: match[1], slug: match[2] },
      format: "skills",
      homepage: `https://skills.sh/${key}`,
    };
  }
  if (!listing) throw new Error(catalog.error ?? "Marketplace entry not found");
  return listing;
}
