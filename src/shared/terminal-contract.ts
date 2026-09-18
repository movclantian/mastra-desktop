import { z } from "zod";

export const TERMINAL_CREATE_CHANNEL = "terminal:create";
export const TERMINAL_WRITE_CHANNEL = "terminal:write";
export const TERMINAL_RESIZE_CHANNEL = "terminal:resize";
export const TERMINAL_CLOSE_CHANNEL = "terminal:close";
export const TERMINAL_EVENT_CHANNEL = "terminal:event";

export const TerminalSessionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/iu);
const TerminalColsSchema = z.number().int().min(2).max(500);
const TerminalRowsSchema = z.number().int().min(2).max(300);

export const TerminalCreateRequestSchema = z.strictObject({
  cwd: z
    .string()
    .min(1)
    .max(4_096)
    .refine((value) => value.trim() === value && !value.includes("\0"))
    .optional(),
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export const TerminalCreateResultSchema = z.strictObject({ sessionId: TerminalSessionIdSchema });
export const TerminalWriteRequestSchema = z.strictObject({
  sessionId: TerminalSessionIdSchema,
  data: z.string().max(65_536),
});
export const TerminalResizeRequestSchema = z.strictObject({
  sessionId: TerminalSessionIdSchema,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export const TerminalEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("data"),
    sessionId: TerminalSessionIdSchema,
    data: z.string().max(65_536),
  }),
  z.strictObject({
    type: z.literal("exit"),
    sessionId: TerminalSessionIdSchema,
    exitCode: z.number().int().optional(),
    signal: z.number().int().optional(),
  }),
  z.strictObject({
    type: z.literal("error"),
    sessionId: TerminalSessionIdSchema,
    message: z.string().min(1).max(2_048),
  }),
]);

export type TerminalCreateRequest = z.infer<typeof TerminalCreateRequestSchema>;
export type TerminalCreateResult = z.infer<typeof TerminalCreateResultSchema>;
export type TerminalWriteRequest = z.infer<typeof TerminalWriteRequestSchema>;
export type TerminalResizeRequest = z.infer<typeof TerminalResizeRequestSchema>;
export type TerminalEvent = z.infer<typeof TerminalEventSchema>;
