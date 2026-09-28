import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  NativeBrowserTargetRequestSchema,
  NativeBrowserTargetResponseSchema,
  type NativeBrowserSession,
} from "../shared/browser-contract";

const MAX_REQUEST_BYTES = 8_192;
const MAX_RESPONSE_BYTES = 8_192;

/** Narrow authenticated bridge; Mastra can ask only for a thread's current native target. */
export class NativeBrowserTargetBroker {
  readonly token = randomBytes(32).toString("base64url");
  readonly endpoint: string;
  private server: Server | null = null;

  constructor(
    private readonly resolveTargetId: (session: NativeBrowserSession) => string | null,
    directory: string,
  ) {
    this.endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\mastra-desktop-browser-target-${randomBytes(16).toString("hex")}`
        : join(directory, `browser-target-${randomBytes(16).toString("hex")}.sock`);
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (process.platform !== "win32") await mkdir(dirname(this.endpoint), { recursive: true });
    const server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.endpoint, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") await chmod(this.endpoint, 0o600);
    this.server = server;
  }

  private authenticated(token: string): boolean {
    const actual = Buffer.from(token);
    const expected = Buffer.from(this.token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private handle(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      socket.removeAllListeners("data");
      void this.respond(socket, input.slice(0, newline));
    });
  }

  private async respond(socket: Socket, input: string): Promise<void> {
    try {
      const request = NativeBrowserTargetRequestSchema.parse(JSON.parse(input));
      if (!this.authenticated(request.token)) {
        socket.end(`${JSON.stringify({ ok: false, error: "unauthorized" })}\n`);
        return;
      }
      const targetId = this.resolveTargetId(request);
      const result = NativeBrowserTargetResponseSchema.parse(
        targetId ? { ok: true, targetId } : { ok: false, error: "unavailable" },
      );
      const response = `${JSON.stringify(result)}\n`;
      if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) throw new Error("response too large");
      socket.end(response);
    } catch {
      socket.end(`${JSON.stringify({ ok: false, error: "unavailable" })}\n`);
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32")
      await rm(this.endpoint, { force: true }).catch(() => undefined);
  }
}
