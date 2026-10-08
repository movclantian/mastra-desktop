import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { validateSkillContent } from "@mastra/core/skills";
import AdmZip from "adm-zip";
import matter from "gray-matter";
import { validRange } from "semver";
import { z } from "zod";
import {
  type MarketplaceListing,
  type PluginChange,
  type PluginComponent,
  type PluginMcpDefinition,
  type PluginVersion,
  pluginUserConfigSchema,
} from "../../shared/plugin-contract";

export const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 2_000;
export interface PackageFiles extends Map<string, Buffer> {
  executablePaths?: Set<string>;
  directories?: Set<string>;
}

export function packageDirectories(files: PackageFiles): Set<string> {
  const directories = new Set(files.directories);
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++)
      directories.add(parts.slice(0, count).join("/"));
  }
  const seen = new Set<string>();
  for (const path of [...directories, ...files.keys()]) {
    const key = packagePath(path).toLowerCase();
    if (seen.has(key)) throw new Error(`Conflicting package file or directory: ${path}`);
    seen.add(key);
  }
  return directories;
}
export const pluginHash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

export function packagePath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (
    !path ||
    path.length > 4096 ||
    path.startsWith("/") ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          [...part].some((character) => character.charCodeAt(0) < 32) ||
          /[<>:"|?*]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error(`Unsafe package path: ${value}`);
  return path;
}

export function withinRoot(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error("Package path escapes its root");
  return target;
}

function addFile(
  files: PackageFiles,
  name: string,
  contents: Buffer,
  seen: Set<string>,
  total: { bytes: number },
) {
  const path = packagePath(name);
  const key = path.toLowerCase();
  if (seen.has(key)) throw new Error(`Duplicate package path: ${path}`);
  seen.add(key);
  total.bytes += contents.byteLength;
  if (seen.size > MAX_FILES || total.bytes > MAX_UNPACKED_BYTES)
    throw new Error("Plugin package exceeds 2,000 files or 100 MB");
  if (
    /(^|\/)(SKILL\.md|plugin\.json|mcp\.json|\.mcp\.json)$/i.test(path) &&
    contents.byteLength > 1024 * 1024
  )
    throw new Error(`Metadata exceeds 1 MB: ${path}`);
  files.set(path, contents);
}

export function archiveFiles(buffer: Buffer): PackageFiles {
  if (buffer.byteLength > MAX_PACKAGE_BYTES) throw new Error("Plugin archive exceeds 25 MB");
  const entries = new AdmZip(buffer).getEntries();
  if (!entries.length || entries.length > MAX_FILES) throw new Error("Invalid archive entry count");
  if (entries.reduce((size, entry) => size + entry.header.size, 0) > MAX_UNPACKED_BYTES)
    throw new Error("Unpacked plugin exceeds 100 MB");
  const files: PackageFiles = new Map();
  const seen = new Set<string>();
  const total = { bytes: 0 };
  for (const entry of entries) {
    packagePath(entry.entryName);
    const mode = (entry.attr >>> 16) & 0o170000;
    if (mode && mode !== 0o100000 && mode !== 0o040000)
      throw new Error("Archive links and special files are not supported");
    if (entry.isDirectory) {
      const key = packagePath(entry.entryName).toLowerCase();
      if (seen.has(key)) throw new Error(`Duplicate package path: ${entry.entryName}`);
      seen.add(key);
      files.directories ??= new Set();
      files.directories.add(packagePath(entry.entryName));
    } else {
      addFile(files, entry.entryName, entry.getData(), seen, total);
      if ((entry.attr >>> 16) & 0o111) {
        files.executablePaths ??= new Set();
        files.executablePaths.add(packagePath(entry.entryName));
      }
    }
  }
  if (!files.size) throw new Error("Empty plugin package");
  return files;
}

export async function directoryFiles(directory: string): Promise<PackageFiles> {
  const root = await realpath(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error("Plugin source must be a directory");
  const files: PackageFiles = new Map();
  const seen = new Set<string>();
  const total = { bytes: 0 };
  let entries = 0;
  const visit = async (current: string, prefix: string, ancestors: Set<string>) => {
    const physical = await realpath(current);
    withinRoot(root, physical);
    if (ancestors.has(physical)) throw new Error("Circular directory link in package");
    const next = new Set([...ancestors, physical]);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (++entries > MAX_FILES) throw new Error("Plugin package exceeds 2,000 entries");
      const name = packagePath(`${prefix}${entry.name}`);
      const path = await realpath(resolve(current, entry.name));
      withinRoot(root, path);
      const info = await lstat(path);
      if (info.isDirectory()) {
        files.directories ??= new Set();
        files.directories.add(name);
        await visit(path, `${name}/`, next);
      } else if (info.isFile()) {
        if (info.size + total.bytes > MAX_UNPACKED_BYTES)
          throw new Error("Plugin package exceeds 100 MB");
        addFile(files, name, await readFile(path), seen, total);
        if (info.mode & 0o111) {
          files.executablePaths ??= new Set();
          files.executablePaths.add(name);
        }
      } else throw new Error(`Unsupported package file: ${name}`);
    }
  };
  await visit(root, "", new Set());
  if (!files.size) throw new Error("Empty plugin directory");
  return files;
}

export function selectPackageRoot(
  files: PackageFiles,
  subdirectory = "",
  unwrap = true,
): PackageFiles {
  if (subdirectory && subdirectory !== "." && subdirectory !== "./") {
    const prefix = `${packagePath(subdirectory)}/`;
    const selected: PackageFiles = new Map(
      [...files]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, value]) => [name.slice(prefix.length), value]),
    );
    if (!selected.size) throw new Error(`Package directory not found: ${subdirectory}`);
    selected.executablePaths = new Set(
      [...(files.executablePaths ?? [])]
        .filter((name) => name.startsWith(prefix))
        .map((name) => name.slice(prefix.length)),
    );
    selected.directories = new Set(
      [...packageDirectories(files)]
        .filter((name) => name.startsWith(prefix))
        .map((name) => name.slice(prefix.length)),
    );
    return selected;
  }
  if (!unwrap) return files;
  let result = files;
  while (
    !result.has("plugin.json") &&
    !result.has(".claude-plugin/plugin.json") &&
    !result.has(".codex-plugin/plugin.json") &&
    !result.has("SKILL.md")
  ) {
    const roots = new Set(
      [...result.keys(), ...packageDirectories(result)].map((path) => path.split("/")[0]),
    );
    const root = [...roots][0];
    if (
      roots.size !== 1 ||
      [...result.keys()].some((path) => !path.includes("/")) ||
      ["skills", ".claude-plugin", ".codex-plugin"].includes(root)
    )
      break;
    const executablePaths = new Set(
      [...(result.executablePaths ?? [])].map((name) => name.slice(root.length + 1)),
    );
    const directories = new Set(
      [...packageDirectories(result)]
        .filter((name) => name.startsWith(`${root}/`))
        .map((name) => name.slice(root.length + 1)),
    );
    result = new Map([...result].map(([path, value]) => [path.slice(root.length + 1), value]));
    result.executablePaths = executablePaths;
    result.directories = directories;
  }
  return result;
}

function packageDigest(files: PackageFiles): string {
  const hash = createHash("sha256");
  for (const path of [...packageDirectories(files)].sort()) hash.update(`directory:${path}\0`);
  for (const [path, contents] of [...files].sort(([a], [b]) => a.localeCompare(b, "en")))
    hash
      .update(`${path}\0${files.executablePaths?.has(path) ? "x" : "-"}\0${contents.length}\0`)
      .update(contents);
  return hash.digest("hex");
}

export function packageChanges(previous: PluginVersion, next: PluginVersion): PluginChange[] {
  const before = new Map(previous.components.map((component) => [component.id, component]));
  const after = new Set(next.components.map((component) => component.id));
  const changes: PluginChange[] = previous.components
    .filter((component) => !after.has(component.id))
    .map((component) => ({ kind: "removed", componentId: component.id, name: component.name }));
  if (
    JSON.stringify(previous.userConfig) !== JSON.stringify(next.userConfig) ||
    JSON.stringify(previous.dependencies) !== JSON.stringify(next.dependencies)
  )
    changes.push({
      kind: "configuration",
      componentId: "plugin",
      name: next.name,
      keys: [
        ...Object.keys(next.userConfig ?? {}),
        ...(next.dependencies ?? []).map((item) => `dependency:${item.name}`),
      ],
    });
  if (JSON.stringify(previous.blockedReasons) !== JSON.stringify(next.blockedReasons))
    changes.push({ kind: "support", componentId: "plugin", name: next.name });
  for (const component of next.components) {
    const old = before.get(component.id);
    const identity = { componentId: component.id, name: component.name };
    if (!old) changes.push({ kind: "added", ...identity });
    else {
      if (JSON.stringify(old.mcp) !== JSON.stringify(component.mcp))
        changes.push({ kind: "connection", ...identity });
      if (old.supported !== component.supported) changes.push({ kind: "support", ...identity });
    }
    const keys = component.configurationKeys?.filter(
      (key) => !old?.configurationKeys?.includes(key),
    );
    if (keys?.length) changes.push({ kind: "configuration", ...identity, keys });
  }
  return changes;
}

const objectSchema = z.record(z.string(), z.unknown());
const stringRecord = z.record(z.string(), z.string());
const portableManifest = z.object({
  $schema: z.literal("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
    .refine((name) => !name.includes("--") && !name.includes("..")),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z
    .object({
      name: z.string().optional(),
      email: z.string().optional(),
      url: z.string().optional(),
    })
    .strict()
    .optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  extensions: z.unknown().optional(),
});
const stdioSchema = z
  .object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: stringRecord.optional(),
    cwd: z.string().optional(),
  })
  .strict();
const httpSchema = z
  .object({
    type: z.enum(["streamable-http", "sse"]),
    url: z.url({ protocol: /^https?$/ }),
    headers: stringRecord.optional(),
  })
  .strict();

function readJson(files: PackageFiles, path: string): Record<string, unknown> {
  const content = files.get(path);
  if (!content) throw new Error(`Missing package file: ${path}`);
  return objectSchema.parse(JSON.parse(content.toString("utf8")));
}

function componentPaths(value: unknown, allowRoot = false): string[] {
  return value === undefined
    ? []
    : z
        .array(z.string())
        .parse(typeof value === "string" ? [value] : value)
        .map((value) => {
          if (allowRoot && (value === "." || value === "./")) return "";
          if (!value.startsWith("./"))
            throw new Error(`Component paths must start with ./: ${value}`);
          return packagePath(value);
        });
}

export function claudePackageManifest(files: PackageFiles, listing?: MarketplaceListing) {
  let manifest = files.has(".claude-plugin/plugin.json")
    ? readJson(files, ".claude-plugin/plugin.json")
    : undefined;
  if (listing?.format !== "claude") return manifest;
  const appended = ["skills", "commands", "agents", "hooks", "outputStyles", "themes"];
  if (
    listing.strict === false &&
    manifest &&
    appended.some((key) => listing.manifest?.[key] !== undefined)
  )
    throw new Error("Conflicting component declarations in a non-strict Claude entry");
  if (!manifest) return listing.manifest;
  manifest = { ...manifest };
  if (listing.strict !== false) {
    // Entry MCP, LSP, userConfig and channels do not override an existing package manifest.
    for (const key of appended) {
      const extra = listing.manifest?.[key];
      if (extra === undefined) continue;
      if (key === "skills")
        manifest.skills = [
          ...componentPaths(manifest.skills, true),
          ...componentPaths(extra, true),
        ].map((path) => (path ? `./${path}` : "."));
      else manifest[key] ??= extra;
    }
  }
  return manifest;
}

function parseMcp(input: unknown, portable: boolean): PluginMcpDefinition {
  const raw = objectSchema.parse(input);
  const type = raw.type ?? (raw.command ? "stdio" : "http");
  if (portable) {
    if (type === "stdio") {
      const value = stdioSchema.parse(raw);
      if (Object.keys(value.env ?? {}).some((key) => /^(PLUGIN_ROOT|PLUGIN_DATA)$/i.test(key)))
        throw new Error("Portable MCP cannot declare reserved plugin environment variables");
      if (
        value.command.includes("${") ||
        /\s/.test(value.command) ||
        (/[/\\:]/.test(value.command) && !value.command.startsWith("./"))
      )
        throw new Error("Invalid portable MCP executable");
      if (value.command.startsWith("./")) packagePath(value.command);
      if (value.cwd !== undefined) {
        if (!/^(\.\/|\$\{PLUGIN_(ROOT|DATA)\}(\/|$))/.test(value.cwd))
          throw new Error("Invalid portable MCP working directory");
        const suffix = value.cwd.replace(/^\$\{PLUGIN_(ROOT|DATA)\}\/?/, "");
        if (suffix && suffix !== "./") packagePath(suffix);
      }
      return { ...value, transport: "stdio" };
    }
    const value = httpSchema.parse(raw);
    if (value.type === "sse") throw new Error("Explicit legacy SSE transport is not supported");
    const url = new URL(value.url);
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol === "http:" && !/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(url.hostname))
    )
      throw new Error("Portable MCP requires HTTPS except on loopback hosts");
    const headers = Object.keys(value.headers ?? {}).map((key) => key.toLowerCase());
    if (new Set(headers).size !== headers.length) throw new Error("Duplicate HTTP header names");
    new Headers(value.headers);
    return { transport: "http", url: value.url, headers: value.headers };
  }
  const unsupported = Object.keys(raw).filter(
    (key) => !["type", "command", "args", "env", "cwd", "url", "headers"].includes(key),
  );
  if (unsupported.length) throw new Error(`Unsupported MCP settings: ${unsupported.join(", ")}`);
  if (type === "stdio")
    return {
      transport: "stdio",
      command: z.string().min(1).parse(raw.command),
      args: z.array(z.string()).optional().parse(raw.args),
      env: stringRecord.optional().parse(raw.env),
      cwd: z.string().optional().parse(raw.cwd),
    };
  if (type !== "http" && type !== "streamable-http")
    throw new Error(`Unsupported MCP transport: ${String(type)}`);
  const url = z.string().min(1).parse(raw.url);
  if (!/\$\{[^}]+\}/.test(url)) z.url({ protocol: /^https?$/ }).parse(url);
  return {
    transport: "http",
    url,
    headers: stringRecord.optional().parse(raw.headers),
  };
}

/** Parsing never writes files or starts tools; unsupported components remain visible. */
export function describePackage(
  files: PackageFiles,
  pluginId: string,
  listing?: MarketplaceListing,
): PluginVersion {
  const issues: string[] = [];
  const blockedReasons: string[] = [];
  const hasClaude = files.has(".claude-plugin/plugin.json");
  const hasCodex = files.has(".codex-plugin/plugin.json");
  if (
    !files.has("plugin.json") &&
    hasClaude &&
    hasCodex &&
    !["claude", "codex"].includes(listing?.format ?? "")
  )
    throw new Error(
      "Both Claude and Codex manifests exist; import through a marketplace that declares the package format",
    );
  const format = files.has("plugin.json")
    ? "portable"
    : hasCodex && listing?.format === "codex"
      ? "codex"
      : hasClaude
        ? "claude"
        : files.has(".codex-plugin/plugin.json")
          ? "codex"
          : (listing?.format ?? "skills");
  const manifestPath = format === "portable" ? "plugin.json" : `.${format}-plugin/plugin.json`;
  let manifest =
    format === "claude"
      ? claudePackageManifest(files, listing)
      : files.has(manifestPath)
        ? readJson(files, manifestPath)
        : undefined;
  if (format === "portable") {
    const parsed = portableManifest.parse(manifest);
    for (const key of Object.keys(manifest ?? {}))
      if (!(key in portableManifest.shape)) issues.push(`Ignored unknown manifest field: ${key}`);
    manifest = parsed;
    if (
      parsed.extensions !== undefined &&
      (!parsed.extensions ||
        typeof parsed.extensions !== "object" ||
        Array.isArray(parsed.extensions))
    )
      issues.push("Ignored non-object extensions field");
  }
  if (listing && manifest?.name && manifest.name !== listing.key && format === "claude")
    issues.push(
      "Marketplace entry and plugin manifest names differ; installation identity remains the marketplace entry",
    );
  if (format === "codex" && !manifest)
    throw new Error(
      "A Codex package requires .codex-plugin/plugin.json or a portable root plugin.json",
    );
  if ((format === "claude" || format === "codex") && manifest) {
    z.object({
      name: z.string().min(1),
      version: z.string().optional(),
      description: z.string().optional(),
      defaultEnabled: z.boolean().optional(),
      homepage: z.url().optional(),
      license: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      author: (format === "claude"
        ? z.object({ name: z.string(), email: z.string().optional(), url: z.string().optional() })
        : z.union([z.string(), z.object({ name: z.string().optional() })])
      ).optional(),
    }).parse(manifest);
    const known = new Set([
      "$schema",
      "name",
      "displayName",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "metadata",
      "icon",
      "documentationUrl",
      "supportUrl",
      "screenshots",
      "skills",
      "mcpServers",
      "commands",
      "agents",
      "hooks",
      "lspServers",
      "apps",
      "userConfig",
      "dependencies",
      "channels",
      "outputStyles",
      "themes",
      "experimental",
      "workflows",
      "rules",
      "interface",
      "defaultEnabled",
    ]);
    for (const key of Object.keys(manifest))
      if (!known.has(key) && !["source", "strict", "category", "tags"].includes(key))
        issues.push(`Ignored unknown manifest field: ${key}`);
    if (format === "codex" && manifest.userConfig !== undefined)
      blockedReasons.push("Codex userConfig semantics are not supported");
  }
  const userConfig =
    format === "claude" && manifest?.userConfig !== undefined
      ? pluginUserConfigSchema.parse(manifest.userConfig)
      : undefined;
  const dependencies =
    manifest?.dependencies === undefined
      ? undefined
      : z
          .array(
            z.union([
              z
                .string()
                .min(1)
                .transform((value) => {
                  const [name, marketplace, extra] = value.split("@");
                  if (!name || marketplace === "" || extra !== undefined)
                    throw new Error("Invalid plugin dependency identifier");
                  return { name, marketplace };
                }),
              z
                .object({
                  name: z.string().min(1),
                  marketplace: z.string().min(1).optional(),
                  version: z.string().min(1).optional(),
                })
                .strict(),
            ]),
          )
          .max(100)
          .parse(manifest.dependencies);
  for (const dependency of dependencies ?? [])
    if ("version" in dependency && dependency.version && !validRange(dependency.version))
      blockedReasons.push(`Unrecognized dependency version range: ${dependency.name}`);
  let rootSkillName: unknown;
  if (format === "skills" && files.has("SKILL.md")) {
    try {
      rootSkillName = matter(files.get("SKILL.md")?.toString("utf8") ?? "").data.name;
    } catch {
      /* The component parser reports invalid frontmatter below. */
    }
  }
  const name = z
    .string()
    .min(1)
    .max(128)
    .parse(manifest?.name ?? listing?.name ?? rootSkillName ?? "local-skills");
  const components: PluginComponent[] = [];
  const add = (
    kind: PluginComponent["kind"],
    key: string,
    input: Omit<PluginComponent, "id" | "kind" | "key">,
  ) => {
    if (components.some((component) => component.kind === kind && component.key === key)) return;
    components.push({
      id: `pc_${pluginHash(`${pluginId}\0${kind}\0${key}`).slice(0, 32)}`,
      kind,
      key,
      ...input,
    });
  };
  const skillRoots =
    format === "skills"
      ? []
      : [
          ...(!files.has(manifestPath) &&
          manifest?.skills !== undefined &&
          (listing?.manifest?.source === "." || listing?.manifest?.source === "./")
            ? []
            : ["skills"]),
          ...(format === "portable" ? [] : componentPaths(manifest?.skills, true)),
        ];
  const directories = packageDirectories(files);
  if (format !== "portable") {
    for (const path of componentPaths(manifest?.skills, true))
      if (path && !directories.has(path)) throw new Error(`Skill directory not found: ${path}`);
    for (const path of typeof manifest?.mcpServers === "string" ||
    Array.isArray(manifest?.mcpServers)
      ? componentPaths(manifest.mcpServers)
      : [])
      if (!files.has(path)) throw new Error(`MCP configuration file not found: ${path}`);
  }
  if (files.has("skills") && format !== "skills")
    add("skill", "skills", {
      name: "skills",
      description: "",
      supported: false,
      issues: ["The skills component location must be a directory"],
    });
  if (directories.has(format === "portable" ? "mcp.json" : ".mcp.json"))
    add("mcp", "mcp.json", {
      name: "mcp.json",
      description: "",
      supported: false,
      issues: ["The MCP component location must be a file"],
    });
  const skillFiles = [...files.keys()].filter(
    (path) =>
      basename(path) === "SKILL.md" &&
      (format === "skills" ||
        skillRoots.some(
          (root) =>
            (format !== "portable" && path === (root ? `${root}/SKILL.md` : "SKILL.md")) ||
            (path.startsWith(root ? `${root}/` : "") &&
              path.slice(root ? root.length + 1 : 0).split("/").length === 2),
        )),
  );
  for (const path of skillFiles) {
    const content = files.get(path)?.toString("utf8");
    if (content === undefined) continue;
    const parent = path === "SKILL.md" ? undefined : path.split("/").at(-2);
    const result = validateSkillContent({ content, directoryName: parent });
    let parsed: ReturnType<typeof matter>;
    try {
      parsed = matter(content);
    } catch (error) {
      add("skill", path, {
        name: parent ?? "skill",
        description: "",
        path,
        supported: false,
        issues: [error instanceof Error ? error.message : "Invalid SKILL.md"],
      });
      continue;
    }
    const skillName = typeof parsed.data.name === "string" ? parsed.data.name : (parent ?? "skill");
    const skillIssues = [...result.errors];
    if (format === "claude") {
      for (const match of content.matchAll(/\$\{user_config\.([^}]+)\}/g))
        if (!userConfig?.[match[1]]) skillIssues.push(`Undeclared userConfig option: ${match[1]}`);
      if (/\$\{CLAUDE_PROJECT_DIR\}/.test(content))
        skillIssues.push("Project-specific skill variables are not supported");
      if (/!`[^`]+`/.test(parsed.content))
        skillIssues.push("Skill shell preprocessing is not supported");
    }
    const identity = pluginHash(`${pluginId}\0skill\0${path}`).slice(0, 20);
    add("skill", path, {
      name: skillName,
      description: typeof parsed.data.description === "string" ? parsed.data.description : "",
      path,
      runtimeName: `skill-${identity}`,
      supported: result.valid && !skillIssues.length,
      issues: skillIssues,
    });
  }
  const mcpPaths =
    format === "portable"
      ? ["mcp.json"]
      : [
          ".mcp.json",
          ...(typeof manifest?.mcpServers === "string" || Array.isArray(manifest?.mcpServers)
            ? componentPaths(manifest.mcpServers)
            : []),
        ];
  const mcpDocuments: [string, unknown][] = [];
  for (const path of new Set(mcpPaths)) {
    if (!files.has(path)) continue;
    try {
      const document = readJson(files, path);
      if (format === "portable")
        z.object({
          $schema: z.literal("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"),
          mcpServers: objectSchema,
        })
          .strict()
          .parse(document);
      mcpDocuments.push([path, document.mcpServers ?? document]);
    } catch (error) {
      add("mcp", path, {
        name: path,
        description: "",
        supported: false,
        issues: [error instanceof Error ? error.message : "Invalid MCP file"],
      });
    }
  }
  if (
    format !== "portable" &&
    manifest?.mcpServers &&
    typeof manifest.mcpServers === "object" &&
    !Array.isArray(manifest.mcpServers)
  )
    mcpDocuments.push(["manifest", manifest.mcpServers]);
  const mcpServers = new Map<string, { path: string; value: unknown }>();
  for (const [path, input] of mcpDocuments)
    for (const [serverName, value] of Object.entries(objectSchema.parse(input)))
      mcpServers.set(serverName, { path, value });
  for (const [serverName, { path, value }] of mcpServers) {
    try {
      const mcp = parseMcp(value, format === "portable");
      const serialized = JSON.stringify(mcp);
      if (format === "claude") {
        for (const match of serialized.matchAll(/\$\{user_config\.([^}]+)\}/g))
          if (!userConfig?.[match[1]]) throw new Error(`Undeclared userConfig option: ${match[1]}`);
        if (/\$\{CLAUDE_PROJECT_DIR\}/.test(serialized))
          throw new Error("Project-specific MCP variables are not supported");
      }
      if (mcp.command?.startsWith("./") && !files.has(packagePath(mcp.command)))
        throw new Error(`Missing bundled MCP executable: ${mcp.command}`);
      add("mcp", serverName, {
        name: serverName,
        description: "",
        supported: true,
        issues: [],
        mcp,
        configurationKeys:
          format === "portable"
            ? []
            : [
                ...new Set(
                  [
                    mcp.command,
                    ...(mcp.args ?? []),
                    mcp.cwd,
                    mcp.url,
                    ...Object.values(mcp.env ?? {}),
                    ...Object.values(mcp.headers ?? {}),
                  ]
                    .flatMap((value) =>
                      [...(value ?? "").matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]),
                    )
                    .filter(
                      (key) =>
                        ![
                          "PLUGIN_ROOT",
                          "PLUGIN_DATA",
                          "CLAUDE_PLUGIN_ROOT",
                          "CLAUDE_PLUGIN_DATA",
                        ].includes(key) &&
                        !key.includes(":-") &&
                        !key.startsWith("user_config."),
                    ),
                ),
              ],
      });
    } catch (error) {
      add("mcp", `${path}:${serverName}`, {
        name: serverName,
        description: "",
        supported: false,
        issues: [error instanceof Error ? error.message : "Invalid MCP server"],
      });
    }
  }
  const extensions = manifest?.extensions;
  const openai =
    extensions && typeof extensions === "object" && !Array.isArray(extensions)
      ? (extensions as Record<string, unknown>)["com.openai"]
      : undefined;
  const overlay =
    openai && typeof openai === "object" && !Array.isArray(openai)
      ? (openai as Record<string, unknown>)
      : (format === "portable" || format === "codex") && files.has(".codex-plugin/plugin.json")
        ? readJson(files, ".codex-plugin/plugin.json")
        : {};
  for (const key of ["channels", "outputStyles", "themes", "experimental", "workflows", "rules"]) {
    if (manifest?.[key] !== undefined || overlay[key] !== undefined || directories.has(key))
      add("extension", key, {
        name: key,
        description: "",
        supported: false,
        issues: [`${key} execution is not supported`],
      });
  }
  if (format === "portable") {
    for (const key of ["skills", "mcpServers", "dependencies", "userConfig"])
      if (overlay[key] !== undefined)
        issues.push(`Ignored client overlay field ${key}; portable components use fixed locations`);
    if (extensions && typeof extensions === "object" && !Array.isArray(extensions))
      for (const namespace of Object.keys(extensions))
        if (namespace !== "com.openai") issues.push(`Ignored client extension: ${namespace}`);
  }
  for (const kind of ["commands", "agents", "hooks", "lsp", "apps"] as const) {
    const key = kind === "lsp" ? "lspServers" : kind;
    if (
      manifest?.[key] !== undefined ||
      overlay[key] !== undefined ||
      [...files.keys()].some(
        (path) => path.startsWith(`${kind}/`) || path === `.${kind === "apps" ? "app" : kind}.json`,
      )
    )
      add(kind, kind, {
        name: kind,
        description: "",
        supported: false,
        issues: [`${kind} execution is not supported`],
      });
  }
  if (!components.length) throw new Error("No plugin components were found");
  const runtimeNames = components.flatMap((component) =>
    component.runtimeName ? [component.runtimeName] : [],
  );
  assert.equal(
    new Set(runtimeNames).size,
    runtimeNames.length,
    "Skill runtime identities must be unique within a package",
  );
  assert(
    runtimeNames.every((name) => /^[a-z0-9-]{1,64}$/.test(name)),
    "Skill runtime names must satisfy Mastra's slug constraints",
  );
  const presentation =
    overlay.interface && typeof overlay.interface === "object" && !Array.isArray(overlay.interface)
      ? (overlay.interface as Record<string, unknown>)
      : {};
  const examples = presentation.defaultPrompt;
  return {
    digest: pluginHash(JSON.stringify([packageDigest(files), format, manifest, listing?.strict])),
    name:
      typeof listing?.manifest?.displayName === "string"
        ? listing.manifest.displayName
        : typeof presentation.displayName === "string"
          ? presentation.displayName
          : typeof manifest?.displayName === "string"
            ? manifest.displayName
            : name,
    description:
      typeof manifest?.description === "string"
        ? manifest.description
        : (listing?.description ?? ""),
    format,
    version: typeof manifest?.version === "string" ? manifest.version : listing?.version,
    author:
      typeof manifest?.author === "string"
        ? manifest.author
        : manifest?.author && typeof manifest.author === "object"
          ? z.object({ name: z.string().optional() }).parse(manifest.author).name
          : undefined,
    license: typeof manifest?.license === "string" ? manifest.license : undefined,
    homepage: typeof manifest?.homepage === "string" ? manifest.homepage : undefined,
    usageExamples:
      typeof examples === "string"
        ? [examples]
        : Array.isArray(examples)
          ? examples.filter((example): example is string => typeof example === "string")
          : undefined,
    readmePath: [...files.keys()].find((path) => /^readme\.md$/i.test(path)),
    components,
    userConfig,
    defaultEnabled:
      typeof listing?.manifest?.defaultEnabled === "boolean"
        ? listing.manifest.defaultEnabled
        : typeof manifest?.defaultEnabled === "boolean"
          ? manifest.defaultEnabled
          : undefined,
    dependencies,
    blockedReasons,
    issues,
    installedAt: new Date().toISOString(),
  };
}
