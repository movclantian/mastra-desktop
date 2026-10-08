import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { createGateway, generateImage, experimental_generateVideo as generateVideo } from "ai";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import { generatedMediaSchema } from "../../shared/agent-contract";
import { providerCredentialPurpose } from "../../shared/credential-contract";
import { resolveCredential } from "../credential-broker";
import { getProvidersConfig } from "../models/providers";
import { getAssetFile } from "../rag/storage/assets";
import {
  contentObjectReference,
  putContentObject,
  readContentObject,
} from "../storage/content-objects";
import { userIdFromContext } from "../storage/database";
import { WORKSPACE_THREAD_ID_CONTEXT_KEY } from "../workspace/workspace-manager";

/** Generation is a native tool call: preserve its status, cancellation and saved result. */
export async function resolveMediaTools(resourceId?: string): Promise<ToolsInput> {
  if (!resourceId) return {};
  const { providers } = await getProvidersConfig(resourceId);
  const tools: ToolsInput = {};
  for (const kind of ["image", "video"] as const) {
    const models = providers
      .filter(
        (provider) =>
          !provider.disabled &&
          (provider.protocol === "gateway" || provider.registryId === "vercel"),
      )
      .flatMap((provider) =>
        provider.enabledModels
          .filter((model) => model.kind === kind)
          .map((model) => ({
            id: `${provider.id}/${model.id}`,
            providerId: provider.id,
            modelId: model.id,
            name: `${provider.name}: ${model.name || model.id}`,
          })),
      );
    if (!models.length) continue;
    const name = `generate_${kind}`;
    tools[name] = createTool({
      id: name,
      description: `Generate ${kind}s from the user's prompt and save the actual files. Available models: ${models.map((model) => `${model.id} (${model.name})`).join(", ")}. Use this tool directly. Generation can take several minutes. Do not repeat a completed generation unless the user requests another version.`,
      inputSchema: z
        .object({
          model: z.enum(models.map((model) => model.id) as [string, ...string[]]),
          prompt: z.string().trim().min(1).max(32_000),
          referenceImages: z
            .array(
              z.union([
                z.object({ assetId: z.string().min(1) }).strict(),
                z.object({ objectId: z.uuid(), threadId: z.string().min(1) }).strict(),
              ]),
            )
            .max(4)
            .default([])
            .describe(
              "Reference user-uploaded library images by assetId, or previously generated images by objectId and threadId. For videos, at most two images: first frame, then last frame.",
            ),
          n: z.number().int().min(1).max(4).default(1),
          aspectRatio: z
            .string()
            .regex(/^\d+:\d+$/)
            .optional()
            .describe("Only when the selected model supports aspect ratios."),
          size: z
            .string()
            .regex(/^\d+x\d+$/)
            .optional()
            .describe("Image dimensions supported by the model, e.g. 1024x1024. Images only."),
          duration: z
            .number()
            .int()
            .positive()
            .max(60)
            .optional()
            .describe("Video duration in seconds, only when supported."),
          resolution: z
            .string()
            .regex(/^\d+x\d+$/)
            .optional()
            .describe("Video resolution, only when supported."),
          seed: z.number().int().nonnegative().optional(),
        })
        .superRefine((input, context) => {
          if (kind === "video" && input.referenceImages.length > 2)
            context.addIssue({
              code: "custom",
              message: "Videos accept a first frame and an optional last frame.",
            });
          if (
            (kind === "image" &&
              (input.duration !== undefined || input.resolution !== undefined)) ||
            (kind === "video" && input.size !== undefined)
          )
            context.addIssue({
              code: "custom",
              message: "Use size for images; duration and resolution for videos.",
            });
          if (input.size && input.aspectRatio)
            context.addIssue({ code: "custom", message: "Choose either size or aspectRatio." });
        }),
      outputSchema: generatedMediaSchema,
      execute: async (input, context) => {
        const userId = userIdFromContext(context.requestContext);
        const threadId = context.requestContext?.get(WORKSPACE_THREAD_ID_CONTEXT_KEY);
        if (userId !== resourceId || typeof threadId !== "string" || !threadId)
          throw new Error("Media generation requires the authenticated conversation context");
        const selection = models.find((model) => model.id === input.model);
        const current = await getProvidersConfig(userId);
        const provider = current.providers.find(
          (provider) => provider.id === selection?.providerId,
        );
        if (
          !selection ||
          !provider ||
          provider.disabled ||
          !provider.enabledModels.some(
            (model) => model.id === selection.modelId && model.kind === kind,
          )
        )
          throw new Error("The selected generation model is disabled or no longer configured");
        if (provider.protocol !== "gateway" && provider.registryId !== "vercel")
          throw new Error("Configure the model on an AI SDK Gateway provider for media generation");
        const apiKey = await resolveCredential(
          provider.credentialRef,
          providerCredentialPurpose(provider.id),
        );
        const timeout = kind === "image" ? 180_000 : 600_000;
        const abortSignal = AbortSignal.any([
          AbortSignal.timeout(timeout),
          ...(context.abortSignal ? [context.abortSignal] : []),
        ]);
        abortSignal.throwIfAborted();
        const images = await Promise.all(
          input.referenceImages.map(async (reference) => {
            let bytes: Buffer | null;
            if ("assetId" in reference) {
              const asset = await getAssetFile(userId, reference.assetId);
              if (!asset?.asset.mediaType.startsWith("image/"))
                throw new Error("The reference image is unavailable for the current user");
              if (asset.asset.byteSize > 32 * 1024 * 1024)
                throw new Error("Reference images must be at most 32 MiB");
              bytes = await readFile(asset.path);
            } else {
              bytes = await readContentObject(reference.objectId, {
                userId,
                threadId: reference.threadId,
                kind: "attachment",
              });
            }
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
        const settings = { apiKey, ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}) };
        const gateway = createGateway(settings);
        const common = {
          prompt: input.prompt,
          n: input.n,
          aspectRatio: input.aspectRatio as `${number}:${number}` | undefined,
          seed: input.seed,
          maxRetries: 0,
          abortSignal,
        };
        const result =
          kind === "image"
            ? await generateImage({
                ...common,
                prompt: images.length ? { text: input.prompt, images } : input.prompt,
                model: gateway.image(selection.modelId),
                size: input.size as `${number}x${number}` | undefined,
              })
            : await generateVideo({
                ...common,
                frameImages: images.length
                  ? images.map((image, index) => ({
                      image,
                      frameType: index === 0 ? "first_frame" : "last_frame",
                    }))
                  : undefined,
                model: gateway.video(selection.modelId),
                duration: input.duration,
                resolution: input.resolution as `${number}x${number}` | undefined,
                poll: { timeoutMs: timeout },
              });
        const generated = "images" in result ? result.images : result.videos;
        abortSignal.throwIfAborted();
        const files = await Promise.all(
          generated.map(async (file, index) => {
            if (!file.mediaType.startsWith(`${kind}/`))
              throw new Error("The provider returned an unexpected media type");
            const saved = await putContentObject(file.uint8Array, {
              userId,
              threadId,
              kind: "attachment",
              contentType: file.mediaType,
            });
            const extension = file.mediaType.split("/")[1].replace(/[^a-z0-9]/gi, "") || "bin";
            return {
              ...contentObjectReference(saved),
              kind: "attachment" as const,
              threadId,
              filename: `${kind}-${index + 1}.${extension}`,
            };
          }),
        );
        return {
          model: input.model,
          prompt: input.prompt,
          files,
          warnings: result.warnings.map((warning) => JSON.stringify(warning)),
        };
      },
    });
  }
  return tools;
}

import { readFile } from "node:fs/promises";
