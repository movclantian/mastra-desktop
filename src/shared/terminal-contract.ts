export const TERMINAL_CREATE_CHANNEL = "terminal:create";
export const TERMINAL_WRITE_CHANNEL = "terminal:write";
export const TERMINAL_RESIZE_CHANNEL = "terminal:resize";
export const TERMINAL_CLOSE_CHANNEL = "terminal:close";
export const TERMINAL_EVENT_CHANNEL = "terminal:event";

export const TERMINAL_MIN_COLS = 2;
export const TERMINAL_MAX_COLS = 500;
export const TERMINAL_MIN_ROWS = 2;
export const TERMINAL_MAX_ROWS = 300;
export const TERMINAL_MAX_INPUT_LENGTH = 65_536;

export interface TerminalCreateRequest {
  readonly cwd?: string;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalCreateResult {
  readonly sessionId: string;
}

export interface TerminalWriteRequest {
  readonly sessionId: string;
  readonly data: string;
}

export interface TerminalResizeRequest {
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
}

export type TerminalEvent =
  | { readonly type: "data"; readonly sessionId: string; readonly data: string }
  | {
      readonly type: "exit";
      readonly sessionId: string;
      readonly exitCode?: number;
      readonly signal?: number;
    }
  | { readonly type: "error"; readonly sessionId: string; readonly message: string };

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("terminal request must be an object");
  }
  return value as Record<string, unknown>;
}

function sessionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[a-z0-9][a-z0-9._:-]*$/iu.test(value)
  ) {
    throw new TypeError("invalid terminal session id");
  }
  return value;
}

function dimension(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError("invalid terminal dimensions");
  }
  return value;
}

function cwd(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.trim() !== value
  ) {
    throw new TypeError("invalid terminal working directory");
  }
  return value;
}

export function parseTerminalCreateRequest(value: unknown): TerminalCreateRequest {
  const input = record(value);
  const workingDirectory = cwd(input.cwd);
  return {
    ...(workingDirectory === undefined ? {} : { cwd: workingDirectory }),
    cols: dimension(input.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS),
    rows: dimension(input.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS),
  };
}

export function parseTerminalCreateResult(value: unknown): TerminalCreateResult {
  const input = record(value);
  return { sessionId: sessionId(input.sessionId) };
}

export function parseTerminalWriteRequest(value: unknown): TerminalWriteRequest {
  const input = record(value);
  if (typeof input.data !== "string" || input.data.length > TERMINAL_MAX_INPUT_LENGTH) {
    throw new TypeError("invalid terminal input");
  }
  return { sessionId: sessionId(input.sessionId), data: input.data };
}

export function parseTerminalResizeRequest(value: unknown): TerminalResizeRequest {
  const input = record(value);
  return {
    sessionId: sessionId(input.sessionId),
    cols: dimension(input.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS),
    rows: dimension(input.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS),
  };
}

export function parseTerminalSessionId(value: unknown): string {
  return sessionId(value);
}

export function parseTerminalEvent(value: unknown): TerminalEvent {
  const input = record(value);
  const id = sessionId(input.sessionId);
  if (
    input.type === "data" &&
    typeof input.data === "string" &&
    input.data.length <= TERMINAL_MAX_INPUT_LENGTH
  ) {
    return { type: "data", sessionId: id, data: input.data };
  }
  if (input.type === "exit") {
    const exitCode =
      typeof input.exitCode === "number" && Number.isInteger(input.exitCode)
        ? input.exitCode
        : undefined;
    const signal =
      typeof input.signal === "number" && Number.isInteger(input.signal) ? input.signal : undefined;
    return {
      type: "exit",
      sessionId: id,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(signal === undefined ? {} : { signal }),
    };
  }
  if (
    input.type === "error" &&
    typeof input.message === "string" &&
    input.message.length > 0 &&
    input.message.length <= 2_048
  ) {
    return { type: "error", sessionId: id, message: input.message };
  }
  throw new TypeError("invalid terminal event");
}
