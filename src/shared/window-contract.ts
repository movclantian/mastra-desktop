import { z } from "zod";

export const WINDOW_CHANNELS = {
  setMinimumWidth: "window:set-minimum-width",
  showMenu: "window:show-menu",
} as const;

export const SetMinimumWidthRequestSchema = z.number().finite().positive().max(32_767);

export const ShowWindowMenuRequestSchema = z.strictObject({
  x: z.number().finite().min(0).max(32_767),
  y: z.number().finite().min(0).max(32_767),
  items: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        label: z.string().trim().min(1).max(128),
      }),
    )
    .min(1)
    .max(20),
});
export type ShowWindowMenuRequest = z.infer<typeof ShowWindowMenuRequestSchema>;
