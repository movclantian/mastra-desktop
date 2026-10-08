import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import {
  CredentialBrokerResponseSchema,
  CredentialError,
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
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const closedWithoutResponse = () => fail(new Error("凭据 Broker 未返回完整响应即关闭连接"));
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => fail(new Error("凭据 Broker 请求超时")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...payload, token })}\n`));
    socket.on("data", (chunk: string) => {
      if (settled) return;
      response += chunk;
      if (response.length > 131_072) {
        fail(new Error("凭据 Broker 响应过大"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline === -1) return;
      try {
        const result = CredentialBrokerResponseSchema.parse(JSON.parse(response.slice(0, newline)));
        settled = true;
        socket.destroy();
        resolve(result);
      } catch (error) {
        fail(error);
      }
    });
    socket.once("error", fail);
    socket.once("end", closedWithoutResponse);
    socket.once("close", closedWithoutResponse);
  });
}

export async function resolveCredential(secretRef: string, purpose: string): Promise<string> {
  const result = await request({
    operation: "get",
    secretRef: SecretRefSchema.parse(secretRef),
    purpose: CredentialPurposeSchema.parse(purpose),
  });
  if (!result.ok) throw new CredentialError(result.code);
  if (!result.value) throw new Error("凭据为空");
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
  if (!result.ok) throw new CredentialError(result.code);
  if (!result.credential) throw new Error("凭据写入结果无效");
  return result.credential;
}

export async function deleteCredential(secretRef: string, purpose: string): Promise<void> {
  const result = await request({
    operation: "delete",
    secretRef: SecretRefSchema.parse(secretRef),
    purpose: CredentialPurposeSchema.parse(purpose),
  });
  if (!result.ok) throw new CredentialError(result.code);
}

export function oauthCredentialPurpose(serverId: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return CredentialPurposeSchema.parse(`mcp-oauth:${serverId}:${digest}`);
}
