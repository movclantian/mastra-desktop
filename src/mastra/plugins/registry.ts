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
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import matter from "gray-matter";
import type {
  InstalledPlugin,
  MarketplaceListing,
  PluginComponent,
  PluginSkill,
  PluginSource,
  PluginVersion,
} from "../../shared/plugin-contract";
import { getLibsqlClient, getStorageDirectory } from "../storage/database";
import {
  archiveFiles,
  describePackage,
  directoryFiles,
  MAX_PACKAGE_BYTES,
  type PackageFiles,
  packageChanges,
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
  return rows.rows.map((row) => JSON.parse(String(row.record)) as InstalledPlugin);
}

export async function getInstalledPlugin(
  id: string,
  owner?: string,
): Promise<InstalledPlugin | undefined> {
  await preparePluginStorage(ownerKey(owner));
  const result = await (await database()).execute({
    sql: "SELECT record FROM installed_plugins WHERE owner = ? AND id = ?",
    args: [ownerKey(owner), id],
  });
  return result.rows[0]
    ? (JSON.parse(String(result.rows[0].record)) as InstalledPlugin)
    : undefined;
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
          if (marker && !JSON.parse(marker).removeData)
            await rm(withinRoot(base, "versions"), { recursive: true, force: true });
          else {
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
    })().catch((error) => {
      preparedOwners.delete(owner);
      throw error;
    });
    preparedOwners.set(owner, pending);
  }
  await pending;
}

async function saveRecord(plugin: InstalledPlugin, owner: string): Promise<void> {
  await (await database()).execute({
    sql: "INSERT INTO installed_plugins (owner, id, record) VALUES (?, ?, ?) ON CONFLICT(owner, id) DO UPDATE SET record = excluded.record",
    args: [owner, plugin.id, JSON.stringify(plugin)],
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
async function gitPackageFiles(
  source: Extract<PluginSource, { kind: "git" }>,
  signal?: AbortSignal,
) {
  const temporary = await mkdtemp(join(tmpdir(), "mastra-plugin-"));
  const repository = withinRoot(temporary, "repository");
  const hooks = withinRoot(temporary, "empty-hooks");
  await mkdir(hooks);
  const git = async (args: string[]) =>
    (
      await executeGit(
        "git",
        ["-c", "protocol.file.allow=never", "-c", `core.hooksPath=${hooks}`, ...args],
        {
          windowsHide: true,
          timeout: 90_000,
          maxBuffer: 1024 * 1024,
          signal,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
      )
    ).stdout.trim();
  try {
    const url = new URL(source.url);
    if (url.username || url.password)
      throw new Error("Use Git's credential manager instead of credentials in repository URLs");
    await git(["clone", "--filter=blob:none", "--no-checkout", "--", source.url, repository]);
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
    if (source.path)
      await git([
        "-C",
        repository,
        "sparse-checkout",
        "set",
        "--no-cone",
        "--",
        packagePath(source.path),
      ]);
    await git(["-C", repository, "checkout", "--detach", revision]);
    const directory = withinRoot(repository, source.path || ".");
    const files = await directoryFiles(directory);
    const modes = await git([
      "-C",
      repository,
      "ls-tree",
      "-r",
      revision,
      "--",
      source.path || ".",
    ]);
    const prefix = source.path ? `${packagePath(source.path)}/` : "";
    files.executablePaths = new Set(
      modes.split("\n").flatMap((line) => {
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
  if (source.kind === "local") return { files: await directoryFiles(source.path) };
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
    return getSkillsShPackage(source.source, source.slug);
  }
  if (source.kind === "upload")
    throw new Error("Select the ZIP file again to update an uploaded plugin");
  return gitPackageFiles(source, signal);
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
    for (const [path, contents] of files) {
      const target = withinRoot(staging, `source/${packagePath(path)}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents, {
        flag: "wx",
        mode: files.executablePaths?.has(path) ? 0o755 : 0o644,
      });
    }
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
      for (const [path, contents] of files) {
        if (!path.startsWith(prefix)) continue;
        const rel = path.slice(prefix.length);
        const target = withinRoot(staging, `skills/${component.runtimeName}/${packagePath(rel)}`);
        await mkdir(dirname(target), { recursive: true });
        if (rel === "SKILL.md") {
          const parsed = matter(contents.toString("utf8"));
          await writeFile(
            target,
            matter.stringify(parsed.content, { ...parsed.data, name: component.runtimeName }),
            { flag: "wx" },
          );
        } else
          await writeFile(target, contents, {
            flag: "wx",
            mode: files.executablePaths?.has(path) ? 0o755 : 0o644,
          });
      }
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
  const { syncPluginMcp, removePluginMcp } = await import("../connections/mcp");
  try {
    await syncPluginMcp(next, owner);
    await saveRecord(next, owner);
  } catch (error) {
    if (previous) {
      await syncPluginMcp(previous, owner);
      await saveRecord(previous, owner);
    } else await removePluginMcp(next.id, owner);
    throw error;
  }
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
      enabled: true,
      componentEnabled: {},
      createdAt: now,
      updatedAt: now,
    };
    await writeVersion(plugin, acquired.files, owner);
    await activateRecord(plugin, undefined, owner);
    await rm(withinRoot(pluginsDirectory(owner), `${id}/configuration.json`), { force: true });
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
              path: join(pluginVersionDirectory(plugin, owner), "skills", component.runtimeName),
              enabled: plugin.enabled && plugin.componentEnabled[component.id] !== false,
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
  return plugin.enabled && component.supported && plugin.componentEnabled[component.id] !== false;
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
): Promise<InstalledPlugin> {
  const owner = ownerKey(ownerInput);
  return withPluginOperation(owner, id, async () => {
    const plugin = await getInstalledPlugin(id, owner);
    if (!plugin) throw new Error("Plugin not found");
    const candidate = await updateSource(plugin, owner, false);
    const acquired = await fetchPluginFiles(candidate.source);
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
    };
    await activateRecord(next, plugin, owner);
    return next;
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
    }
    // Files may still be referenced by an active Agent run. Reclamation happens on a subsequent cold start.
  });
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
    const parent = await realpath(target);
    const managed = await realpath(getStorageDirectory());
    const rel = relative(managed, parent);
    if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
      throw new Error("Choose a directory outside application storage for the editable copy");
    const files = await directoryFiles(join(pluginVersionDirectory(plugin, owner), "source"));
    const prefix = plugin.current.name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || "plugin";
    const destination = await mkdtemp(join(parent, `${prefix}-`));
    withinRoot(parent, destination);
    try {
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
