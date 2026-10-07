import { z } from "zod";

/** Settings supported by the in-process Cua Driver SDK. */
export const ComputerConfigSchema = z
  .object({
    enabled: z.boolean(),
    permissionMode: z.enum(["standard", "bounded", "unrestricted"]),
    acknowledgeUnrestricted: z.boolean(),
    capabilityManifest: z.string().trim().max(4096),
    approveManifest: z.boolean(),
    requireToolApproval: z.boolean(),
    timeoutMs: z.number().int().min(1000).max(300000),
    sessionTtlMs: z.number().int().min(60000).max(86400000),
    idleTimeoutMs: z.number().int().min(60000).max(3600000),
    deliveryMode: z.enum(["background", "foreground"]),
    includeScreenshot: z.boolean(),
    includeAccessibilityTree: z.boolean(),
    maxImageDimension: z.number().int().min(1).max(8192).nullable(),
    maxElements: z.number().int().min(1).max(10000).nullable(),
    maxDepth: z.number().int().min(1).max(100).nullable(),
    cursorEnabled: z.boolean().nullable(),
    cursorTheme: z.string().trim().min(1).max(128),
    cursorReducedMotion: z.enum(["auto", "on", "off"]),
    disabledTools: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(256),
  })
  .strict()
  .superRefine((config, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (config.permissionMode === "unrestricted" && !config.acknowledgeUnrestricted)
      issue("acknowledgeUnrestricted", "Unrestricted mode requires explicit acknowledgement");
    if (config.permissionMode === "bounded" && !config.capabilityManifest)
      issue("capabilityManifest", "Bounded mode requires a capability manifest");
    if (config.capabilityManifest && !config.approveManifest)
      issue("approveManifest", "Review and approve the capability manifest first");
    if (config.idleTimeoutMs > config.sessionTtlMs)
      issue("idleTimeoutMs", "Idle timeout must not exceed session lifetime");
    if (!config.includeScreenshot && !config.includeAccessibilityTree)
      issue("includeScreenshot", "Enable screenshots or the accessibility tree");
  });

export type ComputerConfig = z.infer<typeof ComputerConfigSchema>;
export const DEFAULT_COMPUTER_CONFIG: ComputerConfig = {
  enabled: false,
  permissionMode: "standard",
  acknowledgeUnrestricted: false,
  capabilityManifest: "",
  approveManifest: false,
  requireToolApproval: false,
  timeoutMs: 30000,
  sessionTtlMs: 28800000,
  idleTimeoutMs: 300000,
  deliveryMode: "background",
  includeScreenshot: true,
  includeAccessibilityTree: true,
  maxImageDimension: null,
  maxElements: null,
  maxDepth: null,
  cursorEnabled: null,
  cursorTheme: "cua.default",
  cursorReducedMotion: "auto",
  disabledTools: [],
};

export const COMPUTER_TOOL_PREFIX = "computer_";
/** Unknown native actions require execution permission. */
export const COMPUTER_READ_TOOLS = [
  "status",
  "list_apps",
  "list_windows",
  "get_window_state",
  "get_desktop_state",
  "get_browser_state",
  "get_config",
  "get_agent_cursor_state",
  "get_recording_state",
  "get_screen_size",
  "get_cursor_position",
  "verify_state",
].map((name) => `${COMPUTER_TOOL_PREFIX}${name}`);

export interface ComputerProbe {
  ok: boolean;
  tools: Array<{ name: string; description: string }>;
  health?: unknown;
  error?: string;
}
