export type TerminalStatus = "connecting" | "ready" | "exited" | "error";

export interface TerminalSessionInfo {
  title: string;
  status: TerminalStatus;
  lastCommand?: string;
  lastExitCode?: number;
  settledAt?: number;
}

export type TerminalApi = Window["api"]["terminal"];

export function getTerminalApi(): TerminalApi | undefined {
  return typeof window === "undefined" ? undefined : window.api?.terminal;
}
