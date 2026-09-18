import { z } from "zod";

export const CREDENTIAL_CHANNELS = {
  put: "credentials:put",
  delete: "credentials:delete",
} as const;

export const SecretRefSchema = z.string().regex(/^secret_[a-f0-9]{32}$/);
export const CredentialHintSchema = z.string().min(1).max(16);
export const CredentialPurposeSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^(?:provider:[a-zA-Z0-9_-]{1,64}|search:(?:tavily|firecrawl|anysearch)|browser:firecrawl|mcp:[a-zA-Z0-9_-]{1,64}:(?:headers|env|client-secret)|mcp-oauth:[a-zA-Z0-9_-]{1,64}:[a-f0-9]{32})$/,
  );
export const CredentialValueSchema = z.string().min(1).max(65_536);

export const CredentialPointerSchema = z
  .object({
    credentialRef: SecretRefSchema,
    credentialHint: CredentialHintSchema,
    hasCredential: z.literal(true),
  })
  .strict();
export const CredentialStateSchema = z.union([
  CredentialPointerSchema,
  z.object({ hasCredential: z.literal(false) }).strict(),
]);

export const CredentialPutRequestSchema = z
  .object({
    purpose: CredentialPurposeSchema,
    value: CredentialValueSchema,
  })
  .strict();
export const CredentialPutResultSchema = CredentialPointerSchema;

export const CredentialDeleteRequestSchema = z
  .object({
    purpose: CredentialPurposeSchema,
    secretRef: SecretRefSchema,
  })
  .strict();
export const CredentialDeleteResultSchema = z.void();

export const CredentialBrokerRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("get"),
      token: z.string().min(32).max(128),
      purpose: CredentialPurposeSchema,
      secretRef: SecretRefSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("put"),
      token: z.string().min(32).max(128),
      purpose: CredentialPurposeSchema,
      value: CredentialValueSchema,
      secretRef: SecretRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      token: z.string().min(32).max(128),
      purpose: CredentialPurposeSchema,
      secretRef: SecretRefSchema,
    })
    .strict(),
]);

export const CredentialBrokerResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      value: CredentialValueSchema.optional(),
      credential: CredentialPointerSchema.optional(),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: z.string().min(1).max(256) }).strict(),
]);

export type CredentialPointer = z.infer<typeof CredentialPointerSchema>;
export type CredentialState = z.infer<typeof CredentialStateSchema>;
export type CredentialPutRequest = z.infer<typeof CredentialPutRequestSchema>;
export type CredentialPutResult = z.infer<typeof CredentialPutResultSchema>;
export type CredentialDeleteRequest = z.infer<typeof CredentialDeleteRequestSchema>;
export type CredentialPurpose = z.infer<typeof CredentialPurposeSchema>;

export const providerCredentialPurpose = (providerId: string) =>
  CredentialPurposeSchema.parse(`provider:${providerId}`);
export const searchCredentialPurpose = (engine: "tavily" | "firecrawl" | "anysearch") =>
  CredentialPurposeSchema.parse(`search:${engine}`);
export const mcpCredentialPurpose = (
  serverId: string,
  field: "headers" | "env" | "client-secret",
) => CredentialPurposeSchema.parse(`mcp:${serverId}:${field}`);
export const browserCredentialPurpose = (provider: "firecrawl") =>
  CredentialPurposeSchema.parse(`browser:${provider}`);
