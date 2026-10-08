import { readFile } from "node:fs/promises";
import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { generateImage, experimental_generateVideo as generateVideo } from "ai";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import { generatedMediaSchema } from "../../shared/agent-contract";
import {
  createProviderMediaModel,
  getProvidersConfig,
  resolveModelSelection,
} from "../models/providers";
import {
  attachAssetReference,
  getAssetFile,
  getLibraryAssetId,
  uploadAssetFromBytes,
} from "../rag/storage/assets";
import { userIdFromContext } from "../storage/database";
import { WORKSPACE_THREAD_ID_CONTEXT_KEY } from "../workspace/workspace-manager";

export const mediaGenerationInputSchema = z
  .object({
    kind: z.enum(["image", "video"]),
    model: z.string().min(1),
    prompt: z.string().trim().min(1).max(32_000),
    referenceImages: z
      .array(z.object({ assetId: z.string().min(1) }).strict())
      .max(4)
      .default([])
      .describe(
        "Library assetIds of uploaded or previously generated images. For videos: first frame, then optional last frame.",
      ),
    n: z.number().int().min(1).max(4).default(1),
    aspectRatio: z
      .string()
      .regex(/^[1-9]\d*:[1-9]\d*$/)
      .optional(),
    size: z
      .string()
      .regex(/^[1-9]\d*x[1-9]\d*$/)
      .optional()
      .describe("Image dimensions supported by the model. Images only."),
    duration: z
      .number()
      .int()
      .positive()
      .max(60)
      .optional()
      .describe("Video duration in seconds, only when supported."),
    resolution: z
      .string()
      .regex(/^[1-9]\d*x[1-9]\d*$/)
      .optional()
      .describe("Video resolution, only when supported."),
    seed: z.number().int().nonnegative().optional(),
  })
  .strict();

type MediaInput = z.infer<typeof mediaGenerationInputSchema>;

/** Resolve only local, owned reference images; never ask a provider to fetch an authenticated URL. */
export function mediaInputFromMessage(
  model: string,
  kind: "image" | "video",
  prompt: string,
  files: Array<{ url: string; mediaType?: string }>,
): MediaInput {
  const referenceImages = [...new Map(files.map((file) => [file.url, file])).values()].map(
    (file) => {
      if (!file.mediaType?.startsWith("image/")) throw new Error("生成模型的参考附件必须是图片");
      const assetId = getLibraryAssetId(file.url);
      if (!assetId) throw new Error("参考图片必须是当前用户资料库中的图片");
      return { assetId };
    },
  );
  const input = mediaGenerationInputSchema.parse({ model, kind, prompt, referenceImages });
  validateGenerationOptions(input);
  return input;
}

function validateGenerationOptions(input: MediaInput) {
  if (input.kind === "video" && input.referenceImages.length > 2)
    throw new Error("视频生成最多接受首帧和尾帧两张参考图片");
  if (
    (input.kind === "image" && (input.duration !== undefined || input.resolution !== undefined)) ||
    (input.kind === "video" && input.size !== undefined)
  )
    throw new Error("图片使用 size；视频使用 duration 和 resolution");
  if (input.size && input.aspectRatio) throw new Error("size 和 aspectRatio 只能选择一个");
}

/** A tool call and a directly selected generation model share one execution/storage path. */
export async function generateMedia(
  input: MediaInput,
  context: { requestContext?: { get(key: string): unknown }; abortSignal?: AbortSignal },
) {
  validateGenerationOptions(input);
  const userId = userIdFromContext(context.requestContext);
  const threadId = context.requestContext?.get(WORKSPACE_THREAD_ID_CONTEXT_KEY);
  if (!userId || typeof threadId !== "string" || !threadId)
    throw new Error("Media generation requires the authenticated conversation context");
  const selection = await resolveModelSelection(input.model, userId);
  if (!selection || selection.model.kind !== input.kind)
    throw new Error("The selected generation model is disabled or no longer configured");
  const selected = await createProviderMediaModel(
    selection.provider,
    selection.model.id,
    input.kind,
  );
  const timeout = input.kind === "image" ? 180_000 : 600_000;
  const abortSignal = AbortSignal.any([
    AbortSignal.timeout(timeout),
    ...(context.abortSignal ? [context.abortSignal] : []),
  ]);
  abortSignal.throwIfAborted();
  const images = await Promise.all(
    input.referenceImages.map(async (reference) => {
      const asset = await getAssetFile(userId, reference.assetId);
      if (!asset?.asset.mediaType.startsWith("image/"))
        throw new Error("The reference image is unavailable for the current user");
      if (asset.asset.byteSize > 32 * 1024 * 1024)
        throw new Error("Reference images must be at most 32 MiB");
      const bytes = await readFile(asset.path);
      if (
        !bytes ||
        bytes.byteLength > 32 * 1024 * 1024 ||
        !(await fileTypeFromBuffer(bytes))?.mime.startsWith("image/")
      )
        throw new Error("A reference must be a supported image of at most 32 MiB");
      return bytes;
    }),
  );
  abortSignal.throwIfAborted();
  const common = {
    prompt: input.prompt,
    n: input.n,
    aspectRatio: input.aspectRatio as `${number}:${number}` | undefined,
    seed: input.seed,
    maxRetries: 0,
    abortSignal,
  };
  const result =
    selected.kind === "image"
      ? await generateImage({
          ...common,
          model: selected.model,
          prompt: images.length ? { text: input.prompt, images } : input.prompt,
          size: input.size as `${number}x${number}` | undefined,
        })
      : await generateVideo({
          ...common,
          model: selected.model,
          frameImages: images.length
            ? images.map((image, index) => ({
                image,
                frameType: index === 0 ? "first_frame" : "last_frame",
              }))
            : undefined,
          duration: input.duration,
          resolution: input.resolution as `${number}x${number}` | undefined,
          poll: { timeoutMs: timeout },
        });
  const generated = "images" in result ? result.images : result.videos;
  abortSignal.throwIfAborted();
  const files = await Promise.all(
    generated.map(async (file, index) => {
      if (!file.mediaType.startsWith(`${input.kind}/`))
        throw new Error("The provider returned an unexpected media type");
      const extension = file.mediaType.split("/")[1].replace(/[^a-z0-9]/gi, "") || "bin";
      const asset = await uploadAssetFromBytes({
        bytes: file.uint8Array,
        resourceId: userId,
        filename: `${input.kind}-${index + 1}.${extension}`,
        mediaType: file.mediaType,
      });
      await attachAssetReference(userId, asset.id, undefined, threadId);
      return {
        assetId: asset.id,
        filename: asset.filename,
        mediaType: asset.mediaType,
        byteSize: asset.byteSize,
      };
    }),
  );
  return generatedMediaSchema.parse({
    model: input.model,
    prompt: input.prompt,
    files,
    warnings: result.warnings.map((warning) => JSON.stringify(warning)),
  });
}

/** Chat agents can use the same enabled media models as ordinary native tools. */
export async function resolveMediaTools(resourceId?: string): Promise<ToolsInput> {
  if (!resourceId) return {};
  const { providers } = await getProvidersConfig(resourceId);
  const tools: ToolsInput = {};
  for (const kind of ["image", "video"] as const) {
    const models = providers
      .filter((provider) => !provider.disabled)
      .flatMap((provider) =>
        provider.enabledModels
          .filter((model) => model.kind === kind)
          .map((model) => ({
            id: `${provider.id}/${model.id}`,
            name: `${provider.name}: ${model.name || model.id}`,
          })),
      );
    if (!models.length) continue;
    const name = `generate_${kind}`;
    tools[name] = createTool({
      id: name,
      description: `Generate ${kind}s from the user's prompt and save the files to the library linked to this conversation. Reuse returned assetIds as referenceImages. Available models: ${models.map((model) => `${model.id} (${model.name})`).join(", ")}. Use this tool directly. Generation can take several minutes. Do not repeat a completed generation unless the user requests another version.`,
      inputSchema: mediaGenerationInputSchema
        .omit({ kind: true })
        .extend({ model: z.enum(models.map((model) => model.id) as [string, ...string[]]) }),
      outputSchema: generatedMediaSchema,
      execute: (input, context) => {
        if (userIdFromContext(context.requestContext) !== resourceId)
          throw new Error("Media generation requires the authenticated conversation context");
        return generateMedia({ ...input, kind }, context);
      },
    });
  }
  return tools;
}
