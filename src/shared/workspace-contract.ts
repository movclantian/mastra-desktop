import { z } from "zod";
import { DirectoryPathSchema } from "./filesystem-contract";

export const MAX_TEXT_DOCUMENT_BYTES = 1024 * 1024;
export const TextDocumentFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[^/\\]+\.(?:md|markdown|txt|csv)$/i)
  .refine((name) => [...name].every((character) => character.charCodeAt(0) >= 32));

export const INLINE_COMPLETION_LIMITS = {
  prefix: 1_000,
  beforeContext: 12_000,
  afterContext: 8_000,
} as const;

export const WORKSPACE_CHANNELS = {
  detectIdes: "workspace:detect-ides",
  openInApp: "workspace:open-in-app",
  openExternal: "workspace:open-external",
} as const;

const WorkspaceTabDragSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("terminal"),
    kind: z.literal("terminal"),
    id: z.string().min(1),
    title: z.string(),
  }),
  z.strictObject({
    source: z.literal("workspace"),
    kind: z.enum(["files", "changes", "chat", "terminal"]),
    id: z.string().min(1),
    title: z.string(),
  }),
]);

export function parseWorkspaceTabDrag(raw: string) {
  try {
    return WorkspaceTabDragSchema.safeParse(JSON.parse(raw)).data;
  } catch {
    return undefined;
  }
}

const WorkspaceAppSchema = z.enum(["vscode", "terminal", "explorer"]);

const DetectedIdeSchema = z.strictObject({
  id: WorkspaceAppSchema,
  name: z.string().min(1).max(128),
  command: z.string().min(1).max(32_767),
  category: z.enum(["ide", "system"]),
});

export const DetectIdesRequestSchema = z.undefined();
export const DetectIdesResultSchema = z.array(DetectedIdeSchema).max(32);

export const OpenInAppRequestSchema = z.strictObject({
  app: WorkspaceAppSchema,
  targetPath: DirectoryPathSchema,
});
export const OpenInAppResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), error: z.string().min(1).max(4_096) }),
]);

export const ExternalUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }, "invalid external URL");

export const OpenExternalRequestSchema = ExternalUrlSchema;
export const OpenExternalResultSchema = z.undefined();

export type DetectedIde = z.infer<typeof DetectedIdeSchema>;
export type WorkspaceApp = z.infer<typeof WorkspaceAppSchema>;
export type OpenInAppRequest = z.infer<typeof OpenInAppRequestSchema>;
