import { z } from "zod";
import { DirectoryPathSchema } from "./filesystem-contract";

export const STORAGE_CHANNELS = {
  migrate: "storage:migrate",
  reset: "storage:reset",
} as const;

export const MigrateStorageRequestSchema = DirectoryPathSchema;
export const MigrateStorageResultSchema = z.boolean();
export const ResetAppDataRequestSchema = z.undefined();
export const ResetAppDataResultSchema = z.boolean();
