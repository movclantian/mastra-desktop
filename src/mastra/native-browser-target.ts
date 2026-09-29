import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  NativeBrowserAgentCommandRequestSchema,
  NativeBrowserAgentCommandResponseSchema,
  type NativeBrowserAgentOperation,
} from "../shared/browser-contract";

const endpoint = process.env.MASTRA_NATIVE_BROWSER_AGENT_BROKER_PATH?.trim();
const token = process.env.MASTRA_NATIVE_BROWSER_AGENT_BROKER_TOKEN?.trim();
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export async function executeNativeBrowserCommand<T = unknown>(
  session: { resourceId: string; threadId: string },
  operation: NativeBrowserAgentOperation,
  input?: Record<string, unknown>,
): Promise<T> {
  if (!endpoint || !token) throw new Error("Native browser command bridge is unavailable");
  const requestId = randomUUID();
  const request = NativeBrowserAgentCommandRequestSchema.parse({
    ...session,
    requestId,
    token,
    operation,
    ...(input ? { input } : {}),
  });
  const payload = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) {
    throw new Error("Native browser command request is too large");
  }

  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let response = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(65_000, () => socket.destroy(new Error("Native browser command timed out")));
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) {
        socket.destroy(new Error("Native browser command response is too large"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      try {
        const result = NativeBrowserAgentCommandResponseSchema.parse(
          JSON.parse(response.slice(0, newline)),
        );
        if (result.requestId && result.requestId !== requestId) {
          fail(new Error("Native browser command returned a mismatched request ID"));
          return;
        }
        if (!result.ok) {
          const hint =
            result.error === "session_not_visible"
              ? "Open the Browser panel in this thread, then retry."
              : result.error === "document_changed"
                ? "The page navigated during the operation. Take a fresh snapshot and retry."
                : result.error === "stale_ref"
                  ? "Take a new browser snapshot to refresh element references."
                  : result.error === "tab_limit_reached"
                    ? "The browser has reached its 100-tab limit. Close a tab before opening another."
                    : "";
          fail(
            new Error(
              `Native browser ${operation} failed (${result.error}${hint ? `; ${hint}` : ""}; requestId=${requestId})`,
            ),
          );
          return;
        }
        if (result.requestId !== requestId) {
          fail(new Error("Native browser command returned a mismatched request ID"));
          return;
        }
        settled = true;
        resolve(result.result as T);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) fail(new Error("Native browser command bridge closed before responding"));
    });
  });
}
