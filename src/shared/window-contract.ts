import { z } from "zod";

export const WINDOW_CHANNELS = {
  control: "window:control",
  getState: "window:get-state",
  stateChanged: "window:state-changed",
  setMinimumWidth: "window:set-minimum-width",
  getSettings: "window:get-settings",
  updateSettings: "window:update-settings",
  notify: "window:notify",
  notificationClick: "window:notification-click",
  computerPermissions: "window:computer-permissions",
} as const;

export const WindowControlActionSchema = z.enum(["minimize", "toggleMaximize", "close"]);
export type WindowControlAction = z.infer<typeof WindowControlActionSchema>;
export const WindowStateSchema = z.object({
  maximized: z.boolean(),
  fullscreen: z.boolean(),
});
export type WindowState = z.infer<typeof WindowStateSchema>;

export const SetMinimumWidthRequestSchema = z.number().finite().positive().max(32_767);

export const ComputerPermissionActionSchema = z.enum(["status", "request"]);
export const ComputerPermissionsSchema = z.object({
  supported: z.boolean(),
  accessibility: z.boolean(),
  screenRecording: z.boolean(),
});

export const DesktopPreferencesSchema = z
  .object({
    showWorkDetails: z.boolean(),
    scheduledTaskNotifications: z.boolean(),
    desktopNotifications: z.boolean(),
    openLocalLinksInBrowser: z.boolean(),
  })
  .strict();
export const DEFAULT_DESKTOP_PREFERENCES = {
  showWorkDetails: false,
  scheduledTaskNotifications: false,
  desktopNotifications: false,
  openLocalLinksInBrowser: true,
} satisfies z.infer<typeof DesktopPreferencesSchema>;
export const DesktopSettingsSchema = DesktopPreferencesSchema.extend({
  launchAtLogin: z.boolean(),
  launchAtLoginSupported: z.boolean(),
  notificationsSupported: z.boolean(),
});
export const DesktopSettingsPatchSchema = DesktopPreferencesSchema.extend({
  launchAtLogin: z.boolean(),
}).partial();
export type DesktopSettingsPatch = z.infer<typeof DesktopSettingsPatchSchema>;
export const DesktopNotificationSchema = z
  .object({
    id: z.string().min(1).max(256),
    resourceId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256),
    kind: z.enum(["task", "schedule"]),
    title: z.string().min(1).max(256),
    body: z.string().max(500),
  })
  .strict();
export type DesktopNotification = z.infer<typeof DesktopNotificationSchema>;

/** Local development URLs belong in the workbench; external web links keep the OS default. */
export function isLocalWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" ||
        url.hostname.endsWith(".localhost") ||
        url.hostname === "[::1]" ||
        url.hostname === "0.0.0.0" ||
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname))
    );
  } catch {
    return false;
  }
}

export const FONT_STYLES_ORIGIN = "https://fonts.googleapis.com";
export const FONT_FILES_ORIGIN = "https://fonts.gstatic.com";
export const FONT_STYLESHEET_URL = `${FONT_STYLES_ORIGIN}/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Cinzel:wght@400..800&family=Cormorant+Garamond:ital,wght@0,400..700;1,400..700&family=Noto+Serif+SC:wght@400..700&family=Nunito:wght@400..800&family=Orbitron:wght@400..900&family=Plus+Jakarta+Sans:wght@400..800&family=Press+Start+2P&family=Rajdhani:wght@400..700&family=Shippori+Mincho:wght@400;600;700&family=Silkscreen:wght@400;700&family=Space+Grotesk:wght@400..700&family=Space+Mono:wght@400;700&family=VT323&display=swap`;
