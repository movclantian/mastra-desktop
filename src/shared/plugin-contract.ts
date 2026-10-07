import { z } from "zod";

export const pluginIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/);
const relativePath = z
  .string()
  .default("")
  .refine(
    (value) => !value.replaceAll("\\", "/").split("/").includes("..") && !/^[\\/]|:/.test(value),
    "A package path must remain inside its root",
  );
export const pluginSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), path: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("archive"),
      url: z.url({ protocol: /^https?$/ }),
      path: relativePath,
    })
    .strict(),
  z
    .object({
      kind: z.literal("git"),
      url: z.url({ protocol: /^https?$/ }),
      ref: z.string().min(1).default("HEAD"),
      path: relativePath,
      commit: z
        .string()
        .regex(/^[a-f0-9]{40,64}$/)
        .optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("skills-sh"), source: z.string().min(1), slug: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("upload"), filename: z.string().min(1) }).strict(),
]);
export type PluginSource = z.infer<typeof pluginSourceSchema>;

export const marketplaceSourceSchema = z
  .object({
    id: pluginIdSchema,
    name: z.string().trim().min(1).max(128),
    source: pluginSourceSchema,
    format: z.enum(["claude", "codex", "skills", "skills-sh"]),
    category: z.enum(["official", "community", "personal"]),
    catalogPath: relativePath,
    enabled: z.boolean(),
    builtin: z.boolean().default(false),
  })
  .strict();
export type MarketplaceSource = z.infer<typeof marketplaceSourceSchema>;

export interface MarketplaceListing {
  id: string;
  sourceId: string;
  key: string;
  name: string;
  description: string;
  version?: string;
  source: PluginSource;
  format?: "portable" | "claude" | "codex" | "skills";
  manifest?: Record<string, unknown>;
  strict?: boolean;
  category?: string;
  blockedReason?: string;
  homepage?: string;
  installs?: number;
}

export interface MarketplaceCatalog {
  source: MarketplaceSource;
  listings: MarketplaceListing[];
  fetchedAt?: string;
  checkedAt?: string;
  error?: string;
  etag?: string;
  lastModified?: string;
  page?: number;
  total?: number;
  hasMore?: boolean;
  refreshing?: boolean;
}

export const marketplaceQuerySchema = z.object({
  view: z.enum(["all-time", "trending", "hot"]).default("all-time"),
  page: z.coerce.number().int().min(0).max(10000).default(0),
  curated: z.enum(["0", "1"]).default("0"),
  owner: z.string().trim().max(180).default(""),
  query: z.string().trim().max(300).default(""),
});
export type MarketplaceQuery = z.infer<typeof marketplaceQuerySchema>;

export interface PluginMcpDefinition {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface PluginComponent {
  id: string;
  key: string;
  kind: "skill" | "mcp" | "commands" | "agents" | "hooks" | "lsp" | "apps";
  name: string;
  description: string;
  path?: string;
  runtimeName?: string;
  supported: boolean;
  issues: string[];
  mcp?: PluginMcpDefinition;
  configurationKeys?: string[];
}

export interface PluginVersion {
  digest: string;
  revision?: string;
  version?: string;
  name: string;
  description: string;
  format: "portable" | "claude" | "codex" | "skills";
  author?: string;
  license?: string;
  homepage?: string;
  components: PluginComponent[];
  issues: string[];
  installedAt: string;
}

export interface InstalledPlugin {
  id: string;
  source: PluginSource;
  listing?: MarketplaceListing;
  enabled: boolean;
  componentEnabled: Record<string, boolean>;
  current: PluginVersion;
  previous?: PluginVersion;
  update?: {
    checkedAt: string;
    digest?: string;
    version?: string;
    available: boolean;
    error?: string;
    changes?: PluginChange[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface PluginChange {
  kind: "added" | "removed" | "connection" | "configuration" | "support";
  componentId: string;
  name: string;
  keys?: string[];
}

export interface PluginSkill {
  id: string;
  pluginId: string;
  name: string;
  displayName: string;
  description: string;
  path: string;
  enabled: boolean;
}
