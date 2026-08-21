/**
 * 终端会话运行时:node-pty 封装,按 IPC 契约(src/shared/terminal-contract.ts)
 * 创建 / 写入 / 调整 / 关闭终端会话,事件经回调推回渲染进程。
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
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
