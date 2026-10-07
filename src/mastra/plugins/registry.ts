import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import matter from "gray-matter";
import { satisfies, valid, validRange } from "semver";
import { z } from "zod";
import { pluginCredentialPurpose } from "../../shared/credential-contract";
import {
  type InstalledPlugin,
  type MarketplaceListing,
  type PluginComponent,
  type PluginConfigValue,
  type PluginSkill,
  type PluginSource,
  type PluginVersion,
  pluginConfigurationPatchSchema,
  pluginConfigValueError,
  pluginConfigValueSchema,
} from "../../shared/plugin-contract";
import { deleteCredential, resolveCredential, storeCredential } from "../credential-broker";
import { workError } from "../errors";
import { getLibsqlClient, getStorageDirectory } from "../storage/database";
import {
  archiveFiles,
  claudePackageManifest,
  describePackage,
  directoryFiles,
  MAX_PACKAGE_BYTES,
  type PackageFiles,
  packageChanges,
  packageDirectories,
  packagePath,
  pluginHash,
  selectPackageRoot,
  withinRoot,
} from "./packages";

let tableReady: Promise<void> | undefined;
async function database() {
  const client = await getLibsqlClient();
  tableReady ??= client
    .execute(
      `CREATE TABLE IF NOT EXISTS installed_plugins (owner TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (owner, id))`,
    )
    .then(() => undefined)
    .catch((error) => {
      tableReady = undefined;
      throw error;
    });
  await tableReady;
  return client;
}

function ownerKey(owner?: string): string {
  if (!owner?.trim()) throw new Error("Authenticated plugin owner is required");
  return owner.trim();
}

export function pluginsDirectory(owner?: string): string {
  return join(getStorageDirectory(), "plugins", pluginHash(ownerKey(owner)));
}

export function pluginVersionDirectory(
  plugin: InstalledPlugin,
  owner: string,
  version = plugin.current,
): string {
  return withinRoot(pluginsDirectory(owner), `${plugin.id}/versions/${version.digest}`);
}

export async function listInstalledPlugins(owner?: string): Promise<InstalledPlugin[]> {
  await preparePluginStorage(ownerKey(owner));
  const rows = await (await database()).execute({
    sql: "SELECT record FROM installed_plugins WHERE owner = ? ORDER BY id",
    args: [ownerKey(owner)],
  });
  return evaluatePlugins(rows.rows.map((row) => JSON.parse(String(row.record)) as InstalledPlugin));
}

export async function getInstalledPlugin(
  id: string,
  owner?: string,
): Promise<InstalledPlugin | undefined> {
  return (await listInstalledPlugins(owner)).find((plugin) => plugin.id === id);
}

function evaluatePlugins(plugins: InstalledPlugin[]): InstalledPlugin[] {
  for (const plugin of plugins) {
    plugin.configurationErrors = Object.entries(plugin.current.userConfig ?? {}).flatMap(
      ([key, field]) => {
        const value =
          field.sensitive && plugin.configuration?.secretKeys.includes(key)
            ? undefined
            : (plugin.configuration?.values[key] ?? field.default);
        const error =
          field.sensitive && plugin.configuration?.secretKeys.includes(key)
            ? undefined
            : pluginConfigValueError(field, value);
        return error ? [`${field.title}: ${error}`] : [];
      },
    );
  }
  const errors = new Map<string, string[]>();
  const visit = (plugin: InstalledPlugin, ancestors: Set<string>): string[] => {
    if (ancestors.has(plugin.id)) return [`Circular plugin dependency: ${plugin.current.name}`];
    const cached = errors.get(plugin.id);
    if (cached) return cached;
    const result = [...(plugin.current.blockedReasons ?? [])];
    const next = new Set([...ancestors, plugin.id]);
    for (const dependency of plugin.current.dependencies ?? []) {
      const label = `${dependency.name}${dependency.marketplace ? `@${dependency.marketplace}` : ""}`;
      const sources = new Set(
        plugins
          .filter(
            (item) =>
              item.listing &&
              (dependency.marketplace
                ? item.listing.marketplaceName === dependency.marketplace
                : item.listing.sourceId === plugin.listing?.sourceId),
          )
          .map((item) => item.listing?.sourceId),
      );
      const candidates = plugins.filter(
        (item) => item.listing?.key === dependency.name && sources.has(item.listing.sourceId),
      );
      const target = sources.size === 1 && candidates.length === 1 ? candidates[0] : undefined;
      if (!target) result.push(`Missing or ambiguous plugin dependency: ${label}`);
      else if (
        !target.enabled ||
        target.configurationErrors?.length ||
        !target.current.components.some(
          (component) => component.supported && target.componentEnabled[component.id] !== false,
        ) ||
        visit(target, next).length
      )
        result.push(`Plugin dependency is unavailable: ${label}`);
      else if (
        dependency.version &&
        (!validRange(dependency.version) ||
          !target.current.version ||
          !valid(target.current.version) ||
          !satisfies(target.current.version, dependency.version))
      )
        result.push(`Plugin dependency version is not satisfied: ${label} (${dependency.version})`);
    }
    errors.set(plugin.id, result);
    return result;
  };
  return plugins.map((plugin) => ({ ...plugin, dependencyErrors: visit(plugin, new Set()) }));
}

export async function resolvePluginConfiguration(
  plugin: InstalledPlugin,
): Promise<Record<string, PluginConfigValue>> {
  const pointer = plugin.configuration?.secretCredential;
  const secrets = pointer
    ? z
        .record(z.string(), pluginConfigValueSchema)
        .parse(
          JSON.parse(
            await resolveCredential(pointer.credentialRef, pluginCredentialPurpose(plugin.id)),
          ),
        )
    : {};
  const values: Record<string, PluginConfigValue> = {};
  for (const [key, field] of Object.entries(plugin.current.userConfig ?? {})) {
    const value =
      (field.sensitive ? secrets[key] : plugin.configuration?.values[key]) ?? field.default;
    const error = pluginConfigValueError(field, value);
    if (error) throw new Error(`Invalid plugin configuration: ${field.title} (${error})`);
    if (value !== undefined) values[key] = value;
  }
  return values;
}

function skillDirectory(plugin: InstalledPlugin, owner: string): string {
  return withinRoot(
    pluginsDirectory(owner),
    `${plugin.id}/runtime/${plugin.current.digest}/${plugin.configuration?.revision ?? "default"}`,
  );
}

async function writeSkillEntries(
  plugin: InstalledPlugin,
  owner: string,
  files?: PackageFiles,
): Promise<void> {
  const destination = skillDirectory(plugin, owner);
  const existing = await readdir(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) return;
  const source = join(pluginVersionDirectory(plugin, owner), "source");
  const contents = files ?? (await directoryFiles(source));
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), ".staging-"));
  try {
    for (const component of plugin.current.components) {
      if (
        component.kind !== "skill" ||
        !component.supported ||
        !component.path ||
        !component.runtimeName
      )
        continue;
      const prefix =
        component.path === "SKILL.md" ? "" : component.path.slice(0, -"SKILL.md".length);
      for (const directory of packageDirectories(contents))
        if (directory.startsWith(prefix) && directory.length > prefix.length)
          await mkdir(
            withinRoot(staging, `${component.runtimeName}/${directory.slice(prefix.length)}`),
            { recursive: true },
          );
      for (const [path, buffer] of contents) {
        if (!path.startsWith(prefix)) continue;
        const rel = path.slice(prefix.length);
        const target = withinRoot(staging, `${component.runtimeName}/${packagePath(rel)}`);
        await mkdir(dirname(target), { recursive: true });
        let rendered: Buffer | string = buffer;
        if (plugin.current.format === "claude" && path.endsWith(".md"))
          rendered = buffer
            .toString("utf8")
            .replace(
              /\$\{(CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|user_config\.[^}]+)\}/g,
              (_match, key: string) => {
                if (key === "CLAUDE_PLUGIN_ROOT") return source;
                if (key === "CLAUDE_PLUGIN_DATA")
                  return join(pluginsDirectory(owner), plugin.id, "data");
                const name = key.slice("user_config.".length);
                const field = plugin.current.userConfig?.[name];
                if (!field) throw new Error(`Undeclared userConfig option: ${name}`);
                if (field.sensitive) return `[sensitive:${name}]`;
                const value = plugin.configuration?.values[name] ?? field.default ?? "";
                return Array.isArray(value) ? JSON.stringify(value) : String(value);
              },
            );
        if (rel === "SKILL.md") {
          const parsed = matter(rendered.toString());
          rendered = matter.stringify(parsed.content, {
            ...parsed.data,
            name: component.runtimeName,
          });
        }
        await writeFile(target, rendered, {
          flag: "wx",
          mode: contents.executablePaths?.has(path) ? 0o755 : 0o644,
        });
      }
    }
    await rename(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const preparedOwners = new Map<string, Promise<void>>();
/** Only a cold process can know that no previous Agent run still references an old version. */
async function preparePluginStorage(owner: string): Promise<void> {
  let pending = preparedOwners.get(owner);
  if (!pending) {
    pending = (async () => {
      const root = pluginsDirectory(owner);
      await mkdir(root, { recursive: true });
      const result = await (await database()).execute({
        sql: "SELECT record FROM installed_plugins WHERE owner = ?",
        args: [owner],
      });
      const plugins = new Map(
        result.rows.map((row) => {
          const plugin = JSON.parse(String(row.record)) as InstalledPlugin;
          return [plugin.id, plugin] as const;
        }),
      );
      for (const directory of await readdir(root, { withFileTypes: true })) {
        if (!directory.isDirectory() || !/^plugin_[a-f0-9]{32}$/.test(directory.name)) continue;
        const base = withinRoot(root, directory.name);
        const plugin = plugins.get(directory.name);
        if (!plugin) {
          const marker = await readFile(join(base, "uninstalled.json"), "utf8").catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            },
          );
          if (marker && !JSON.parse(marker).removeData) {
            await rm(withinRoot(base, "versions"), { recursive: true, force: true });
            await rm(withinRoot(base, "runtime"), { recursive: true, force: true });
          } else {
            const userConfiguration = await readFile(
              withinRoot(base, "user-configuration.json"),
              "utf8",
            ).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            });
            const credential = userConfiguration
              ? JSON.parse(userConfiguration).secretCredential
              : undefined;
            if (credential)
              await deleteCredential(
                credential.credentialRef,
                pluginCredentialPurpose(directory.name),
              );
            const saved = await readFile(join(base, "configuration.json"), "utf8").catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
              },
            );
            if (saved) {
              const { deletePluginMcpCredentials, mcpServerConfigSchema } = await import(
                "../connections/mcp"
              );
              await deletePluginMcpCredentials(
                JSON.parse(saved).map((server: unknown) => mcpServerConfigSchema.parse(server)),
                owner,
              );
            }
            await rm(base, { recursive: true, force: true });
          }
          continue;
        }
        await rm(withinRoot(base, "runtime"), { recursive: true, force: true });
        for (const entry of await readdir(base, { withFileTypes: true }))
          if (entry.isDirectory() && entry.name.startsWith(".staging-"))
            await rm(withinRoot(base, entry.name), { recursive: true, force: true });
        const versions = withinRoot(base, "versions");
        const entries = await readdir(versions, { withFileTypes: true }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          },
        );
        for (const entry of entries)
          if (
            entry.isDirectory() &&
            /^[a-f0-9]{64}$/.test(entry.name) &&
            entry.name !== plugin.current.digest &&
            entry.name !== plugin.previous?.digest
          )
            await rm(withinRoot(versions, entry.name), { recursive: true, force: true });
      }
      const { recoverPluginMcp } = await import("../connections/mcp");
      for (const plugin of plugins.values()) await writeSkillEntries(plugin, owner);
      await recoverPluginMcp(evaluatePlugins([...plugins.values()]), owner);
    })().catch((error) => {
      preparedOwners.delete(owner);
      throw error;
    });
    preparedOwners.set(owner, pending);
  }
  await pending;
}

async function saveRecord(plugin: InstalledPlugin, owner: string): Promise<void> {
  assert(
    Object.entries(plugin.current.userConfig ?? {}).every(
      ([key, field]) => !field.sensitive || plugin.configuration?.values[key] === undefined,
    ),
    "Sensitive plugin configuration must use the credential vault; configure the candidate version first",
  );
  const {
    dependencyErrors: _dependencies,
    configurationErrors: _configuration,
    ...record
  } = plugin;
  await (await database()).execute({
    sql: "INSERT INTO installed_plugins (owner, id, record) VALUES (?, ?, ?) ON CONFLICT(owner, id) DO UPDATE SET record = excluded.record",
    args: [owner, plugin.id, JSON.stringify(record)],
  });
}

const operations = new Map<string, Promise<unknown>>();
export async function withPluginOperation<T>(
  owner: string,
  id: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = `${owner}\0${id}`;
  const pending = (operations.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
  operations.set(key, pending);
  try {
    return await pending;
  } finally {
    if (operations.get(key) === pending) operations.delete(key);
  }
}

export async function downloadPackage(url: string, signal?: AbortSignal): Promise<Buffer> {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("Invalid plugin URL");
  const response = await fetch(parsed, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Plugin download failed (HTTP ${response.status})`);
  if (!response.body || Number(response.headers.get("content-length")) > MAX_PACKAGE_BYTES) {
    await response.body?.cancel();
    throw new Error("Plugin download exceeds 25 MB or has no body");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_PACKAGE_BYTES) throw new Error("Plugin download exceeds 25 MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

const executeGit = promisify(execFile);

/** Native Git handles authenticated hosts and sparse checkouts without running package scripts. */
export async function fetchGitPackage(
  source: Extract<PluginSource, { kind: "git" }>,
  signal?: AbortSignal,
  skillSlug?: string,
) {
  const temporary = await mkdtemp(join(tmpdir(), "mastra-plugin-"));
  const repository = withinRoot(temporary, "repository");
  const hooks = withinRoot(temporary, "empty-hooks");
  await mkdir(hooks);
  const git = async (args: string[]) => {
    try {
      return (
        await executeGit(
          "git",
          [
            "--literal-pathspecs",
            "-c",
            "protocol.file.allow=never",
            "-c",
            `core.hooksPath=${hooks}`,
            ...args,
          ],
          {
            windowsHide: true,
            timeout: 90_000,
            maxBuffer: 8 * 1024 * 1024,
            signal,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        )
      ).stdout.trim();
    } catch (error) {
      if (signal?.aborted) throw error;
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      const step = args.find((arg) =>
        ["clone", "fetch", "rev-parse", "ls-tree", "sparse-checkout", "checkout"].includes(arg),
      );
      throw workError("PLUGIN_FETCH_FAILED", {
        text:
          failure.code === "ENOENT"
            ? "未找到 Git，请安装 Git 并重启应用后重试。"
            : failure.killed
              ? `Git ${step} 超时，请检查网络或代理后重试。`
              : failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                ? "Git 仓库目录过大，请导入具体插件子目录。"
                : `Git ${step} 失败，请检查网络、代理、仓库地址及 Git 访问权限后重试。`,
      });
    }
  };
  try {
    const url = new URL(source.url);
    if (url.username || url.password)
      throw new Error("Use Git's credential manager instead of credentials in repository URLs");
    await git([
      "clone",
      "--depth=1",
      "--filter=blob:none",
      "--no-checkout",
      "--",
      source.url,
      repository,
    ]);
    await git([
      "-C",
      repository,
      "fetch",
      "--depth=1",
      "--",
      "origin",
      source.commit ?? source.ref,
    ]);
    const revision = await git(["-C", repository, "rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("Git returned an invalid commit");
    let subdirectory = source.path ? packagePath(source.path) : "";
    if (skillSlug) {
      const paths = (await git(["-C", repository, "ls-tree", "-r", "--name-only", "-z", revision]))
        .split("\0")
        .filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"));
      const matching = paths.filter(
        (path) => basename(dirname(path)).toLowerCase() === skillSlug.toLowerCase(),
      );
      const candidates = matching.length ? matching : paths.filter((path) => path === "SKILL.md");
      if (candidates.length !== 1)
        throw workError("SKILL_PACKAGE_INVALID", {
          text: candidates.length
            ? `仓库中有多个 ${skillSlug} 技能目录，请导入具体子目录。`
            : `仓库中未找到 ${skillSlug} 的 SKILL.md。`,
        });
      const directory = dirname(candidates[0]);
      subdirectory = directory === "." ? "" : packagePath(directory);
    }
    if (subdirectory)
      await git([
        "-C",
        repository,
        "sparse-checkout",
        "set",
        "--cone",
        "--skip-checks",
        "--",
        subdirectory,
      ]);
    await git(["-C", repository, "checkout", "--detach", revision]);
    const directory = withinRoot(repository, subdirectory || ".");
    const files = await directoryFiles(directory);
    if (
      skillSlug &&
      !subdirectory &&
      matter(files.get("SKILL.md")?.toString("utf8") ?? "").data.name !== skillSlug
    )
      throw workError("SKILL_PACKAGE_INVALID", {
        text: `仓库根目录的技能名称与 ${skillSlug} 不一致。`,
      });
    const modes = await git([
      "-C",
      repository,
      "ls-tree",
      "-r",
      "-z",
      revision,
      "--",
      subdirectory || ".",
    ]);
    const prefix = subdirectory ? `${subdirectory}/` : "";
    files.executablePaths = new Set(
      modes.split("\0").flatMap((line) => {
        const match = /^100755 blob [a-f0-9]+\t(.+)$/.exec(line);
        return match?.[1].startsWith(prefix) ? [match[1].slice(prefix.length)] : [];
      }),
    );
    return { files, revision };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function fetchPluginFiles(
  source: PluginSource,
  signal?: AbortSignal,
): Promise<{ files: PackageFiles; revision?: string }> {
  if (source.kind === "local")
    return { files: await directoryFiles(await externalPluginDirectory(source.path)) };
  if (source.kind === "archive")
    return {
      files: selectPackageRoot(
        selectPackageRoot(archiveFiles(await downloadPackage(source.url, signal))),
        source.path,
        false,
      ),
    };
  if (source.kind === "skills-sh") {
    const { getSkillsShPackage } = await import("../skills/marketplaces");
    return getSkillsShPackage(source.source, source.slug, signal);
  }
  if (source.kind === "upload")
    throw new Error("Select the ZIP file again to update an uploaded plugin");
  return fetchGitPackage(source, signal);
}

function installId(source: PluginSource, listing?: MarketplaceListing): string {
  return `plugin_${pluginHash(listing ? `${listing.sourceId}\0${listing.key}` : JSON.stringify(source)).slice(0, 32)}`;
}

async function writeVersion(
  plugin: InstalledPlugin,
  files: PackageFiles,
  owner: string,
): Promise<void> {
  const root = pluginsDirectory(owner);
  const base = withinRoot(root, plugin.id);
  const staging = withinRoot(base, `.staging-${randomUUID()}`);
  const destination = pluginVersionDirectory(plugin, owner);
  await mkdir(staging, { recursive: true });
  try {
    for (const directory of packageDirectories(files))
      await mkdir(withinRoot(staging, `source/${packagePath(directory)}`), { recursive: true });
    for (const [path, contents] of files) {
      const target = withinRoot(staging, `source/${packagePath(path)}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents, {
        flag: "wx",
        mode: files.executablePaths?.has(path) ? 0o755 : 0o644,
      });
    }
    await writeFile(join(staging, "version.json"), JSON.stringify(plugin.current));
    await mkdir(dirname(destination), { recursive: true });
    try {
      await rename(staging, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      const existing = JSON.parse(
        await readFile(join(destination, "version.json"), "utf8"),
      ) as PluginVersion;
      if (existing.digest !== plugin.current.digest) throw error;
    }
    await mkdir(join(base, "data"), { recursive: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function activateRecord(
  next: InstalledPlugin,
  previous: InstalledPlugin | undefined,
  owner: string,
): Promise<void> {
  const plugins = await listInstalledPlugins(owner);
  Object.assign(
    next,
    evaluatePlugins([...plugins.filter((item) => item.id !== next.id), next]).find(
      (item) => item.id === next.id,
    ),
  );
  if (
    next.enabled &&
    (!previous?.enabled || previous.current.digest !== next.current.digest) &&
    next.dependencyErrors?.length
  )
    throw new Error(next.dependencyErrors.join("; "));
  if (previous && previous.current.digest !== next.current.digest)
    await resolvePluginConfiguration(next);
  await writeSkillEntries(next, owner);
  const { syncPluginMcp, removePluginMcp } = await import("../connections/mcp");
  try {
    await syncPluginMcp(next, owner, previous);
    await saveRecord(next, owner);
  } catch (error) {
    if (previous) {
      await syncPluginMcp(previous, owner);
      await saveRecord(previous, owner);
    } else await removePluginMcp(next.id, owner, true);
    throw error;
  }
  const kept = new Set([
    next.configuration?.secretCredential?.credentialRef,
    next.pendingConfiguration?.configuration.secretCredential?.credentialRef,
  ]);
  for (const ref of new Set([
    previous?.configuration?.secretCredential?.credentialRef,
    previous?.pendingConfiguration?.configuration.secretCredential?.credentialRef,
  ]))
    if (ref && !kept.has(ref))
      await deleteCredential(ref, pluginCredentialPurpose(next.id)).catch(() => {
        console.warn(`Could not remove a replaced plugin credential: ${next.id}`);
      });
}

export async function installPlugin(
  input: { source: PluginSource; listing?: MarketplaceListing; files?: PackageFiles },
  ownerInput?: string,
): Promise<InstalledPlugin> {
  const owner = ownerKey(ownerInput);
  const id = installId(input.source, input.listing);
  return withPluginOperation(owner, id, async () => {
    if (input.listing?.blockedReason) throw new Error(input.listing.blockedReason);
    if (await getInstalledPlugin(id, owner)) throw new Error("This plugin is already installed");
    const acquired = input.files ? { files: input.files } : await fetchPluginFiles(input.source);
    const current = describePackage(acquired.files, id, input.listing);
    current.revision = acquired.revision;
    if (!current.components.some((component) => component.supported))
      throw new Error("This plugin has no supported components");
    const runtimeNames = new Set((await listPluginSkills(owner)).map((skill) => skill.name));
    for (const component of current.components) {
      if (!component.runtimeName) continue;
      if (runtimeNames.has(component.runtimeName)) throw new Error("Duplicate skill runtime name");
      runtimeNames.add(component.runtimeName);
    }
    const now = new Date().toISOString();
    const plugin: InstalledPlugin = {
      id,
      source: input.source,
      listing: input.listing,
      current,
      enabled: current.defaultEnabled !== false,
      componentEnabled: {},
      createdAt: now,
      updatedAt: now,
    };
    const retained = await readFile(
      withinRoot(pluginsDirectory(owner), `${id}/user-configuration.json`),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (retained) plugin.configuration = JSON.parse(retained);
    const evaluated = evaluatePlugins([...(await listInstalledPlugins(owner)), plugin]).find(
      (item) => item.id === id,
    );
    if (evaluated?.dependencyErrors?.length) throw new Error(evaluated.dependencyErrors.join("; "));
    await writeVersion(plugin, acquired.files, owner);
    await activateRecord(plugin, undefined, owner);
    await rm(withinRoot(pluginsDirectory(owner), `${id}/configuration.json`), { force: true });
    await rm(withinRoot(pluginsDirectory(owner), `${id}/user-configuration.json`), { force: true });
    await rm(withinRoot(pluginsDirectory(owner), `${id}/uninstalled.json`), { force: true });
    return plugin;
  });
}

export async function setPluginEnabled(
  id: string,
  enabled: boolean,
  componentId: string | undefined,
  ownerInput?: string,
): Promise<InstalledPlugin> {
  const owner = ownerKey(ownerInput);
  return withPluginOperation(owner, id, async () => {
    const current = await getInstalledPlugin(id, owner);
    if (!current) throw new Error("Plugin not found");
    if (
      componentId &&
      !current.current.components.some((component) => component.id === componentId)
    )
      throw new Error("Plugin component not found");
    const next = {
      ...current,
      ...(componentId
        ? { componentEnabled: { ...current.componentEnabled, [componentId]: enabled } }
        : { enabled }),
      updatedAt: new Date().toISOString(),
    };
    await activateRecord(next, current, owner);
    return next;
  });
}

export async function listPluginSkills(owner?: string): Promise<PluginSkill[]> {
  if (!owner) return [];
  const plugins = await listInstalledPlugins(owner);
  return plugins.flatMap((plugin) =>
    plugin.current.components.flatMap((component) =>
      component.kind === "skill" && component.supported && component.runtimeName
        ? [
            {
              id: component.id,
              pluginId: plugin.id,
              name: component.runtimeName,
              displayName: `${plugin.current.name}:${component.name}`,
              description: component.description,
              path: join(skillDirectory(plugin, owner), component.runtimeName),
              enabled: pluginComponentEnabled(plugin, component),
            },
          ]
        : [],
    ),
  );
}

export function pluginComponentEnabled(
  plugin: InstalledPlugin,
  component: PluginComponent,
): boolean {
  return (
    plugin.enabled &&
    !plugin.dependencyErrors?.length &&
    !plugin.configurationErrors?.length &&
    !plugin.current.blockedReasons?.length &&
    component.supported &&
    plugin.componentEnabled[component.id] !== false
  );
}

async function updateSource(plugin: InstalledPlugin, owner: string, refresh: boolean) {
  if (!plugin.listing) return { source: plugin.source, listing: undefined };
  const { getMarketplaceListing } = await import("./marketplaces");
  const listing = await getMarketplaceListing(
    plugin.listing.sourceId,
    plugin.listing.key,
    owner,
    refresh,
  );
  if (listing.blockedReason) throw new Error(listing.blockedReason);
  return { source: listing.source, listing };
}

export async function checkPluginUpdate(id: string, ownerInput?: string): Promise<InstalledPlugin> {
  const owner = ownerKey(ownerInput);
  return withPluginOperation(owner, id, async () => {
    const plugin = await getInstalledPlugin(id, owner);
    if (!plugin) throw new Error("Plugin not found");
    try {
      const candidate = await updateSource(plugin, owner, true);
      const acquired = await fetchPluginFiles(candidate.source);
      const next = describePackage(acquired.files, id, candidate.listing);
      plugin.update = {
        checkedAt: new Date().toISOString(),
        digest: next.digest,
        version: next.version,
        available: next.digest !== plugin.current.digest,
        changes: packageChanges(plugin.current, next),
        preview: next,
      };
    } catch (error) {
      plugin.update = {
        checkedAt: new Date().toISOString(),
        available: false,
        error: error instanceof Error ? error.message : "Update check failed",
      };
    }
    await saveRecord(plugin, owner);
    return plugin;
  });
}

export async function updatePlugin(
  id: string,
  expectedDigest: string,
  ownerInput?: string,
  uploadedFiles?: PackageFiles,
): Promise<InstalledPlugin> {
  const owner = ownerKey(ownerInput);
  return withPluginOperation(owner, id, async () => {
    const plugin = await getInstalledPlugin(id, owner);
    if (!plugin) throw new Error("Plugin not found");
    if (uploadedFiles && plugin.source.kind !== "upload")
      throw new Error("ZIP replacement is only available for ZIP imports");
    const candidate = uploadedFiles
      ? { source: plugin.source, listing: undefined }
      : await updateSource(plugin, owner, false);
    const acquired = uploadedFiles
      ? { files: uploadedFiles, revision: undefined }
      : await fetchPluginFiles(candidate.source);
    const version = describePackage(acquired.files, id, candidate.listing);
    if (version.digest !== expectedDigest)
      throw new Error("Plugin changed since the update check; check again before updating");
    if (version.digest === plugin.current.digest) return plugin;
    version.revision = acquired.revision;
    if (!version.components.some((component) => component.supported))
      throw new Error("The update contains no supported components");
    const next = {
      ...plugin,
      ...candidate,
      previous: plugin.current,
      current: version,
      update: undefined,
      updatedAt: new Date().toISOString(),
      configuration:
        plugin.pendingConfiguration?.digest === version.digest
          ? plugin.pendingConfiguration.configuration
          : plugin.configuration,
      pendingConfiguration: undefined,
    };
    await writeVersion(next, acquired.files, owner);
    await activateRecord(next, plugin, owner);
    return next;
  });
}

export async function rollbackPlugin(id: string, ownerInput?: string): Promise<InstalledPlugin> {
  const owner = ownerKey(ownerInput);
  return withPluginOperation(owner, id, async () => {
    const plugin = await getInstalledPlugin(id, owner);
    if (!plugin?.previous) throw new Error("No previous plugin version is available");
    await readFile(join(pluginVersionDirectory(plugin, owner, plugin.previous), "version.json"));
    const next = {
      ...plugin,
      current: plugin.previous,
      previous: plugin.current,
      update: undefined,
      updatedAt: new Date().toISOString(),
      configuration:
        plugin.pendingConfiguration?.digest === plugin.previous.digest
          ? plugin.pendingConfiguration.configuration
          : plugin.configuration,
      pendingConfiguration: undefined,
    };
    await activateRecord(next, plugin, owner);
    return next;
  });
}

export async function savePluginConfiguration(
  id: string,
  input: z.infer<typeof pluginConfigurationPatchSchema>,
  ownerInput?: string,
): Promise<InstalledPlugin> {
  const owner = ownerKey(ownerInput);
  const patch = pluginConfigurationPatchSchema.parse(input);
  return withPluginOperation(owner, id, async () => {
    const plugin = await getInstalledPlugin(id, owner);
    if (!plugin) throw new Error("Plugin not found");
    const version = [plugin.current, plugin.previous, plugin.update?.preview].find(
      (item) => item?.digest === patch.digest,
    );
    if (!version) throw new Error("Plugin version changed; reload its configuration");
    const pending = version.digest !== plugin.current.digest;
    const original =
      pending && plugin.pendingConfiguration?.digest === version.digest
        ? plugin.pendingConfiguration.configuration
        : plugin.configuration;
    if ((original?.revision ?? "") !== patch.revision)
      throw new Error("Plugin configuration changed; reload before saving");
    const purpose = pluginCredentialPurpose(id);
    const secrets = original?.secretCredential
      ? z
          .record(z.string(), pluginConfigValueSchema)
          .parse(
            JSON.parse(await resolveCredential(original.secretCredential.credentialRef, purpose)),
          )
      : {};
    const values = { ...original?.values };
    const secretPatch = patch.secretPatch
      ? z
          .record(z.string(), pluginConfigValueSchema.nullable())
          .parse(JSON.parse(await resolveCredential(patch.secretPatch.credentialRef, purpose)))
      : {};
    for (const [key, value] of [...Object.entries(patch.values), ...Object.entries(secretPatch)]) {
      const field = version.userConfig?.[key];
      if (!field) throw new Error(`Unknown plugin option: ${key}`);
      if (field.sensitive && Object.hasOwn(patch.values, key) && value !== null)
        throw new Error("Sensitive plugin values must use the credential vault");
      const error = value === null ? undefined : pluginConfigValueError(field, value);
      if (error && error !== "required")
        throw new Error(`Invalid plugin option: ${field.title} (${error})`);
      delete values[key];
      delete secrets[key];
      if (value !== null) (field.sensitive ? secrets : values)[key] = value;
    }
    // Never expose an existing secret when a new manifest changes its classification.
    for (const [key, field] of Object.entries(version.userConfig ?? {})) {
      if (field.sensitive && values[key] !== undefined) {
        secrets[key] = values[key];
        delete values[key];
      } else if (!field.sensitive && secrets[key] !== undefined)
        throw new Error(`Clear and re-enter the option whose sensitivity changed: ${field.title}`);
    }
    const credential = Object.keys(secrets).length
      ? await storeCredential(JSON.stringify(secrets), purpose)
      : undefined;
    const configuration = {
      revision: randomUUID(),
      values,
      secretCredential: credential,
      secretKeys: Object.keys(secrets),
    };
    const next: InstalledPlugin = {
      ...plugin,
      ...(pending
        ? { pendingConfiguration: { digest: version.digest, configuration } }
        : { configuration }),
      updatedAt: new Date().toISOString(),
    };
    try {
      if (pending) await saveRecord(next, owner);
      else await activateRecord(next, plugin, owner);
    } catch (error) {
      if (credential) await deleteCredential(credential.credentialRef, purpose);
      throw error;
    }
    const previous = pending
      ? plugin.pendingConfiguration?.configuration.secretCredential
      : undefined;
    if (
      previous &&
      previous.credentialRef !== next.configuration?.secretCredential?.credentialRef &&
      previous.credentialRef !==
        next.pendingConfiguration?.configuration.secretCredential?.credentialRef
    )
      await deleteCredential(previous.credentialRef, purpose).catch(() => {
        console.warn(`Could not remove a replaced plugin credential: ${id}`);
      });
    return next;
  });
}

export async function previewPluginUpload(id: string, files: PackageFiles, ownerInput?: string) {
  const owner = ownerKey(ownerInput);
  return withPluginOperation(owner, id, async () => {
    const plugin = await getInstalledPlugin(id, owner);
    if (plugin?.source.kind !== "upload") throw new Error("Select an installed ZIP plugin");
    const preview = describePackage(files, id);
    const changes = packageChanges(plugin.current, preview);
    plugin.update = {
      checkedAt: new Date().toISOString(),
      digest: preview.digest,
      available: preview.digest !== plugin.current.digest,
      changes,
      preview,
    };
    await saveRecord(plugin, owner);
    return { preview, changes };
  });
}

export async function uninstallPlugin(
  id: string,
  removeData: boolean,
  ownerInput?: string,
): Promise<void> {
  const owner = ownerKey(ownerInput);
  await withPluginOperation(owner, id, async () => {
    const plugin = await getInstalledPlugin(id, owner);
    if (!plugin) throw new Error("Plugin not found");
    const { getMcpConfig, removePluginMcp, deletePluginMcpCredentials } = await import(
      "../connections/mcp"
    );
    const servers = (await getMcpConfig(owner)).servers
      .filter((server) => server.plugin?.id === id)
      .map(
        ({
          clientId: _clientId,
          serverName: _serverName,
          version: _version,
          status: _status,
          ...server
        }) => server,
      );
    await writeFile(
      withinRoot(pluginsDirectory(owner), `${id}/configuration.json`),
      JSON.stringify(servers),
    );
    if (plugin.configuration)
      await writeFile(
        withinRoot(pluginsDirectory(owner), `${id}/user-configuration.json`),
        JSON.stringify(plugin.configuration),
      );
    try {
      await activateRecord({ ...plugin, enabled: false }, plugin, owner);
      await removePluginMcp(plugin.id, owner, true);
      await writeFile(
        withinRoot(pluginsDirectory(owner), `${id}/uninstalled.json`),
        JSON.stringify({ removeData }),
      );
      await (await database()).execute({
        sql: "DELETE FROM installed_plugins WHERE owner = ? AND id = ?",
        args: [owner, id],
      });
    } catch (error) {
      await activateRecord(plugin, plugin, owner);
      throw error;
    }
    if (removeData) {
      await deletePluginMcpCredentials(servers, owner);
      await rm(withinRoot(pluginsDirectory(owner), `${id}/configuration.json`), { force: true });
      if (plugin.configuration?.secretCredential)
        await deleteCredential(
          plugin.configuration.secretCredential.credentialRef,
          pluginCredentialPurpose(id),
        );
      await rm(withinRoot(pluginsDirectory(owner), `${id}/user-configuration.json`), {
        force: true,
      });
    }
    if (
      plugin.pendingConfiguration?.configuration.secretCredential &&
      plugin.pendingConfiguration.configuration.secretCredential.credentialRef !==
        plugin.configuration?.secretCredential?.credentialRef
    )
      await deleteCredential(
        plugin.pendingConfiguration.configuration.secretCredential.credentialRef,
        pluginCredentialPurpose(id),
      );
    // Files may still be referenced by an active Agent run. Reclamation happens on a subsequent cold start.
  });
}

export async function externalPluginDirectory(path: string): Promise<string> {
  const directory = await realpath(path);
  const managed = await realpath(getStorageDirectory());
  const rel = relative(managed, directory);
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
    throw new Error("Local plugin sources and editable copies must be outside application storage");
  return directory;
}

export async function createLocalPluginCopy(
  id: string,
  target: string,
  ownerInput?: string,
): Promise<string> {
  const owner = ownerKey(ownerInput);
  return withPluginOperation(owner, id, async () => {
    const plugin = await getInstalledPlugin(id, owner);
    if (!plugin) throw new Error("Plugin not found");
    const parent = await externalPluginDirectory(target);
    const files = await directoryFiles(join(pluginVersionDirectory(plugin, owner), "source"));
    if (plugin.current.format === "claude" && plugin.listing) {
      const manifest = claudePackageManifest(files, plugin.listing);
      if (manifest && plugin.current.dependencies?.length)
        manifest.dependencies = plugin.current.dependencies.map((item) => ({
          ...item,
          marketplace: item.marketplace ?? plugin.listing?.marketplaceName,
        }));
      const selected = new Set(
        plugin.current.components.filter((item) => item.kind === "skill").map((item) => item.path),
      );
      // Entry-only packages may select a subset of a marketplace's default skills.
      // Keep their resources, but do not activate the other packages' entry files in the copy.
      for (const path of files.keys())
        if (/^skills\/[^/]+\/SKILL\.md$/.test(path) && !selected.has(path)) files.delete(path);
      if (manifest)
        files.set(".claude-plugin/plugin.json", Buffer.from(JSON.stringify(manifest, null, 2)));
    }
    const prefix = plugin.current.name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || "plugin";
    const destination = await mkdtemp(join(parent, `${prefix}-`));
    withinRoot(parent, destination);
    try {
      for (const directory of packageDirectories(files))
        await mkdir(withinRoot(destination, packagePath(directory)), { recursive: true });
      for (const [path, contents] of files) {
        const file = withinRoot(destination, packagePath(path));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, contents, {
          flag: "wx",
          mode: files.executablePaths?.has(path) ? 0o755 : 0o644,
        });
      }
      return destination;
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  });
}
