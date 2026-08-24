/**
 * 观察记忆(OM)线程级配置路由:读写线程 metadata 上的 OM 覆盖项。
 * 官方文档:docs/en/docs/memory/observational-memory.mdx。
 */
import { registerApiRoute } from "@mastra/core/server";
import { workError } from "../../errors";
import { appStorage } from "../../storage";
import { getOwnedThread, getWorkMemoryForThread } from "./shared";
import type { ThreadMetadata } from "./types";

const OBSERVATION_NUMBERS = new Set(["messageTokens"]);
const REFLECTION_NUMBERS = new Set(["observationTokens"]);

type OmPhaseInput = Record<string, unknown> & { model?: unknown };

function phaseInput(value: unknown): OmPhaseInput | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as OmPhaseInput)
    : undefined;
}

function numericOverrides(source: OmPhaseInput | undefined, keys: Set<string>) {
  const output: Record<string, number> = {};
  if (!source) return output;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      output[key] = Math.min(2_000_000, Math.round(value));
    }
  }
  return output;
}

function hasOwnModel(phase: OmPhaseInput | undefined): boolean {
  return Boolean(phase && Object.hasOwn(phase, "model"));
}

function normalizedModel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const observationalMemoryConfigRoute = registerApiRoute(
  "/work/threads/:threadId/observational-memory-config",
  {
    method: "GET",
    handler: async (c) => {
      const threadId = c.req.param("threadId");
      const resourceId = c.req.query("resourceId");
      if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
      const memory = await getWorkMemoryForThread(c.get("requestContext"), threadId, resourceId);
      const thread = await getOwnedThread(memory, threadId, resourceId);
      if (!thread) throw workError("THREAD_NOT_FOUND");
      const store = await appStorage.getStore("memory");
      const record = await store?.getObservationalMemory(threadId, resourceId);
      const overrides = (record?.config?._overrides ?? {}) as {
        observation?: Record<string, unknown>;
        reflection?: Record<string, unknown>;
      };
      const metadata = (thread.metadata ?? {}) as ThreadMetadata;
      return c.json({
        config: {
          observation: {
            ...numericOverrides(
              overrides.observation as OmPhaseInput | undefined,
              OBSERVATION_NUMBERS,
            ),
            ...(metadata.observerModelId ? { model: metadata.observerModelId } : {}),
          },
          reflection: {
            ...numericOverrides(
              overrides.reflection as OmPhaseInput | undefined,
              REFLECTION_NUMBERS,
            ),
            ...(metadata.reflectorModelId ? { model: metadata.reflectorModelId } : {}),
          },
        },
      });
    },
  },
);

export const updateObservationalMemoryConfigRoute = registerApiRoute(
  "/work/threads/:threadId/observational-memory-config",
  {
    method: "PUT",
    handler: async (c) => {
      const threadId = c.req.param("threadId");
      const body = (await c.req.json()) as { resourceId?: string; config?: unknown };
      if (!body.resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
      const config = phaseInput(body.config);
      const observation = phaseInput(config?.observation);
      const reflection = phaseInput(config?.reflection);
      const observationNumbers = numericOverrides(observation, OBSERVATION_NUMBERS);
      const reflectionNumbers = numericOverrides(reflection, REFLECTION_NUMBERS);
      const observerModelChanged = hasOwnModel(observation);
      const reflectorModelChanged = hasOwnModel(reflection);
      if (
        Object.keys(observationNumbers).length === 0 &&
        Object.keys(reflectionNumbers).length === 0 &&
        !observerModelChanged &&
        !reflectorModelChanged
      ) {
        return c.json(
          { error: "config must contain supported observation or reflection fields" },
          400,
        );
      }

      const memory = await getWorkMemoryForThread(
        c.get("requestContext"),
        threadId,
        body.resourceId,
      );
      const thread = await getOwnedThread(memory, threadId, body.resourceId);
      if (!thread) throw workError("THREAD_NOT_FOUND");

      if (Object.keys(observationNumbers).length || Object.keys(reflectionNumbers).length) {
        try {
          await memory.updateObservationalMemoryConfig({
            threadId,
            resourceId: body.resourceId,
            config: {
              ...(Object.keys(observationNumbers).length
                ? { observation: observationNumbers }
                : {}),
              ...(Object.keys(reflectionNumbers).length ? { reflection: reflectionNumbers } : {}),
            },
          });
        } catch (error) {
          return c.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Observational Memory is not initialized for this thread",
            },
            409,
          );
        }
      }

      const currentMetadata = (thread.metadata ?? {}) as ThreadMetadata;
      const nextMetadata: ThreadMetadata = { ...currentMetadata };
      if (observerModelChanged) {
        const modelId = normalizedModel(observation?.model);
        if (modelId) nextMetadata.observerModelId = modelId;
        else delete nextMetadata.observerModelId;
      }
      if (reflectorModelChanged) {
        const modelId = normalizedModel(reflection?.model);
        if (modelId) nextMetadata.reflectorModelId = modelId;
        else delete nextMetadata.reflectorModelId;
      }
      if (observerModelChanged || reflectorModelChanged) {
        await memory.updateThread({ id: threadId, title: thread.title, metadata: nextMetadata });
      }

      return c.json({
        ok: true,
        config: {
          observation: {
            ...observationNumbers,
            ...(nextMetadata.observerModelId ? { model: nextMetadata.observerModelId } : {}),
          },
          reflection: {
            ...reflectionNumbers,
            ...(nextMetadata.reflectorModelId ? { model: nextMetadata.reflectorModelId } : {}),
          },
        },
      });
    },
  },
);
