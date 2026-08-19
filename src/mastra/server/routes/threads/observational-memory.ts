import { registerApiRoute } from "@mastra/core/server";
import { appStorage } from "../../../storage";
import { getOwnedThread, getWorkMemory } from "./shared";

const ALLOWED_KEYS = new Set([
  "messageTokens",
  "maxTokensPerBatch",
  "observationTokens",
  "bufferTokens",
]);

function normalizeConfig(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ALLOWED_KEYS) {
    const value = source[key];
    if (value === false) {
      output[key] = false;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      output[key] = Math.min(2_000_000, Math.round(value));
    }
  }
  return output;
}

function splitConfig(config: Record<string, unknown>) {
  const observation: Record<string, unknown> = {};
  const reflection: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "observationTokens") reflection[key] = value;
    else observation[key] = value;
  }
  return {
    ...(Object.keys(observation).length > 0 ? { observation } : {}),
    ...(Object.keys(reflection).length > 0 ? { reflection } : {}),
  };
}

export const observationalMemoryConfigRoute = registerApiRoute(
  "/work/threads/:threadId/observational-memory-config",
  {
    method: "GET",
    handler: async (c) => {
      const threadId = c.req.param("threadId");
      const resourceId = c.req.query("resourceId");
      if (!resourceId) return c.json({ error: "resourceId is required" }, 400);
      const memory = await getWorkMemory();
      if (!(await getOwnedThread(memory, threadId, resourceId))) {
        return c.json({ error: "Thread not found" }, 404);
      }
      const store = await appStorage.getStore("memory");
      const record = await store?.getObservationalMemory(threadId, resourceId);
      return c.json({ config: record?.config ?? {} });
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
      if (!body.resourceId) return c.json({ error: "resourceId is required" }, 400);
      const memory = await getWorkMemory();
      if (!(await getOwnedThread(memory, threadId, body.resourceId))) {
        return c.json({ error: "Thread not found" }, 404);
      }
      const config = normalizeConfig(body.config);
      if (Object.keys(config).length === 0) {
        return c.json({ error: "config must contain a supported numeric field" }, 400);
      }
      try {
        await memory.updateObservationalMemoryConfig({
          threadId,
          resourceId: body.resourceId,
          config: splitConfig(config),
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
      return c.json({ ok: true, config });
    },
  },
);
