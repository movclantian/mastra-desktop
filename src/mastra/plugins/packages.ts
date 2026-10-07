import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { validateSkillContent } from "@mastra/core/skills";
import AdmZip from "adm-zip";
import matter from "gray-matter";
import { z } from "zod";
import type {
  MarketplaceListing,
  PluginChange,
  PluginComponent,
  PluginMcpDefinition,
  PluginVersion,
} from "../../shared/plugin-contract";

export const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 2_000;
export interface PackageFiles extends Map<string, Buffer> {
  executablePaths?: Set<string>;
}
export const pluginHash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

export function packagePath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (
    !path ||
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
    if (!entry.isDirectory) {
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
  const visit = async (current: string, prefix: string, ancestors: Set<string>) => {
    const physical = await realpath(current);
    withinRoot(root, physical);
    if (ancestors.has(physical)) throw new Error("Circular directory link in package");
    const next = new Set([...ancestors, physical]);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const name = packagePath(`${prefix}${entry.name}`);
      const path = await realpath(resolve(current, entry.name));
      withinRoot(root, path);
      const info = await lstat(path);
      if (info.isDirectory()) await visit(path, `${name}/`, next);
      else if (info.isFile()) {
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
    const roots = new Set([...result.keys()].map((path) => path.split("/")[0]));
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
    result = new Map([...result].map(([path, value]) => [path.slice(root.length + 1), value]));
    result.executablePaths = executablePaths;
  }
  return result;
}

export function packageDigest(files: PackageFiles): string {
  const hash = createHash("sha256");
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
  return {
    transport: "http",
    url: z.url({ protocol: /^https?$/ }).parse(raw.url),
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
  let manifest = files.has(manifestPath) ? readJson(files, manifestPath) : undefined;
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
  } else if (listing?.format === "claude") {
    const appended = ["skills", "commands", "agents", "hooks", "outputStyles", "themes"];
    if (
      listing.strict === false &&
      manifest &&
      appended.some((key) => listing.manifest?.[key] !== undefined)
    )
      throw new Error("Conflicting component declarations in a non-strict Claude entry");
    if (!manifest) manifest = listing.manifest;
    else if (listing.strict !== false) {
      // Entry MCP, LSP, userConfig and channels are ignored when the package has its own manifest.
      manifest = { ...manifest };
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
  }
  if (listing && manifest?.name && manifest.name !== listing.key && format === "claude")
    throw new Error("Marketplace entry and plugin manifest names differ");
  const rootSkillName = files.has("SKILL.md")
    ? matter(files.get("SKILL.md")?.toString("utf8") ?? "").data.name
    : undefined;
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
    const identity = pluginHash(`${pluginId}\0skill\0${path}`).slice(0, 20);
    add("skill", path, {
      name: skillName,
      description: typeof parsed.data.description === "string" ? parsed.data.description : "",
      path,
      runtimeName: `skill-${identity}`,
      supported: result.valid,
      issues: result.errors,
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
  const mcpNames = new Set<string>();
  for (const [path, input] of mcpDocuments)
    for (const [serverName, value] of Object.entries(objectSchema.parse(input))) {
      try {
        if (mcpNames.has(serverName)) throw new Error(`Duplicate MCP server name: ${serverName}`);
        mcpNames.add(serverName);
        const mcp = parseMcp(value, format === "portable");
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
                          ].includes(key) && !key.includes(":-"),
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
      : files.has(".codex-plugin/plugin.json")
        ? readJson(files, ".codex-plugin/plugin.json")
        : {};
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
  return {
    digest: packageDigest(files),
    name,
    description:
      typeof manifest?.description === "string"
        ? manifest.description
        : (listing?.description ?? ""),
    format,
    version: typeof manifest?.version === "string" ? manifest.version : undefined,
    author:
      typeof manifest?.author === "string"
        ? manifest.author
        : manifest?.author && typeof manifest.author === "object"
          ? z.object({ name: z.string().optional() }).parse(manifest.author).name
          : undefined,
    license: typeof manifest?.license === "string" ? manifest.license : undefined,
    homepage: typeof manifest?.homepage === "string" ? manifest.homepage : undefined,
    components,
    issues,
    installedAt: new Date().toISOString(),
  };
}
