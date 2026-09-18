import { z } from "zod";
import { DirectoryPathSchema } from "./filesystem-contract";

export const WORKSPACE_CHANNELS = {
  detectIdes: "workspace:detect-ides",
  openInApp: "workspace:open-in-app",
  openExternal: "workspace:open-external",
} as const;

export const WorkspaceAppSchema = z.enum(["vscode", "terminal", "explorer"]);

export const DetectedIdeSchema = z.strictObject({
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
