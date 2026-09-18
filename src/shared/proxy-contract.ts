import { z } from "zod";

export const PROXY_CHANNELS = {
  get: "proxy:get",
  set: "proxy:set",
  test: "proxy:test",
} as const;

export const ProxyModeSchema = z.enum(["system", "direct", "manual"]);

export const ProxyUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .transform((value, context) => {
    const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    try {
      const url = new URL(normalized);
      if (!["http:", "https:", "socks5:"].includes(url.protocol) || !url.hostname) {
        throw new TypeError();
      }
      return url.toString();
    } catch {
      context.addIssue({ code: "custom", message: "invalid proxy URL" });
      return z.NEVER;
    }
  });

export const ProxyConfigSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("system"), url: z.undefined().optional() }),
  z.strictObject({ mode: z.literal("direct"), url: z.undefined().optional() }),
  z.strictObject({ mode: z.literal("manual"), url: ProxyUrlSchema }),
]);

export const GetProxyRequestSchema = z.undefined();
export const GetProxyResultSchema = ProxyConfigSchema;
export const SetProxyRequestSchema = ProxyConfigSchema;
export const SetProxyResultSchema = z.strictObject({
  ok: z.literal(true),
  effectiveProxy: ProxyUrlSchema.optional(),
});
export const TestProxyRequestSchema = z.strictObject({ url: ProxyUrlSchema.optional() });
export const TestProxyResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), latencyMs: z.number().int().nonnegative() }),
  z.strictObject({ ok: z.literal(false), error: z.string().min(1).max(4_096) }),
]);

export type ProxyMode = z.infer<typeof ProxyModeSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type ProxySetResult = z.infer<typeof SetProxyResultSchema>;
export type ProxyTestResult = z.infer<typeof TestProxyResultSchema>;
