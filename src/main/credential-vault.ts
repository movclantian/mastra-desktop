import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { SafeStorage } from "electron";
import { z } from "zod";
import {
  CredentialBrokerRequestSchema,
  type CredentialPointer,
  CredentialPointerSchema,
  CredentialPurposeSchema,
  CredentialValueSchema,
  SecretRefSchema,
} from "../shared/credential-contract";

const keyDocumentSchema = z.object({ version: z.literal(1), encryptedKey: z.string().min(1) });
const secretDocumentSchema = z.object({
  version: z.literal(1),
  secretRef: SecretRefSchema,
  purpose: CredentialPurposeSchema,
  nonce: z.string().min(1),
  authTag: z.string().min(1),
  ciphertext: z.string().min(1),
});

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export class CredentialVault {
  private dataKey: Buffer | null = null;

  constructor(
    private readonly directory: string,
    private readonly storage: SafeStorage,
  ) {}

  async initialize(): Promise<void> {
    await this.key();
  }

  private assertProtectedStorage(): void {
    if (!this.storage.isEncryptionAvailable()) {
      throw new Error("系统凭据存储不可用，凭据金库无法启动");
    }
  }

  private async key(): Promise<Buffer> {
    if (this.dataKey) return this.dataKey;
    this.assertProtectedStorage();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700).catch(() => undefined);
    const path = join(this.directory, "vault-key.json");
    try {
      const document = keyDocumentSchema.parse(JSON.parse(await readFile(path, "utf8")));
      const key = Buffer.from(
        this.storage.decryptString(Buffer.from(document.encryptedKey, "base64")),
        "base64",
      );
      if (key.length !== 32) throw new Error("凭据金库数据密钥长度无效");
      this.dataKey = key;
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const key = randomBytes(32);
    const encryptedKey = this.storage.encryptString(key.toString("base64")).toString("base64");
    await atomicWrite(path, JSON.stringify({ version: 1, encryptedKey }));
    this.dataKey = key;
    return key;
  }

  private path(secretRef: string): string {
    return join(this.directory, `${SecretRefSchema.parse(secretRef)}.json`);
  }

  private aad(secretRef: string, purpose: string): Buffer {
    return Buffer.from(`mastra-desktop:v1:${secretRef}:${purpose}`, "utf8");
  }

  async put(value: string, purpose: string, existingRef?: string): Promise<CredentialPointer> {
    const secret = CredentialValueSchema.parse(value);
    const parsedPurpose = CredentialPurposeSchema.parse(purpose);
    const secretRef = existingRef
      ? SecretRefSchema.parse(existingRef)
      : `secret_${randomUUID().replaceAll("-", "")}`;
    if (existingRef) {
      const existing = secretDocumentSchema.parse(
        JSON.parse(await readFile(this.path(secretRef), "utf8")),
      );
      if (existing.purpose !== parsedPurpose) throw new Error("凭据用途不匹配");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await this.key(), nonce);
    cipher.setAAD(this.aad(secretRef, parsedPurpose), {
      plaintextLength: Buffer.byteLength(secret),
    });
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    await atomicWrite(
      this.path(secretRef),
      JSON.stringify({
        version: 1,
        secretRef,
        purpose: parsedPurpose,
        nonce: nonce.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      }),
    );
    return CredentialPointerSchema.parse({
      credentialRef: secretRef,
      credentialHint: secret.length >= 4 ? `…${secret.slice(-4)}` : "••••",
      hasCredential: true,
    });
  }

  async get(secretRef: string, purpose: string): Promise<string> {
    const parsedPurpose = CredentialPurposeSchema.parse(purpose);
    const document = secretDocumentSchema.parse(
      JSON.parse(await readFile(this.path(secretRef), "utf8")),
    );
    if (document.purpose !== parsedPurpose) throw new Error("凭据用途不匹配");
    const ciphertext = Buffer.from(document.ciphertext, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      await this.key(),
      Buffer.from(document.nonce, "base64"),
    );
    decipher.setAAD(this.aad(document.secretRef, parsedPurpose), {
      plaintextLength: ciphertext.length,
    });
    decipher.setAuthTag(Buffer.from(document.authTag, "base64"));
    return CredentialValueSchema.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
    );
  }

  async delete(secretRef: string, purpose: string): Promise<void> {
    const parsedPurpose = CredentialPurposeSchema.parse(purpose);
    const path = this.path(secretRef);
    const document = secretDocumentSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (document.purpose !== parsedPurpose) throw new Error("凭据用途不匹配");
    await rm(path, { force: true });
  }

  dispose(): void {
    this.dataKey?.fill(0);
    this.dataKey = null;
  }
}

export class CredentialBroker {
  readonly token = randomBytes(32).toString("base64url");
  readonly endpoint: string;
  private server: Server | null = null;

  constructor(
    private readonly vault: CredentialVault,
    directory: string,
  ) {
    this.endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\mastra-desktop-credentials-${randomUUID()}`
        : join(directory, `broker-${randomUUID()}.sock`);
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
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > 131_072) socket.destroy();
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      socket.removeAllListeners("data");
      void this.respond(socket, input.slice(0, newline));
    });
  }

  private async respond(socket: Socket, input: string): Promise<void> {
    try {
      const request = CredentialBrokerRequestSchema.parse(JSON.parse(input));
      if (!this.authenticated(request.token)) throw new Error("认证失败");
      if (request.operation === "get") {
        socket.end(
          `${JSON.stringify({ ok: true, value: await this.vault.get(request.secretRef, request.purpose) })}\n`,
        );
        return;
      }
      if (request.operation === "put") {
        const credential = await this.vault.put(request.value, request.purpose, request.secretRef);
        socket.end(`${JSON.stringify({ ok: true, credential })}\n`);
        return;
      }
      await this.vault.delete(request.secretRef, request.purpose);
      socket.end(`${JSON.stringify({ ok: true })}\n`);
    } catch {
      socket.end(`${JSON.stringify({ ok: false, error: "凭据操作失败" })}\n`);
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (process.platform !== "win32")
      await rm(this.endpoint, { force: true }).catch(() => undefined);
    this.vault.dispose();
  }
}
