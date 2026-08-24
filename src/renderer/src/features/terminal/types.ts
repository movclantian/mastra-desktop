export type TerminalStatus = "connecting" | "ready" | "exited" | "error";

export interface TerminalSessionInfo {
  title: string;
  status: TerminalStatus;
  lastCommand?: string;
  lastExitCode?: number;
  settledAt?: number;
}
