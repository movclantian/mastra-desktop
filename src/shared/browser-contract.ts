import { z } from "zod";
import { CredentialStateSchema } from "./credential-contract";

const BrowserViewportSchema = z.union([
  z.literal("window"),
  z.strictObject({
    width: z.number().int().min(320).max(8_192),
    height: z.number().int().min(240).max(8_192),
  }),
]);

export const BrowserConfigSchema = z
  .strictObject({
    provider: z.enum(["agent", "stagehand", "firecrawl"]),
    scope: z.enum(["thread", "shared"]),
    headless: z.boolean(),
    viewport: BrowserViewportSchema,
    timeout: z.number().int().min(1_000).max(300_000),
    stagehand: z.strictObject({
      providerId: z
        .string()
        .trim()
        .regex(/^(?:[a-zA-Z0-9_-]{1,64})?$/),
      modelId: z.string().trim().max(256),
    }),
    firecrawl: z.strictObject({
      apiUrl: z.string().trim().max(2_048),
      ttl: z.number().int().min(60).max(86_400),
      activityTtl: z.number().int().min(30).max(86_400),
      streamWebView: z.boolean(),
      credential: CredentialStateSchema,
    }),
  })
  .superRefine((config, context) => {
    if (config.provider === "stagehand") {
      for (const field of ["providerId", "modelId"] as const) {
        if (!config.stagehand[field]) {
          context.addIssue({
            code: "custom",
            path: ["stagehand", field],
            message: `Stagehand ${field} is required`,
          });
        }
      }
    }
    if (config.provider === "firecrawl" && !config.firecrawl.credential.hasCredential) {
      context.addIssue({
        code: "custom",
        path: ["firecrawl", "credential"],
        message: "Firecrawl credential is required",
      });
    }
  });

export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

const BrowserUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .transform((value, context) => {
    const normalized = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
    try {
      const url = new URL(normalized);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username !== "" ||
        url.password !== ""
      ) {
        throw new TypeError();
      }
      return url.toString();
    } catch {
      context.addIssue({ code: "custom", message: "invalid browser URL" });
      return z.NEVER;
    }
  });

export const BrowserNavigateRequestSchema = z.strictObject({ url: BrowserUrlSchema });

export const BrowserActionRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.enum(["back", "forward", "reload", "reset-tabs"]) }),
  z.strictObject({ action: z.literal("new-tab"), url: BrowserUrlSchema.optional() }),
  z.strictObject({
    action: z.enum(["switch-tab", "close-tab"]),
    index: z.number().int().min(0).max(99),
  }),
]);

const CoordinateSchema = z.number().finite().min(0).max(32_767);
const ModifierSchema = z.number().int().min(0).max(15);

export const BrowserMouseRequestSchema = z.strictObject({
  type: z.enum(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]),
  x: CoordinateSchema,
  y: CoordinateSchema,
  button: z.enum(["left", "right", "middle", "none"]).optional(),
  clickCount: z.number().int().min(1).max(3).optional(),
  deltaX: z.number().finite().min(-10_000).max(10_000).optional(),
  deltaY: z.number().finite().min(-10_000).max(10_000).optional(),
  modifiers: ModifierSchema.optional(),
});

export const BrowserKeyboardRequestSchema = z.strictObject({
  type: z.enum(["keyDown", "keyUp", "char"]),
  key: z.string().min(1).max(128).optional(),
  code: z.string().max(128).optional(),
  text: z.string().max(1_024).optional(),
  modifiers: ModifierSchema.optional(),
  windowsVirtualKeyCode: z.number().int().min(0).max(65_535).optional(),
});

export const BrowserStateSchema = z.strictObject({
  active: z.boolean(),
  status: z.string().min(1).max(64),
  currentUrl: z.string().max(8_192).nullable(),
  tabs: z
    .array(z.object({ url: z.string().max(8_192), title: z.string().max(1_024).optional() }))
    .max(100),
  activeTabIndex: z.number().int().min(0).max(99),
  closeReason: z.enum(["agent", "user", "process_restart", "error"]).optional(),
  activeUrlChangeSource: z.enum(["agent", "user"]).optional(),
});

export const BrowserResponseSchema = z.object({
  error: z.string().max(4_096).optional(),
  message: z.string().max(4_096).optional(),
  state: BrowserStateSchema.optional(),
});
export const BrowserOkResultSchema = z.strictObject({ ok: z.literal(true) });

export type BrowserAction = z.infer<typeof BrowserActionRequestSchema>["action"];
export type BrowserMouseRequest = z.infer<typeof BrowserMouseRequestSchema>;
export type BrowserKeyboardRequest = z.infer<typeof BrowserKeyboardRequestSchema>;
export type BrowserState = z.infer<typeof BrowserStateSchema>;
export type BrowserResponse = z.infer<typeof BrowserResponseSchema>;
