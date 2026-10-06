import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  type NativeBrowserAgentCommandFailure,
  NativeBrowserAgentCommandRequestSchema,
  type NativeBrowserAgentCommandResponse,
  NativeBrowserAgentCommandResponseSchema,
  type NativeBrowserAgentOperation,
  type NativeBrowserSession,
} from "../../shared/browser-contract";

const MAX_AGENT_REQUEST_BYTES = 64 * 1024;
const MAX_AGENT_RESPONSE_BYTES = 8 * 1024 * 1024;
const AGENT_COMMAND_TIMEOUT_MS = 305_000;

export class NativeBrowserAgentCommandError extends Error {
  constructor(readonly reason: NativeBrowserAgentCommandFailure) {
    super(reason);
    this.name = "NativeBrowserAgentCommandError";
  }
}

type NativeBrowserAgentCommandDiagnostic = {
  requestId: string | null;
  operation: NativeBrowserAgentOperation | null;
  reason: NativeBrowserAgentCommandFailure;
};

/** Authenticated local RPC to the exact visible Electron tab; it never creates a page. */
export class NativeBrowserAgentCommandBroker {
  readonly token = randomBytes(32).toString("base64url");
  readonly endpoint: string;
  private server: Server | null = null;

  constructor(
    private readonly execute: (
      session: NativeBrowserSession,
      operation: NativeBrowserAgentOperation,
      input: Record<string, unknown> | undefined,
    ) => unknown | Promise<unknown>,
    directory: string,
    private readonly onFailure: (diagnostic: NativeBrowserAgentCommandDiagnostic) => void = ({
      requestId,
      operation,
      reason,
    }) => {
      console.warn(
        `[native-browser-agent] request=${requestId ?? "unknown"} operation=${operation ?? "unknown"} failure=${reason}`,
      );
    },
  ) {
    this.endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\mastra-desktop-browser-agent-${randomBytes(16).toString("hex")}`
        : join(directory, `browser-agent-${randomBytes(16).toString("hex")}.sock`);
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
    socket.setTimeout(AGENT_COMMAND_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_AGENT_REQUEST_BYTES) {
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
    let requestId: string | null = null;
    let operation: NativeBrowserAgentOperation | null = null;
    try {
      const rawRequest: unknown = JSON.parse(input);
      if (typeof rawRequest === "object" && rawRequest !== null) {
        if ("requestId" in rawRequest && typeof rawRequest.requestId === "string") {
          requestId = rawRequest.requestId;
        }
        if (
          "operation" in rawRequest &&
          typeof rawRequest.operation === "string" &&
          NativeBrowserAgentCommandRequestSchema.shape.operation.safeParse(rawRequest.operation)
            .success
        ) {
          operation = rawRequest.operation as NativeBrowserAgentOperation;
        }
      }
      const parsed = NativeBrowserAgentCommandRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        this.fail(socket, requestId, operation, "invalid_request");
        return;
      }
      const request = parsed.data;
      requestId = request.requestId;
      operation = request.operation;
      if (!this.authenticated(request.token)) {
        this.fail(socket, requestId, operation, "unauthorized");
        return;
      }

      let result: unknown;
      try {
        result = await this.execute(
          { resourceId: request.resourceId, threadId: request.threadId },
          request.operation,
          request.input,
        );
      } catch (error) {
        const reason =
          error instanceof NativeBrowserAgentCommandError ? error.reason : "resolver_failed";
        this.fail(socket, requestId, operation, reason);
        return;
      }

      const response = NativeBrowserAgentCommandResponseSchema.parse({
        ok: true,
        requestId,
        result,
      });
      const serialized = `${JSON.stringify(response)}\n`;
      if (Buffer.byteLength(serialized) > MAX_AGENT_RESPONSE_BYTES) {
        this.fail(socket, requestId, operation, "response_too_large");
        return;
      }
      socket.end(serialized);
    } catch {
      this.fail(socket, requestId, operation, "invalid_request");
    }
  }

  private fail(
    socket: Socket,
    requestId: string | null,
    operation: NativeBrowserAgentOperation | null,
    reason: NativeBrowserAgentCommandFailure,
  ): void {
    try {
      this.onFailure({ requestId, operation, reason });
    } catch {
      // Diagnostics must not prevent the fail-closed bridge response.
    }
    const response: NativeBrowserAgentCommandResponse =
      NativeBrowserAgentCommandResponseSchema.parse({
        ok: false,
        ...(requestId ? { requestId } : {}),
        error: reason,
      });
    socket.end(`${JSON.stringify(response)}\n`);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32")
      await rm(this.endpoint, { force: true }).catch(() => undefined);
  }
}
