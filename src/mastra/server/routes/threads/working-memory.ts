/**
 * 工作记忆路由。
 * working-memory.mdx:thread.metadata.workingMemory 携带当前值(resource scope 亦然)。
 */
import { registerApiRoute } from "@mastra/core/server";
import { workError } from "../../../errors";
import { getOwnedThread, getWorkMemory } from "./shared";

// GET /work/threads/:threadId/working-memory?resourceId= — 读取工作记忆
export const getWorkingMemoryRoute = registerApiRoute("/work/threads/:threadId/working-memory", {
  method: "GET",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const resourceId = c.req.query("resourceId");
    if (!resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    const memory = await getWorkMemory();
    if (!(await getOwnedThread(memory, threadId, resourceId))) {
      throw workError("THREAD_NOT_FOUND");
    }
    const workingMemory = (await memory.getWorkingMemory({ threadId, resourceId })) ?? "";
    return c.json({ workingMemory, threadId });
  },
});

// PUT /work/threads/:threadId/working-memory — 更新工作记忆
// 官方 API:Memory.updateWorkingMemory()(docs/en/docs/memory/working-memory.mdx)
export const updateWorkingMemoryRoute = registerApiRoute("/work/threads/:threadId/working-memory", {
  method: "PUT",
  handler: async (c) => {
    const threadId = c.req.param("threadId");
    const body = (await c.req.json()) as { resourceId?: string; workingMemory: string };
    if (typeof body.workingMemory !== "string") {
      throw workError("WORKING_MEMORY_REQUIRED");
    }
    if (!body.resourceId) throw workError("VALIDATION_RESOURCE_ID_REQUIRED");
    const memory = await getWorkMemory();
    if (!(await getOwnedThread(memory, threadId, body.resourceId))) {
      throw workError("THREAD_NOT_FOUND");
    }
    await memory.updateWorkingMemory({
      threadId,
      resourceId: body.resourceId,
      workingMemory: body.workingMemory,
    });
    return c.json({ ok: true });
  },
});
