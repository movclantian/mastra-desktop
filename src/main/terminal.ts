/**
 * 终端会话运行时:node-pty 封装,按 IPC 契约(src/shared/terminal-contract.ts)
 * 创建 / 写入 / 调整 / 关闭终端会话,事件经回调推回渲染进程。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join } from "node:path";
import type {
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalEvent,
  TerminalResizeRequest,
  TerminalWriteRequest,
} from "../shared/terminal-contract";

interface Disposable {
  dispose(): void;
}

interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable;
}

interface TerminalPtyModule {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): PtyProcess;
}

interface OwnedTerminal {
  readonly process: PtyProcess;
  readonly data: Disposable;
  readonly exit: Disposable;
}

const VOLTA_HOME_DIRECTORY_NAMES = new Set(["volta", ".volta"]);

function environmentKey(environment: Record<string, string>, name: string): string | undefined {
  return Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase());
}

function environmentValue(environment: Record<string, string>, name: string): string | undefined {
  const key = environmentKey(environment, name);
  return key ? environment[key] : undefined;
}

function setEnvironmentValue(
  environment: Record<string, string>,
  name: string,
  value: string,
): void {
  environment[environmentKey(environment, name) ?? name] = value;
}

function pathEnvironmentKey(environment: Record<string, string>): string {
  return environmentKey(environment, "PATH") ?? "Path";
}

function prependPathEntry(environment: Record<string, string>, entry: string): void {
  const key = pathEnvironmentKey(environment);
  const current = (environment[key] ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase();
  if (current.some((value) => normalize(value) === normalize(entry))) return;
  environment[key] = [entry, ...current].join(delimiter);
}

function environmentPathEntries(environment: Record<string, string>): string[] {
  return (environment[pathEnvironmentKey(environment)] ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isVoltaHome(path: string): boolean {
  return existsSync(join(path, "bin", "volta.exe"));
}

function voltaHomeFromShims(pathEntries: string[]): string | undefined {
  return pathEntries
    .filter((entry) => basename(entry).toLowerCase() === "bin")
    .map((entry) => dirname(entry))
    .find(
      (entry) =>
        VOLTA_HOME_DIRECTORY_NAMES.has(basename(entry).toLowerCase()) && isVoltaHome(entry),
    );
}

function voltaHomeCandidates(environment: Record<string, string>, pathEntries: string[]): string[] {
  const userHomes = [
    environmentValue(environment, "LOCALAPPDATA"),
    environmentValue(environment, "APPDATA"),
    environmentValue(environment, "USERPROFILE"),
    environmentValue(environment, "HOME"),
  ].map((root, index) => {
    if (!root) return "";
    return join(root, index < 2 ? "Volta" : ".volta");
  });
  const configuredHome = environmentValue(environment, "VOLTA_HOME")?.trim();
  const candidates = [
    configuredHome && isVoltaHome(configuredHome) ? configuredHome : "",
    voltaHomeFromShims(pathEntries) ?? "",
    ...userHomes,
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!candidate || !isVoltaHome(candidate)) return false;
    const normalized = candidate.replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function voltaMsiDirectory(environment: Record<string, string>): string | undefined {
  const systemDrive = environmentValue(environment, "SystemDrive")?.trim() || "";
  const systemRoot = environmentValue(environment, "SystemRoot")?.trim() || "";
  const installRoots = [
    environmentValue(environment, "ProgramW6432"),
    environmentValue(environment, "ProgramFiles"),
    environmentValue(environment, "ProgramFiles(x86)"),
    ...(systemDrive ? [join(systemDrive, "Program Files")] : []),
    ...(systemRoot ? [join(dirname(systemRoot), "Program Files")] : []),
  ].filter((entry): entry is string => Boolean(entry?.trim()));
  const candidates = installRoots.flatMap((root) => [join(root, "Volta"), join(root, ".volta")]);
  return candidates.find((entry) => existsSync(join(entry, "volta.exe")));
}

/**
 * Electron inherits the environment from the process that launched it, which
 * may predate a PATH change or contain only Volta shims. Derive the Volta
 * home/CLI from the inherited environment instead of assuming this machine's
 * drive letters or installation directories.
 */
function normalizeWindowsToolchain(environment: Record<string, string>): void {
  const pathEntries = environmentPathEntries(environment);
  const configuredHome = environmentValue(environment, "VOLTA_HOME")?.trim();
  if (configuredHome && isVoltaHome(configuredHome)) {
    prependPathEntry(environment, join(configuredHome, "bin"));
    return;
  }

  // An existing Volta CLI entry may be an intentional custom install. Keep
  // its PATH position so normal command resolution is not silently reordered.
  const hasVoltaCliInPath = pathEntries.some((entry) => existsSync(join(entry, "volta.exe")));
  if (hasVoltaCliInPath) {
    const voltaHomeFromPath = voltaHomeFromShims(pathEntries);
    if (voltaHomeFromPath) setEnvironmentValue(environment, "VOLTA_HOME", voltaHomeFromPath);
    return;
  }

  const voltaHome = voltaHomeCandidates(environment, pathEntries)[0];
  if (voltaHome) {
    setEnvironmentValue(environment, "VOLTA_HOME", voltaHome);
    prependPathEntry(environment, join(voltaHome, "bin"));
    return;
  }

  // The MSI installs its CLI and shims under Program Files. Only use this
  // documented location when no Volta CLI is already on PATH.
  const msiDirectory = voltaMsiDirectory(environment);
  if (msiDirectory) prependPathEntry(environment, msiDirectory);
}

function loadPty(runtimeRoot: string): TerminalPtyModule {
  const require = createRequire(join(runtimeRoot, "package.json"));
  return require("node-pty") as TerminalPtyModule;
}

function terminalEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (process.platform === "win32") normalizeWindowsToolchain(environment);
  environment.TERM = "xterm-256color";
  environment.COLORTERM = "truecolor";
  environment.TERM_PROGRAM = "Mastra Desktop";
  return environment;
}

function defaultShell(): { shell: string; args: readonly string[] } {
  if (process.platform === "win32") {
    return { shell: process.env.COMSPEC ?? "cmd.exe", args: [] };
  }
  return { shell: process.env.SHELL ?? "/bin/sh", args: ["-l"] };
}

export class TerminalSessionRuntime {
  readonly #sessions = new Map<string, OwnedTerminal>();
  readonly #pty: TerminalPtyModule;
  readonly #shell: string;
  readonly #shellArgs: readonly string[];
  readonly #defaultCwd: string;
  readonly #send: (event: TerminalEvent) => void;

  constructor(options: {
    runtimeRoot: string;
    defaultCwd: string;
    send: (event: TerminalEvent) => void;
  }) {
    this.#pty = loadPty(options.runtimeRoot);
    const shell = defaultShell();
    this.#shell = shell.shell;
    this.#shellArgs = shell.args;
    this.#defaultCwd = options.defaultCwd;
    this.#send = options.send;
  }

  create(request: TerminalCreateRequest): TerminalCreateResult {
    const sessionId = `terminal-${randomUUID()}`;
    let ptyProcess: PtyProcess;
    try {
      ptyProcess = this.#pty.spawn(this.#shell, this.#shellArgs, {
        name: "xterm-256color",
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd ?? this.#defaultCwd,
        env: terminalEnvironment(process.env),
      });
    } catch (error) {
      this.#send({
        type: "error",
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const data = ptyProcess.onData((value) => this.#send({ type: "data", sessionId, data: value }));
    const exit = ptyProcess.onExit((result) => {
      this.#release(sessionId);
      this.#send({
        type: "exit",
        sessionId,
        exitCode: result.exitCode,
        ...(result.signal ? { signal: result.signal } : {}),
      });
    });
    this.#sessions.set(sessionId, { process: ptyProcess, data, exit });
    return { sessionId };
  }

  write(request: TerminalWriteRequest): void {
    this.#sessions.get(request.sessionId)?.process.write(request.data);
  }

  resize(request: TerminalResizeRequest): void {
    this.#sessions.get(request.sessionId)?.process.resize(request.cols, request.rows);
  }

  close(sessionId: string): void {
    const owned = this.#sessions.get(sessionId);
    if (!owned) return;
    this.#release(sessionId);
    try {
      owned.process.kill();
    } catch {
      // The shell may have exited between the lookup and kill.
    }
  }

  dispose(): void {
    for (const sessionId of [...this.#sessions.keys()]) this.close(sessionId);
  }

  #release(sessionId: string): void {
    const owned = this.#sessions.get(sessionId);
    if (!owned) return;
    this.#sessions.delete(sessionId);
    owned.data.dispose();
    owned.exit.dispose();
  }
}
