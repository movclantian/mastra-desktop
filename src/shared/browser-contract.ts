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

const DEFAULT_BROWSER_HOME_URL = "https://www.bing.com/";

export const BrowserConfigSchema = z
  .object({
    provider: z.enum(["agent", "firecrawl"]),
    scope: z.enum(["thread", "shared"]),
    timeout: z.number().int().min(1_000).max(300_000),
    homeUrl: BrowserHomeUrlSchema.default(DEFAULT_BROWSER_HOME_URL),
    firecrawl: z.strictObject({
      apiUrl: z.string().trim().max(2_048),
      ttl: z.number().int().min(60).max(86_400),
      activityTtl: z.number().int().min(30).max(86_400),
      streamWebView: z.boolean(),
      credential: CredentialStateSchema,
    }),
  })
  .superRefine((config, context) => {
    if (config.provider === "firecrawl" && !config.firecrawl.credential.hasCredential) {
      context.addIssue({
        code: "custom",
        path: ["firecrawl", "credential"],
        message: "Firecrawl credential is required",
      });
    }
  });

export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  provider: "agent",
  scope: "thread",
  timeout: 30_000,
  homeUrl: DEFAULT_BROWSER_HOME_URL,
  firecrawl: {
    apiUrl: "",
    ttl: 600,
    activityTtl: 60,
    streamWebView: false,
    credential: { hasCredential: false },
  },
};

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

export const MAX_NATIVE_BROWSER_TABS = 100;

export const BrowserStateSchema = z.strictObject({
  active: z.boolean(),
  status: z.string().min(1).max(64),
  currentUrl: z.string().max(8_192).nullable(),
  tabs: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        url: z.string().max(8_192),
        title: z.string().max(1_024).optional(),
      }),
    )
    .max(MAX_NATIVE_BROWSER_TABS),
  activeTabIndex: z
    .number()
    .int()
    .min(0)
    .max(MAX_NATIVE_BROWSER_TABS - 1),
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
  configure: "native-browser:configure",
  getSurfaces: "native-browser:get-surfaces",
  surfaces: "native-browser:surfaces",
  bindGuest: "native-browser:bind-guest",
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

export const NativeBrowserConfigSchema = z.strictObject({
  resourceId: NativeBrowserSessionSchema.shape.resourceId,
  provider: BrowserConfigSchema.shape.provider,
  scope: BrowserConfigSchema.shape.scope,
  timeout: BrowserConfigSchema.shape.timeout,
  homeUrl: BrowserHomeUrlSchema,
});
export type NativeBrowserConfig = z.infer<typeof NativeBrowserConfigSchema>;

export const NativeBrowserBindGuestSchema = z.strictObject({
  tabId: z.string().uuid(),
  guestId: z.number().int().positive(),
});

/** Agent operations are routed to the Electron-owned, currently visible page. */
export const NativeBrowserAgentOperationSchema = z.enum([
  "state",
  "goto",
  "snapshot",
  "screenshot",
  "click",
  "type",
  "press",
  "select",
  "scroll",
  "hover",
  "back",
  "wait",
  "drag",
  "evaluate",
  "tabs",
]);

export const NativeBrowserAgentCommandRequestSchema = z.strictObject({
  ...NativeBrowserSessionSchema.shape,
  requestId: z.string().uuid(),
  token: z.string().min(32).max(128),
  operation: NativeBrowserAgentOperationSchema,
  input: z.record(z.string(), z.unknown()).optional(),
});

export const NativeBrowserAgentCommandFailureSchema = z.enum([
  "invalid_request",
  "unauthorized",
  "manager_unavailable",
  "session_not_found",
  "session_not_visible",
  "document_changed",
  "stale_ref",
  "operation_failed",
  "tab_limit_reached",
  "response_too_large",
  "resolver_failed",
]);

export const NativeBrowserAgentCommandResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    requestId: z.string().uuid(),
    result: z.unknown(),
  }),
  z.strictObject({
    ok: z.literal(false),
    requestId: z.string().uuid().optional(),
    error: NativeBrowserAgentCommandFailureSchema,
  }),
]);

export const NativeBrowserBoundsSchema = z.strictObject({
  ...NativeBrowserSessionSchema.shape,
  x: z.number().finite().min(0).max(32_767),
  y: z.number().finite().min(0).max(32_767),
  width: z.number().finite().min(0).max(32_767),
  height: z.number().finite().min(0).max(32_767),
});

export const NativeBrowserSurfacesSchema = z.array(
  z.strictObject({
    ...NativeBrowserSessionSchema.shape,
    partition: z.string().min(1),
    bounds: NativeBrowserBoundsSchema,
    activeTabId: z.string().uuid().nullable(),
    tabs: z.array(z.strictObject({ id: z.string().uuid(), title: z.string() })),
  }),
);
export type NativeBrowserSurface = z.infer<typeof NativeBrowserSurfacesSchema>[number];

export const NativeBrowserNavigateSchema = z.strictObject({
  ...NativeBrowserSessionSchema.shape,
  url: BrowserUrlSchema,
});

export const NativeBrowserActionSchema = z.strictObject({
  ...NativeBrowserSessionSchema.shape,
  request: BrowserActionRequestSchema,
  tabId: z.string().uuid().optional(),
});

export const NativeBrowserEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("activate"),
    ...NativeBrowserSessionSchema.shape,
  }),
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
export type NativeBrowserAgentOperation = z.infer<typeof NativeBrowserAgentOperationSchema>;
export type NativeBrowserAgentCommandRequest = z.infer<
  typeof NativeBrowserAgentCommandRequestSchema
>;
export type NativeBrowserAgentCommandFailure = z.infer<
  typeof NativeBrowserAgentCommandFailureSchema
>;
export type NativeBrowserAgentCommandResponse = z.infer<
  typeof NativeBrowserAgentCommandResponseSchema
>;
export type NativeBrowserBounds = z.infer<typeof NativeBrowserBoundsSchema>;
export type NativeBrowserEvent = z.infer<typeof NativeBrowserEventSchema>;
