export type TerminalStatus = "connecting" | "ready" | "exited" | "error";

export interface TerminalSessionInfo {
  title: string;
  status: TerminalStatus;
  lastCommand?: string;
  lastExitCode?: number;
  settledAt?: number;
}

export function terminalNeedsCloseConfirmation(status: TerminalStatus | undefined): boolean {
  return status === "connecting" || status === "ready";
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

export type TerminalApi = Window["api"]["terminal"];

export function getTerminalApi(): TerminalApi | undefined {
  return typeof window === "undefined" ? undefined : window.api?.terminal;
}
