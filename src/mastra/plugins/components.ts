import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { validateSkillContent } from "@mastra/core/skills";
import matter from "gray-matter";
import { validRange } from "semver";
import { z } from "zod";
import {
  type MarketplaceListing,
  type PluginComponent,
  type PluginHook,
  type PluginMcpDefinition,
  type PluginVersion,
  pluginHookEvents,
  pluginUserConfigSchema,
} from "../../shared/plugin-contract";
import { type PackageFiles, packageDirectories, packagePath, pluginHash } from "./packages";

/** Consume Markdown code spans first so a closing ` in `#VALUE!` is not a shell opener. */
export function pluginShellCommands(text: string) {
  return [...text.matchAll(/(`+)([\s\S]*?)\1(?!`)/g)].flatMap((match) =>
    match[1].length === 1 &&
    match[2].trim() &&
    text[match.index - 1] === "!" &&
    text[match.index - 2] !== "\\"
      ? [{ command: match[2], start: match.index - 1, end: match.index + match[0].length }]
      : [],
  );
}

const strings = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (typeof value === "string" ? value.split(/,(?![^()]*\))/) : value)
      .map((item) => item.trim())
      .filter(Boolean),
  );
const toolNames = strings.refine(
  (items) =>
    items.every(
      (item) => /^[\w*.-]+$/.test(item) || /^(?:Bash|Agent|Task)\([^\r\n]+\)$/.test(item),
    ),
  "Invalid tool permission pattern",
);
const model = z.string().min(1).optional();
const hookSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("command"),
      command: z.string().min(1),
      timeout: z.number().positive().max(600).default(60),
      statusMessage: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("http"),
      url: z.url({ protocol: /^https?$/ }),
      headers: z.record(z.string(), z.string()).optional(),
      timeout: z.number().positive().max(600).default(30),
      statusMessage: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("prompt"),
      prompt: z.string().min(1),
      model,
      timeout: z.number().positive().max(600).default(30),
      statusMessage: z.string().optional(),
    })
    .strict(),
]);

/** Reject events and execution flags we cannot preserve, rather than silently dropping policy. */
export function parsePluginHooks(value: unknown): PluginHook[] {
  const events = z
    .partialRecord(
      z.enum(pluginHookEvents),
      z
        .array(
          z
            .object({
              matcher: z.string().max(256).optional(),
              hooks: z.array(hookSchema).min(1).max(32),
            })
            .strict(),
        )
        .max(32),
    )
    .parse(value);
  return Object.entries(events).flatMap(([event, groups]) =>
    groups.flatMap((group) => {
      // Matchers are tool/agent alternatives with glob wildcards, not executable regular expressions.
      if (group.matcher && !/^[\w.*|:-]+$/.test(group.matcher))
        throw new Error("Hook matcher must use names, | alternatives, or * wildcards");
      if (group.matcher && group.matcher !== "*" && /[.*]/.test(group.matcher.replaceAll(".*", "")))
        throw new Error("Hook matchers support literal names, | alternatives and .* only");
      if (
        group.matcher &&
        ![
          "PreToolUse",
          "PostToolUse",
          "PostToolUseFailure",
          "SubagentStart",
          "SubagentStop",
          "SessionStart",
          "SessionEnd",
        ].includes(event)
      )
        throw new Error(`Matchers do not apply to ${event}`);
      return group.hooks.map((hook) => ({
        ...hook,
        event: z.enum(pluginHookEvents).parse(event),
        matcher: group.matcher,
      }));
    }),
  );
}

const agentSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9][\w-]{0,63}$/),
    description: z.string().min(1),
    model,
    tools: toolNames.optional(),
    disallowedTools: toolNames.optional(),
    skills: strings.optional(),
    mcpServers: z.array(z.string()).optional(),
    delegates: strings.default([]),
    maxTurns: z.number().int().positive().max(1000).optional(),
    hooks: z.unknown().transform(parseScopedHooks).optional(),
    color: z.string().optional(),
    permissionMode: z.literal("default").optional(),
  })
  .strict();
const commandSchema = z
  .object({
    description: z.string().optional(),
    name: z.string().optional(),
    "argument-hint": z.string().optional(),
    "allowed-tools": toolNames.optional(),
    model,
    context: z.literal("fork").optional(),
    agent: z.string().min(1).optional(),
    hooks: z.unknown().transform(parseScopedHooks).optional(),
    "disable-model-invocation": z.boolean().optional(),
    "user-invocable": z.literal(true).optional(),
  })
  .strict();

function parseScopedHooks(value: unknown): PluginHook[] {
  const hooks = parsePluginHooks(value);
  if (hooks.some((hook) => hook.event === "SessionStart" || hook.event === "SessionEnd"))
    throw new Error(
      "Session lifecycle hooks must be declared in the plugin hooks component, not an agent or command",
    );
  return hooks;
}

export function describeExecutableComponents(
  files: PackageFiles,
  pluginId: string,
  manifest: Record<string, unknown>,
): PluginComponent[] {
  const components: PluginComponent[] = [];
  const add = (
    kind: PluginComponent["kind"],
    key: string,
    parse: () => Partial<PluginComponent>,
  ) => {
    const base = {
      id: `pc_${pluginHash(`${pluginId}\0${kind}\0${key}`).slice(0, 32)}`,
      kind,
      key,
      name: basename(key, ".md"),
      description: "",
      path: files.has(key) ? key : undefined,
    };
    try {
      components.push({ ...base, supported: true, issues: [], ...parse() });
    } catch (error) {
      components.push({
        ...base,
        supported: false,
        issues: [error instanceof Error ? error.message : "Invalid component"],
      });
    }
  };
  const declaredPaths = (kind: string): string[] => {
    const declared = manifest[kind];
    if (declared === undefined) return [];
    return z
      .array(z.string().startsWith("./"))
      .parse(typeof declared === "string" ? [declared] : declared)
      .map(packagePath);
  };
  for (const kind of ["agents", "commands"] as const) {
    let roots = [kind as string];
    try {
      roots = [...roots, ...declaredPaths(kind)];
    } catch (error) {
      add(kind, kind, () => {
        throw error;
      });
      continue;
    }
    for (const path of roots.slice(1))
      if (![...files.keys()].some((file) => file === path || file.startsWith(`${path}/`)))
        add(kind, path, () => {
          throw new Error(`Missing ${kind} path: ${path}`);
        });
    for (const [path, buffer] of files) {
      if (
        !path.endsWith(".md") &&
        /\.(?:toml|json|ya?ml|[cm]?[jt]s)$/.test(path) &&
        roots.some((root) => path === root || path.startsWith(`${root}/`))
      ) {
        add(kind, path, () => {
          throw new Error(`Only Markdown ${kind} definitions are supported`);
        });
        continue;
      }
      if (
        !path.endsWith(".md") ||
        !roots.some((root) => path === root || path.startsWith(`${root}/`))
      )
        continue;
      add(kind, path, () => {
        const parsed = matter(buffer.toString("utf8"));
        if (!parsed.content.trim()) throw new Error("Component instructions are empty");
        if (kind === "agents") {
          const data = agentSchema.parse(parsed.data);
          if (pluginShellCommands(parsed.content).length)
            throw new Error("Agent instructions cannot execute shell preprocessing");
          const delegatedTools =
            data.tools
              ?.filter((tool) => /^(Agent|Task)\(/.test(tool))
              .flatMap((tool) =>
                tool
                  .slice(tool.indexOf("(") + 1, -1)
                  .split(",")
                  .map((name) => name.trim()),
              ) ?? [];
          return {
            name: data.name,
            description: data.description,
            agent: {
              instructions: parsed.content,
              model: data.model,
              tools: data.tools,
              disallowedTools: data.disallowedTools,
              skills: data.skills,
              mcpServers: data.mcpServers,
              delegates: [...new Set([...data.delegates, ...delegatedTools])],
              maxTurns: data.maxTurns,
              hooks: data.hooks,
            },
          };
        }
        const data = commandSchema.parse(parsed.data);
        if (
          pluginShellCommands(parsed.content).some(({ command }) =>
            /\$ARGUMENTS|\$\d/.test(command),
          )
        )
          throw new Error(
            "User arguments in shell preprocessing are unsupported; read arguments from stdin instead",
          );
        if (data.context === "fork" && !data.agent)
          throw new Error("A forked command must name an agent");
        const root = roots.find((root) => path.startsWith(`${root}/`));
        const name =
          data.name ??
          (root ? path.slice(root.length + 1, -3).replaceAll("/", ":") : basename(path, ".md"));
        if (!/^[\w:-]+$/.test(name)) throw new Error("Invalid command name");
        return {
          name,
          description: data.description ?? "",
          command: {
            instructions: parsed.content,
            argumentHint: data["argument-hint"],
            model: data.model,
            tools: data["allowed-tools"],
            agent: data.agent,
            hooks: data.hooks,
          },
        };
      });
    }
  }
  const json = (path: string) => JSON.parse(files.get(path)?.toString("utf8") ?? "null");
  const hooks = manifest.hooks;
  const hookPaths = new Set([
    "hooks/hooks.json",
    ...(typeof hooks === "string" || Array.isArray(hooks) ? declaredPaths("hooks") : []),
  ]);
  for (const path of hookPaths)
    if (files.has(path) || path !== "hooks/hooks.json")
      add("hooks", path, () => {
        const document = z
          .object({ hooks: z.unknown(), description: z.string().optional() })
          .strict()
          .parse(json(path));
        return { hooks: parsePluginHooks(document.hooks) };
      });
  if (hooks && typeof hooks === "object" && !Array.isArray(hooks))
    add("hooks", "manifest", () => ({
      hooks: parsePluginHooks("hooks" in hooks ? hooks.hooks : hooks),
    }));
  const lspSchema = z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      extensionToLanguage: z.record(z.string().regex(/^\.[\w.-]+$/), z.string().min(1)),
      transport: z.literal("stdio").optional(),
      initializationOptions: z.record(z.string(), z.unknown()).optional(),
    })
    .strict();
  const lsp = manifest.lspServers;
  const lspDocuments: Array<[string, unknown]> = [];
  for (const path of new Set([
    ".lsp.json",
    ...(typeof lsp === "string" || Array.isArray(lsp) ? declaredPaths("lspServers") : []),
  ]))
    if (files.has(path) || path !== ".lsp.json") {
      try {
        lspDocuments.push([path, json(path)]);
      } catch (error) {
        add("lsp", path, () => {
          throw error;
        });
      }
    }
  if (lsp && typeof lsp === "object" && !Array.isArray(lsp)) lspDocuments.push(["manifest", lsp]);
  for (const [path, document] of lspDocuments)
    add("lsp", path, () => {
      const definitions = z.record(z.string(), lspSchema).parse(document);
      for (const [name, definition] of Object.entries(definitions)) {
        if (!Object.keys(definition.extensionToLanguage).length)
          throw new Error("LSP needs file extensions");
        add("lsp", `${path}:${name}`, () => {
          if (definition.command.startsWith("./") && !files.has(packagePath(definition.command)))
            throw new Error("Missing bundled LSP executable");
          return { name, lsp: definition };
        });
      }
      return { supported: false, issues: ["LSP configuration container"] };
    });
  return components.filter(
    (component) => !component.issues.includes("LSP configuration container"),
  );
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
    for (const key of [
      "context",
      "agent",
      "hooks",
      "allowed-tools",
      "disable-model-invocation",
      "model",
    ])
      if (parsed.data[key] !== undefined)
        skillIssues.push(
          `Skill execution field ${key} requires an explicit command or agent component`,
        );
    if (format === "claude") {
      for (const match of content.matchAll(/\$\{user_config\.([^}]+)\}/g))
        if (!userConfig?.[match[1]]) skillIssues.push(`Undeclared userConfig option: ${match[1]}`);
      if (/\$\{CLAUDE_PROJECT_DIR\}/.test(content))
        skillIssues.push("Project-specific skill variables are not supported");
      if (pluginShellCommands(parsed.content).length)
        skillIssues.push("Skill shell preprocessing is not supported");
    }
    const identity = pluginHash(`${pluginId}\0skill\0${path}`).slice(0, 20);
    add("skill", path, {
      name: skillName,
      description: typeof parsed.data.description === "string" ? parsed.data.description : "",
      path,
      runtimeName: `skill-${identity}`,
      userInvocable: parsed.data["user-invocable"] !== false,
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
  components.push(...describeExecutableComponents(files, pluginId, { ...overlay, ...manifest }));
  for (const kind of ["apps"] as const) {
    const key = kind;
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
  for (const component of components) {
    const references =
      component.agent?.delegates ?? (component.command?.agent ? [component.command.agent] : []);
    for (const name of references) {
      const candidates = components.filter(
        (item) => item.kind === "agents" && item.name === name && item.supported,
      );
      if (candidates.length !== 1) {
        component.supported = false;
        component.issues.push(`Missing or ambiguous plugin agent: ${name}`);
      }
    }
    for (const [kind, names] of [
      ["skill", component.agent?.skills],
      ["mcp", component.agent?.mcpServers],
    ] as const)
      for (const name of names ?? [])
        if (
          components.filter((item) => item.kind === kind && item.name === name && item.supported)
            .length !== 1
        ) {
          component.supported = false;
          component.issues.push(`Missing or ambiguous plugin ${kind}: ${name}`);
        }
  }
  if (!components.length) throw new Error("No plugin components were found");
  assert.equal(
    new Set(components.map((component) => component.id)).size,
    components.length,
    "Plugin component identities must be unique",
  );
  const checked = new Set<string>();
  const checkAgent = (component: PluginComponent, ancestors = new Set<string>()): boolean => {
    if (!component.supported) return false;
    if (ancestors.has(component.id)) {
      component.supported = false;
      component.issues.push("Circular Agent delegation is not supported");
      return false;
    }
    if (checked.has(component.id)) return component.supported;
    const next = new Set([...ancestors, component.id]);
    for (const name of component.agent?.delegates ??
      (component.command?.agent ? [component.command.agent] : [])) {
      const target = components.find((item) => item.kind === "agents" && item.name === name);
      if (!target || !checkAgent(target, next)) {
        component.supported = false;
        component.issues.push(`Unavailable delegated Agent: ${name}`);
      }
    }
    checked.add(component.id);
    return component.supported;
  };
  for (const component of components) checkAgent(component);
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
