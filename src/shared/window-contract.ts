import { z } from "zod";

export const WINDOW_CHANNELS = {
  setMinimumWidth: "window:set-minimum-width",
} as const;

export const SetMinimumWidthRequestSchema = z.number().finite().positive().max(32_767);
