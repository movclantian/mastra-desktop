export type TerminalApi = Window["api"]["terminal"];

export function getTerminalApi(): TerminalApi | undefined {
  return typeof window === "undefined" ? undefined : window.api?.terminal;
}
