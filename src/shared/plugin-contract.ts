import { z } from "zod";
import { type CredentialPointer, CredentialPointerSchema } from "./credential-contract";

export const pluginConfigValueSchema = z.union([
  z.string().max(65536),
  z.number(),
  z.boolean(),
  z.array(z.string()).max(256),
]);
export type PluginConfigValue = z.infer<typeof pluginConfigValueSchema>;
export const pluginConfigFieldSchema = z
  .object({
    type: z.enum(["string", "number", "boolean", "directory", "file"]),
    title: z.string().min(1),
    description: z.string(),
    required: z.boolean().optional(),
    default: pluginConfigValueSchema.optional(),
    options: z.array(z.string().min(1).max(64)).min(1).optional(),
    multiple: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict()
  .superRefine((field, context) => {
    if (
      (field.multiple && field.type !== "string") ||
      ((field.min !== undefined || field.max !== undefined) && field.type !== "number") ||
      (field.min !== undefined && field.max !== undefined && field.min > field.max) ||
      (field.options &&
        (field.type !== "string" ||
          field.multiple ||
          field.sensitive ||
          new Set(field.options).size !== field.options.length ||
          (!field.required && field.default === undefined)))
    )
      context.addIssue({ code: "custom", message: "Invalid userConfig field constraints" });
    if (field.default !== undefined && pluginConfigValueError(field, field.default))
      context.addIssue({ code: "custom", message: "Invalid userConfig default" });
  });
export type PluginConfigField = z.infer<typeof pluginConfigFieldSchema>;
export const pluginUserConfigSchema = z.record(
  z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
    .refine(
      (key) => !["__proto__", "constructor", "prototype"].includes(key),
      "Reserved configuration key",
    ),
  pluginConfigFieldSchema,
);

/** Never include a rejected value in diagnostics: it may be a secret. */
export function pluginConfigValueError(
  field: PluginConfigField,
  value: unknown,
): string | undefined {
  if (value === undefined || value === "" || (Array.isArray(value) && !value.length))
    return field.required ? "required" : undefined;
  if (field.multiple)
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? undefined
      : "string array";
  const type = field.type === "directory" || field.type === "file" ? "string" : field.type;
  if (typeof value !== type) return type;
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      (field.min !== undefined && value < field.min) ||
      (field.max !== undefined && value > field.max))
  )
    return "bounds";
  if (field.options && !field.options.includes(String(value))) return "options";
  return undefined;
}

export interface PluginConfiguration {
  revision: string;
  values: Record<string, PluginConfigValue>;
  secretCredential?: CredentialPointer;
  secretKeys: string[];
}
export const pluginConfigurationPatchSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.string(),
    values: z.record(z.string(), pluginConfigValueSchema.nullable()),
    secretPatch: CredentialPointerSchema.optional(),
  })
  .strict();

export const pluginIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/);
const sourceUrl = z.url({ protocol: /^https?$/ }).refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password;
}, "Use the credential manager instead of embedding credentials in source URLs");
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
      url: sourceUrl,
      path: relativePath,
    })
    .strict(),
  z
    .object({
      kind: z.literal("git"),
      url: sourceUrl,
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
  marketplaceName?: string;
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
  kind: "skill" | "mcp" | "commands" | "agents" | "hooks" | "lsp" | "apps" | "extension";
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
  usageExamples?: string[];
  readmePath?: string;
  defaultEnabled?: boolean;
  components: PluginComponent[];
  dependencies?: Array<{ name: string; marketplace?: string; version?: string }>;
  userConfig?: Record<string, PluginConfigField>;
  blockedReasons?: string[];
  issues: string[];
  installedAt: string;
}

export interface InstalledPlugin {
  id: string;
  source: PluginSource;
  listing?: MarketplaceListing;
  enabled: boolean;
  componentEnabled: Record<string, boolean>;
  configuration?: PluginConfiguration;
  pendingConfiguration?: { digest: string; configuration: PluginConfiguration };
  /** Derived from the current installed graph and configuration; never persisted. */
  dependencyErrors?: string[];
  configurationErrors?: string[];
  current: PluginVersion;
  previous?: PluginVersion;
  update?: {
    checkedAt: string;
    digest?: string;
    version?: string;
    available: boolean;
    error?: string;
    changes?: PluginChange[];
    preview?: PluginVersion;
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
