import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import {
  CredentialBrokerResponseSchema,
  type CredentialPointer,
  CredentialPurposeSchema,
  CredentialValueSchema,
  SecretRefSchema,
} from "../shared/credential-contract";

const endpoint = process.env.MASTRA_CREDENTIAL_BROKER_PATH?.trim();
const token = process.env.MASTRA_CREDENTIAL_BROKER_TOKEN?.trim();

async function request(payload: Record<string, unknown>) {
  if (!endpoint || !token) throw new Error("凭据 Broker 未配置");
  return new Promise<ReturnType<typeof CredentialBrokerResponseSchema.parse>>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy(new Error("凭据 Broker 请求超时")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...payload, token })}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > 131_072) socket.destroy(new Error("凭据 Broker 响应过大"));
      const newline = response.indexOf("\n");
      if (newline === -1) return;
      socket.end();
      try {
        resolve(CredentialBrokerResponseSchema.parse(JSON.parse(response.slice(0, newline))));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

export async function resolveCredential(secretRef: string, purpose: string): Promise<string> {
  const result = await request({
    operation: "get",
    secretRef: SecretRefSchema.parse(secretRef),
    purpose: CredentialPurposeSchema.parse(purpose),
  });
  if (!result.ok || !result.value) throw new Error(result.ok ? "凭据为空" : result.error);
  return CredentialValueSchema.parse(result.value);
}

export async function storeCredential(
  value: string,
  purpose: string,
  secretRef?: string,
): Promise<CredentialPointer> {
  const result = await request({
    operation: "put",
    value: CredentialValueSchema.parse(value),
    purpose: CredentialPurposeSchema.parse(purpose),
    ...(secretRef ? { secretRef: SecretRefSchema.parse(secretRef) } : {}),
  });
  if (!result.ok || !result.credential)
    throw new Error(result.ok ? "凭据写入结果无效" : result.error);
  return result.credential;
}

export async function deleteCredential(secretRef: string, purpose: string): Promise<void> {
  const result = await request({
    operation: "delete",
    secretRef: SecretRefSchema.parse(secretRef),
    purpose: CredentialPurposeSchema.parse(purpose),
  });
  if (!result.ok) throw new Error(result.error);
}

export function oauthCredentialPurpose(serverId: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return CredentialPurposeSchema.parse(`mcp-oauth:${serverId}:${digest}`);
}
