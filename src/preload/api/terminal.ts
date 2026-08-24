import type { IpcRenderer } from "electron";
import {
  parseTerminalCreateRequest,
  parseTerminalCreateResult,
  parseTerminalEvent,
  parseTerminalResizeRequest,
  parseTerminalSessionId,
  parseTerminalWriteRequest,
  TERMINAL_CLOSE_CHANNEL,
  TERMINAL_CREATE_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  TERMINAL_RESIZE_CHANNEL,
  TERMINAL_WRITE_CHANNEL,
  type TerminalCreateRequest,
  type TerminalEvent,
  type TerminalResizeRequest,
  type TerminalWriteRequest,
} from "../../shared/terminal-contract";

export function createTerminalApi(ipcRenderer: IpcRenderer) {
  return {
    create: async (request: TerminalCreateRequest) =>
      parseTerminalCreateResult(
        await ipcRenderer.invoke(TERMINAL_CREATE_CHANNEL, parseTerminalCreateRequest(request)),
      ),
    write: (request: TerminalWriteRequest) =>
      ipcRenderer.send(TERMINAL_WRITE_CHANNEL, parseTerminalWriteRequest(request)),
    resize: (request: TerminalResizeRequest) =>
      ipcRenderer.send(TERMINAL_RESIZE_CHANNEL, parseTerminalResizeRequest(request)),
    close: (sessionId: string) =>
      ipcRenderer.send(TERMINAL_CLOSE_CHANNEL, parseTerminalSessionId(sessionId)),
    subscribe: (listener: (event: TerminalEvent) => void) => {
      const wrapped = (_event: unknown, value: unknown) => {
        try {
          listener(parseTerminalEvent(value));
        } catch {
          // Ignore malformed events at the renderer boundary.
        }
      };
      ipcRenderer.on(TERMINAL_EVENT_CHANNEL, wrapped);
      return () => ipcRenderer.off(TERMINAL_EVENT_CHANNEL, wrapped);
    },
  };
}
