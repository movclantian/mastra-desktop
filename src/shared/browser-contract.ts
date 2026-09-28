import { z } from "zod";
import { CredentialStateSchema } from "./credential-contract";

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

const BrowserHomeUrlSchema = z.union([z.literal(""), BrowserUrlSchema]);

export const BrowserSearchEngineSchema = z.enum(["bing", "baidu", "google"]);
export type BrowserSearchEngine = z.infer<typeof BrowserSearchEngineSchema>;

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
    homeUrl: BrowserHomeUrlSchema.default(""),
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

export const BrowserKeyboardBatchRequestSchema = z.strictObject({
  events: z.array(BrowserKeyboardRequestSchema).min(1).max(64),
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
export type BrowserKeyboardBatchRequest = z.infer<typeof BrowserKeyboardBatchRequestSchema>;
export type BrowserState = z.infer<typeof BrowserStateSchema>;
export type BrowserResponse = z.infer<typeof BrowserResponseSchema>;

/** Electron 主进程原生浏览器视图的 IPC 合同。 */
export const NATIVE_BROWSER_VIEW_CHANNELS = {
  ensure: "native-browser:ensure",
  setBounds: "native-browser:set-bounds",
  navigate: "native-browser:navigate",
  action: "native-browser:action",
  getState: "native-browser:get-state",
  close: "native-browser:close",
  event: "native-browser:event",
} as const;

export const NativeBrowserSessionSchema = z.strictObject({
  resourceId: z.string().trim().min(1).max(256),
  threadId: z.string().trim().min(1).max(256),
});

/** Authenticated local bridge from the Mastra service to the Electron-owned active tab. */
export const NativeBrowserTargetRequestSchema = z.strictObject({
  ...NativeBrowserSessionSchema.shape,
  token: z.string().min(32).max(128),
});

export const NativeBrowserTargetResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), targetId: z.string().min(1).max(256) }),
  z.strictObject({ ok: z.literal(false), error: z.enum(["unauthorized", "unavailable"]) }),
]);

export const NativeBrowserBoundsSchema = z.strictObject({
  ...NativeBrowserSessionSchema.shape,
  x: z.number().finite().min(0).max(32_767),
  y: z.number().finite().min(0).max(32_767),
  width: z.number().finite().min(0).max(32_767),
  height: z.number().finite().min(0).max(32_767),
});

export const NativeBrowserNavigateSchema = z.strictObject({
  ...NativeBrowserSessionSchema.shape,
  url: BrowserUrlSchema,
});

export const NativeBrowserActionSchema = z.strictObject({
  ...NativeBrowserSessionSchema.shape,
  request: BrowserActionRequestSchema,
});

export const NativeBrowserEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("state"),
    ...NativeBrowserSessionSchema.shape,
    state: BrowserStateSchema,
  }),
  z.strictObject({
    type: z.literal("url"),
    ...NativeBrowserSessionSchema.shape,
    url: z.string().max(8_192),
  }),
  z.strictObject({
    type: z.literal("title"),
    ...NativeBrowserSessionSchema.shape,
    title: z.string().max(1_024),
  }),
  z.strictObject({
    type: z.literal("loading"),
    ...NativeBrowserSessionSchema.shape,
    loading: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("error"),
    ...NativeBrowserSessionSchema.shape,
    message: z.string().max(4_096),
  }),
]);

export type NativeBrowserSession = z.infer<typeof NativeBrowserSessionSchema>;
export type NativeBrowserTargetRequest = z.infer<typeof NativeBrowserTargetRequestSchema>;
export type NativeBrowserTargetResponse = z.infer<typeof NativeBrowserTargetResponseSchema>;
export type NativeBrowserBounds = z.infer<typeof NativeBrowserBoundsSchema>;
export type NativeBrowserEvent = z.infer<typeof NativeBrowserEventSchema>;
