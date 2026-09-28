import { createConnection } from "node:net";
import {
  NativeBrowserTargetRequestSchema,
  NativeBrowserTargetResponseSchema,
} from "../shared/browser-contract";

const endpoint = process.env.MASTRA_NATIVE_BROWSER_TARGET_BROKER_PATH?.trim();
const token = process.env.MASTRA_NATIVE_BROWSER_TARGET_BROKER_TOKEN?.trim();

export async function getNativeBrowserTargetId(session: {
  resourceId: string;
  threadId: string;
}): Promise<string> {
  if (!endpoint || !token) throw new Error("Native browser target bridge is unavailable");
  const request = NativeBrowserTargetRequestSchema.parse({ ...session, token });
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let response = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () =>
      socket.destroy(new Error("Native browser target lookup timed out")),
    );
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > 8_192) {
        socket.destroy(new Error("Native browser target response is too large"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      try {
        const result = NativeBrowserTargetResponseSchema.parse(
          JSON.parse(response.slice(0, newline)),
        );
        if (!result.ok) {
          fail(new Error("Native browser target is unavailable for this thread"));
          return;
        }
        settled = true;
        resolve(result.targetId);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) fail(new Error("Native browser target bridge closed before responding"));
    });
  });
}
