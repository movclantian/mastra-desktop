import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import AdmZip from "adm-zip";
import type { PluginChange, PluginVersion } from "../../shared/plugin-contract";

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
      if (
        JSON.stringify([old.agent, old.command, old.hooks, old.lsp]) !==
        JSON.stringify([component.agent, component.command, component.hooks, component.lsp])
      )
        changes.push({ kind: "configuration", ...identity });
    }
    const keys = component.configurationKeys?.filter(
      (key) => !old?.configurationKeys?.includes(key),
    );
    if (keys?.length) changes.push({ kind: "configuration", ...identity, keys });
  }
  return changes;
}
