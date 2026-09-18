import { z } from "zod";

export const FILESYSTEM_CHANNELS = {
  openDirectory: "filesystem:open-directory",
  pickDirectory: "filesystem:pick-directory",
} as const;

export const DirectoryPathSchema = z
  .string()
  .min(1)
  .max(32_767)
  .refine(
    (value) =>
      value.trim() === value && !value.includes("\0") && /^(?:[a-z]:[\\/]|\\\\|\/)/iu.test(value),
    "invalid absolute directory path",
  );

export const OpenDirectoryRequestSchema = DirectoryPathSchema;
export const OpenDirectoryResultSchema = z.string().max(4_096);
export const PickDirectoryRequestSchema = z.undefined();
export const PickDirectoryResultSchema = z.union([z.literal(""), DirectoryPathSchema]);
