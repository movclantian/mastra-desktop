import type { IpcRenderer } from "electron";
import {
  TERMINAL_CLOSE_CHANNEL,
  TERMINAL_CREATE_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  TERMINAL_RESIZE_CHANNEL,
  TERMINAL_WRITE_CHANNEL,
  type TerminalCreateRequest,
  TerminalCreateRequestSchema,
  TerminalCreateResultSchema,
  type TerminalEvent,
  TerminalEventSchema,
  type TerminalResizeRequest,
  TerminalResizeRequestSchema,
  TerminalSessionIdSchema,
  type TerminalWriteRequest,
  TerminalWriteRequestSchema,
} from "../../shared/terminal-contract";

export function createTerminalApi(ipcRenderer: IpcRenderer) {
  return {
    create: async (request: TerminalCreateRequest) =>
      TerminalCreateResultSchema.parse(
        await ipcRenderer.invoke(
          TERMINAL_CREATE_CHANNEL,
          TerminalCreateRequestSchema.parse(request),
        ),
      ),
    write: (request: TerminalWriteRequest) =>
      ipcRenderer.send(TERMINAL_WRITE_CHANNEL, TerminalWriteRequestSchema.parse(request)),
    resize: (request: TerminalResizeRequest) =>
      ipcRenderer.send(TERMINAL_RESIZE_CHANNEL, TerminalResizeRequestSchema.parse(request)),
    close: (sessionId: string) =>
      ipcRenderer.send(TERMINAL_CLOSE_CHANNEL, TerminalSessionIdSchema.parse(sessionId)),
    subscribe: (listener: (event: TerminalEvent) => void) => {
      const wrapped = (_event: unknown, value: unknown) => {
        try {
          listener(TerminalEventSchema.parse(value));
        } catch {
          // Ignore malformed events at the renderer boundary.
        }
      };
      ipcRenderer.on(TERMINAL_EVENT_CHANNEL, wrapped);
      return () => ipcRenderer.off(TERMINAL_EVENT_CHANNEL, wrapped);
    },
  };
}
