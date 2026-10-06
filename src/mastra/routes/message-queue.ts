import type { Session } from "@mastra/core/agent-controller";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";
import { type ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { z } from "zod";
import { messageQueueActionSchema, type QueuedMessage } from "../../shared/agent-contract";
import { AGENT_PROFILE_CONTEXT_KEY, getAgentProfile } from "../agents/custom";
import { errorText, workError } from "../errors";
import {
  prepareWorkbenchMessage,
  sessionFor,
  workbenchMessageOptionsSchema,
} from "./session-context";
import { assertNoActiveTeamRun } from "./team-runs";

type Options = z.infer<typeof workbenchMessageOptionsSchema>;
interface QueueEntry {
  view: QueuedMessage;
  options: Options;
  unsubscribe?: () => void;
}

// Mastra owns FIFO ordering, activation and cancellation. Editable rows follow its
// pending count, not acceptance: accepted resolves while a message is still queued.
const queues = new WeakMap<Session, Map<string, QueueEntry>>();
function queueFor(session: Session) {
  let queue = queues.get(session);
  if (!queue) {
    queue = new Map();
    queues.set(session, queue);
  }
  return queue;
}
export function getSessionMessageQueue(session: Session): QueuedMessage[] {
  return [...queueFor(session).values()].map(({ view }) => ({ ...view }));
}
async function prepareQueueMessage(c: ContextWithMastra, text: string, options: Options) {
  const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
  const threadId = c.req.param("threadId");
  if (!threadId) throw workError("VALIDATION_FAILED", { text: "threadId is required" });
  if (!(text.trim() || options.files?.length || options.skillNames?.length))
    throw workError("SESSION_INPUT_REQUIRED");
  await assertNoActiveTeamRun(resourceId, threadId);
  if (options.goal) throw workError("VALIDATION_FAILED", { text: "新目标不接受后续消息排队" });
  const result = await prepareWorkbenchMessage(c, threadId, resourceId, options);
  const profile = await getAgentProfile(
    c.get("requestContext").get(AGENT_PROFILE_CONTEXT_KEY) as string,
    resourceId,
  );
  if (profile.workflow?.strategy === "workflow")
    throw workError("VALIDATION_FAILED", { text: "显式团队流程不接受后续消息排队" });
  const session = result.controllerSession;
  await session.thread.ensureSubscription(threadId, result.agent, c.get("requestContext"));
  session.ensureFollowUpBinding(result.agent, resourceId, threadId);
  const streamOptions = await session.machinery.buildStreamOptions({
    requestContext: c.get("requestContext"),
    // Match native followUp: stopping this turn must not abort future queued turns.
    abortSignal: new AbortController().signal,
  });
  return { ...result, streamOptions, options: { ...options, agentProfileId: profile.id } };
}

function watchAcceptance(session: Session, entry: QueueEntry, accepted: Promise<unknown>) {
  const queue = queueFor(session);
  void accepted.then(
    () => {
      if (queue.get(entry.view.id) !== entry) return;
      if (entry.view.status === "queued") return;
      queue.delete(entry.view.id);
    },
    (error: unknown) => {
      // Cancel/edit/steer already removed the old identity. Never resurrect it.
      if (queue.get(entry.view.id) !== entry) return;
      entry.unsubscribe?.();
      entry.view = { ...entry.view, status: "failed", busy: false, error: errorText(error) };
      session.emit({ type: "follow_up_queued", count: session.displayState.get().queuedFollowUps });
    },
  );
}

function enqueue(result: Awaited<ReturnType<typeof prepareQueueMessage>>, text: string) {
  const {
    controllerSession: session,
    agent,
    threadId,
    resourceId,
    streamOptions,
    options,
  } = result;
  const queueOwnerId = crypto.randomUUID();
  const queued = agent.queueMessage(text.trim() || "请处理附带的资料。", {
    resourceId,
    threadId,
    queueOwnerId,
    ifIdle: { streamOptions },
  });
  const entry: QueueEntry = {
    options: result.options,
    view: {
      id: queued.signal.id,
      text,
      files: (options.files ?? []).map((file) => ({ ...file, type: "file" as const })),
      skills: options.skillNames ?? [],
      fileReferences: options.fileReferences ?? [],
      status: "queued",
      busy: false,
    },
  };
  const queue = queueFor(session);
  queue.set(entry.view.id, entry);
  // 每条消息独立观察原生待执行数量；执行交接或取消后才从展示队列移除。
  entry.unsubscribe = agent.subscribeThreadEvents(
    { resourceId, threadId, queueOwnerId },
    (event) => {
      if (event.type !== "queue-count-changed" || event.count !== 0) return;
      if (queue.get(entry.view.id) === entry) queue.delete(entry.view.id);
      entry.unsubscribe?.();
    },
  );
  // 官方订阅会同步发出基线；空闲线程立即执行时，基线已经是 0。
  if (!queue.has(entry.view.id)) entry.unsubscribe();
  watchAcceptance(session, entry, queued.accepted);
}

const queueMessageRoute = registerApiRoute("/work/threads/:threadId/message-queue", {
  method: "POST",
  handler: async (c) => {
    const body = z
      .object({
        text: z.string().trim().max(100_000),
        options: workbenchMessageOptionsSchema,
      })
      .strict()
      .parse(await c.req.json());
    const result = await prepareQueueMessage(c, body.text, body.options);
    if (queueFor(result.controllerSession).size >= 50)
      throw workError("VALIDATION_FAILED", { text: "最多可保留 50 条排队消息" });
    enqueue(result, body.text);
    return c.json({ requests: getSessionMessageQueue(result.controllerSession) });
  },
});

const queueMessageActionRoute = registerApiRoute(
  "/work/threads/:threadId/message-queue/:messageId",
  {
    method: "POST",
    handler: async (c) => {
      const body = messageQueueActionSchema.parse(await c.req.json());
      const resourceId = c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string;
      const result = await sessionFor(c, {
        resourceId,
        threadId: c.req.param("threadId"),
        scope: "workbench",
      });
      const session = result.controllerSession;
      const queue = queueFor(session);
      const id = c.req.param("messageId");
      const entry = queue.get(id);
      const stale = () =>
        workError("SESSION_MESSAGE_REJECTED", { text: "这条消息已开始执行或正在处理，请刷新队列" });
      if (!entry || entry.view.busy || entry.view.status === "sending") throw stale();
      entry.view.busy = true;
      let withdrawn = false;
      let submitted = false;
      const text = body.action === "edit" ? body.text : entry.view.text;
      try {
        // Validate and prepare before withdrawing: a validation failure leaves the native item intact.
        const prepared =
          body.action === "remove" ? undefined : await prepareQueueMessage(c, text, entry.options);
        if (queue.get(id) !== entry) throw stale();
        if (entry.view.status !== "failed") {
          const { cancelledSignalIds } = result.agent.cancelQueuedMessages({
            resourceId,
            threadId: result.threadId,
            signalIds: [id],
          });
          if (!cancelledSignalIds.includes(id)) throw stale();
        }
        queue.delete(id);
        withdrawn = true;
        if (body.action === "steer") {
          // The native Session.steer implementation is abort + sendMessage. Use
          // its public signal equivalent to track acceptance, not generation completion.
          session.abort();
          const sent = session.sendSignal(
            {
              content: text.trim() || "请处理附带的资料。",
              requestContext: c.get("requestContext"),
            },
            { requireDelivery: true },
          );
          const sending: QueueEntry = {
            options: entry.options,
            view: {
              ...entry.view,
              id: sent.id,
              text,
              status: "sending",
              busy: false,
              error: undefined,
            },
          };
          queue.set(sent.id, sending);
          watchAcceptance(session, sending, sent.accepted);
          submitted = true;
          // Wait only for routing. Generation completion belongs to the native SSE stream.
          // The watcher retains a failed row if routing rejects.
          await sent.accepted.catch(() => undefined);
        } else if (prepared) enqueue(prepared, text);
        submitted = true;
        return c.json({ ok: true });
      } catch (error) {
        if (withdrawn && !submitted && body.action !== "remove") {
          entry.view = { ...entry.view, text, status: "failed", error: errorText(error) };
          queue.set(id, entry);
        }
        throw error;
      } finally {
        entry.view.busy = false;
      }
    },
  },
);

const getQueueRoute = registerApiRoute("/work/threads/:threadId/message-queue", {
  method: "GET",
  handler: async (c) => {
    const result = await sessionFor(c, {
      resourceId: c.get("requestContext").get(MASTRA_RESOURCE_ID_KEY) as string,
      threadId: c.req.param("threadId"),
      scope: "workbench",
    });
    return c.json({ requests: getSessionMessageQueue(result.controllerSession) });
  },
});

export const messageQueueRoutes = [getQueueRoute, queueMessageRoute, queueMessageActionRoute];
