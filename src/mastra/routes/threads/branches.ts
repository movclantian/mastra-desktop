/**
 * 消息分支:编辑重发前的快照、版本列表读取与回滚,记录落在消息 metadata。
 * 消息模型见 docs/en/docs/memory/message-history.mdx。
 */
import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import type { Memory } from "@mastra/memory";
import type { UIMessage } from "ai";
import { removeObservationalMemoryReferences } from "./compact";
import { normalizeChatHistoryMessages } from "./shared";
import type {
  MessageBranchRecord,
  MessageBranchVersion,
  PersistedUIMessage,
  ThreadMetadata,
} from "./types";

type BranchOperation =
  | {
      kind: "edit";
      messageId: string;
      previousUser?: PersistedUIMessage;
      previousAssistant?: PersistedUIMessage;
      /** 旧助手行之后的下游消息 —— 归入旧助手版本的子树快照(tail) */
      previousAssistantTail?: PersistedUIMessage[];
    }
  | {
      kind: "regenerate";
      messageId: string;
      previousAssistant?: PersistedUIMessage;
      previousAssistantTail?: PersistedUIMessage[];
    };

function isPersistedUIMessage(value: unknown): value is PersistedUIMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.id === "string" &&
    (message.role === "user" || message.role === "assistant") &&
    Array.isArray(message.parts)
  );
}

export function snapshot(message: UIMessage | undefined): PersistedUIMessage | undefined {
  if (!message || (message.role !== "user" && message.role !== "assistant")) return undefined;
  return {
    id: message.id,
    role: message.role,
    parts: message.parts,
    ...(message.metadata && typeof message.metadata === "object"
      ? { metadata: message.metadata as Record<string, unknown> }
      : {}),
  };
}

function version(message: PersistedUIMessage): MessageBranchVersion {
  return {
    id: `${message.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    role: message.role,
    message,
    createdAt: new Date().toISOString(),
  };
}

export function readMessageBranches(metadata: ThreadMetadata): Record<string, MessageBranchRecord> {
  const raw = metadata.messageBranches;
  if (!raw || typeof raw !== "object") return {};
  const branches: Record<string, MessageBranchRecord> = {};
  for (const [rootId, candidate] of Object.entries(raw)) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const record = candidate as Partial<MessageBranchRecord>;
    if (record.rootId !== rootId || typeof record.currentVersionId !== "string") continue;
    const versions = Array.isArray(record.versions)
      ? record.versions.filter(
          (item): item is MessageBranchVersion =>
            typeof item === "object" &&
            item !== null &&
            (item as MessageBranchVersion).role !== undefined &&
            typeof (item as MessageBranchVersion).id === "string" &&
            isPersistedUIMessage((item as MessageBranchVersion).message),
        )
      : [];
    // ≥1 而非 ≥2:重试流程会为父用户消息物化单版本分支记录,
    // 里面只有配对信息(pairVersionId),丢掉它会让客户端算不出子回复列表
    if (versions.length >= 1)
      branches[rootId] = { rootId, currentVersionId: record.currentVersionId, versions };
  }
  return branches;
}

function findBranchId(
  branches: Record<string, MessageBranchRecord>,
  messageId: string,
): string | undefined {
  return Object.values(branches).find((branch) =>
    branch.versions.some((item) => item.message?.id === messageId),
  )?.rootId;
}

function upsertBranch(
  branches: Record<string, MessageBranchRecord>,
  rootId: string,
  messages: PersistedUIMessage[],
  activeMessageId: string,
): MessageBranchRecord | undefined {
  const previous = branches[rootId];
  const retained = previous?.versions ?? [];
  const additions = messages.flatMap((message) => {
    const duplicate = retained.find(
      (item) =>
        item.message?.role === message.role &&
        JSON.stringify(item.message.parts) === JSON.stringify(message.parts) &&
        JSON.stringify(item.message.metadata) === JSON.stringify(message.metadata),
    );
    return duplicate ? [] : [version(message)];
  });
  const versions = [...retained, ...additions];
  const active =
    [...versions].reverse().find((item) => item.message?.id === activeMessageId) ?? versions.at(-1);
  if (!active) return undefined;
  const record = { rootId, currentVersionId: active.id, versions };
  branches[rootId] = record;
  return record;
}

/** 把两条分支记录的当前版本互相配对(编辑=同轮生成;重试=新助手版本挂到父用户版本)。 */
function linkActiveVersions(
  userBranch: MessageBranchRecord | undefined,
  assistantBranch: MessageBranchRecord | undefined,
) {
  if (!userBranch || !assistantBranch) return;
  const userVersion = userBranch.versions.find((item) => item.id === userBranch.currentVersionId);
  const assistantVersion = assistantBranch.versions.find(
    (item) => item.id === assistantBranch.currentVersionId,
  );
  if (!userVersion || !assistantVersion) return;
  userVersion.pairVersionId = assistantVersion.id;
  assistantVersion.pairVersionId = userVersion.id;
}

/** 找到某条消息之前最近的用户消息 id(定位重试流程的父消息)。 */
function findPrecedingUserId(messages: UIMessage[], messageId: string): string | undefined {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return messages[i].id;
  }
  return undefined;
}

/** 按 message id + 内容定位版本(用户编辑版本复用同一 message id,须比对 parts)。 */
function findVersionByMessage(
  versions: MessageBranchVersion[],
  message: PersistedUIMessage,
): MessageBranchVersion | undefined {
  return versions.find(
    (item) =>
      item.message?.id === message.id &&
      JSON.stringify(item.message.parts) === JSON.stringify(message.parts),
  );
}

async function recalledMessages(memory: Memory, threadId: string, resourceId?: string) {
  const { messages } = await memory.recall({
    threadId,
    ...(resourceId ? { resourceId } : {}),
    perPage: false,
  });
  // Task signals stay out of branch indexing; session user signals are real
  // user turns and are normalized back into the chat history.
  const chatMessages = normalizeChatHistoryMessages(messages ?? []);
  return toAISdkMessages(chatMessages, { version: "v7" }) as UIMessage[];
}

/**
 * AI SDK 的编辑/重试在客户端把截断点之后的消息从请求里剔除,但 Memory 管线
 * 只会 upsert(同 id 覆盖)与追加新消息,不会删除持久化的旧尾巴 —— 不删的话
 * 流结束后 reload,旧时间线的消息全部回来,叠在新回复下面(多轮编辑 bug;
 * 旧助手回复之所以"看起来"没重复,只是被 projectBranchMessages 的非当前
 * 版本投影藏住了,无分支记录的用户消息藏不住)。分支版本里留有快照,
 * 物理删除不丢可切换的历史。
 */
async function deletePersistedTail(
  memory: Memory,
  messages: UIMessage[],
  startIndex: number,
  threadId?: string,
  resourceId?: string,
) {
  const tailIds = messages
    .slice(startIndex)
    .map((message) => message.id)
    .filter((id): id is string => typeof id === "string");
  if (tailIds.length === 0) return;
  let restoreObservations: (() => Promise<void>) | undefined;
  try {
    await memory.settled();
    if (threadId && resourceId) {
      restoreObservations = await removeObservationalMemoryReferences(
        memory,
        threadId,
        resourceId,
        tailIds,
      );
    }
    await memory.deleteMessages(tailIds);
  } catch {
    await restoreObservations?.();
    // 删除失败不阻断本轮对话:退回旧行为(尾巴残留,由分支投影隐藏)
  }
  await memory.settled().catch(() => undefined);
}

/** Capture the persisted version before AI SDK truncates an edit/regenerate request. */
export async function prepareMessageBranchOperation(options: {
  memory: Memory;
  threadId?: string;
  resourceId?: string;
  trigger?: unknown;
  messageId?: unknown;
  requestMessages?: UIMessage[];
}): Promise<BranchOperation | undefined> {
  if (!options.threadId || typeof options.messageId !== "string") return undefined;
  if (options.trigger !== "regenerate-message" && options.trigger !== "submit-message")
    return undefined;
  const messages = await recalledMessages(options.memory, options.threadId, options.resourceId);
  const index = messages.findIndex((message) => message.id === options.messageId);

  // 投影注入的消息(物理行已被分支切换/编辑隔离,只剩版本快照):重试它时
  // Memory 里找不到行 —— 不处理的话既不截断旧时间线也不建分支记录,新回复
  // 追加后新旧消息在前端并存。回退到分支快照还原操作上下文:截断点 =
  // 父用户行(物理存在)之后,旧助手行本身已不存在,由版本快照负责
  if (index < 0 && options.trigger === "regenerate-message") {
    const fallback = await prepareInjectedRegenerate(options, options.messageId, messages);
    if (fallback) return fallback;
  }
  if (index < 0) return undefined;

  if (options.trigger === "regenerate-message") {
    const previousAssistant = snapshot(messages[index]);
    if (previousAssistant?.role !== "assistant") return undefined;
    // 重试截断点含被重试的旧助手消息本身(客户端请求也不含它,新回复是全新 id);
    // 旧助手行之后的下游消息快照进它的版本 tail,切回时可整条时间线恢复
    const previousAssistantTail = snapshotAll(messages.slice(index + 1));
    await deletePersistedTail(
      options.memory,
      messages,
      index,
      options.threadId,
      options.resourceId,
    );
    return {
      kind: "regenerate",
      messageId: options.messageId,
      previousAssistant,
      previousAssistantTail,
    };
  }

  // `requestMessages` already contains the edited replacement in AI SDK's
  // submit-message payload. The previous version must therefore always come
  // from persisted Memory, before handleChatStream truncates and saves the
  // edit; otherwise both branch versions would contain the new text.
  const previousUser = snapshot(messages[index]);
  if (previousUser?.role !== "user") return undefined;
  const followingMessages = messages.slice(index + 1);
  const previousAssistantIndex = followingMessages.findIndex(
    (message) => message.role === "assistant",
  );
  const previousAssistant =
    previousAssistantIndex >= 0 ? followingMessages[previousAssistantIndex] : undefined;
  const previousAssistantTail =
    previousAssistantIndex >= 0
      ? snapshotAll(followingMessages.slice(previousAssistantIndex + 1))
      : [];
  // 编辑截断点在被编辑消息之后(它本身同 id upsert 原位更新,不能删)
  await deletePersistedTail(options.memory, messages, index + 1);
  return {
    kind: "edit",
    messageId: options.messageId,
    previousUser,
    previousAssistant: snapshot(previousAssistant),
    previousAssistantTail,
  };
}

/**
 * 重试"仅存在于分支快照中"的助手消息:从线程元数据找到该版本,以它的
 * 父用户行为截断锚点,把当前 Memory 里它之后的旧时间线隔离进该版本的 tail。
 */
async function prepareInjectedRegenerate(
  options: {
    memory: Memory;
    threadId?: string;
    resourceId?: string;
    messageId?: unknown;
  },
  messageId: string,
  messages: UIMessage[],
): Promise<BranchOperation | undefined> {
  const threadId = options.threadId;
  if (!threadId) return undefined;
  const thread = await options.memory.getThreadById({ threadId });
  if (!thread) return undefined;
  const branches = readMessageBranches((thread.metadata ?? {}) as ThreadMetadata);
  let injected: MessageBranchVersion | undefined;
  for (const branch of Object.values(branches)) {
    injected = branch.versions.find(
      (item) => item.message?.id === messageId && item.role === "assistant",
    );
    if (injected) break;
  }
  if (!injected?.message) return undefined;

  // 父用户行(配对版本指向的消息)物理存在,作为截断锚点
  let parentMessageId: string | undefined;
  for (const branch of Object.values(branches)) {
    const parent = branch.versions.find((item) => item.id === injected?.pairVersionId);
    if (parent?.message) {
      parentMessageId = parent.message.id;
      break;
    }
  }
  const parentIndex = parentMessageId
    ? messages.findIndex((message) => message.id === parentMessageId && message.role === "user")
    : -1;
  if (parentIndex < 0) return undefined;

  const previousAssistantTail = snapshotAll(messages.slice(parentIndex + 1));
  await deletePersistedTail(
    options.memory,
    messages,
    parentIndex + 1,
    options.threadId,
    options.resourceId,
  );
  return {
    kind: "regenerate",
    messageId,
    previousAssistant: injected.message,
    previousAssistantTail,
  };
}

function snapshotAll(messages: UIMessage[]): PersistedUIMessage[] {
  return messages
    .map((message) => snapshot(message))
    .filter((item): item is PersistedUIMessage => !!item);
}

/** Persist branch versions after the Agent's normal Memory pipeline has saved its new assistant message. */
export async function persistMessageBranchOperation(options: {
  memory: Memory;
  threadId?: string;
  resourceId?: string;
  operation?: BranchOperation;
  requestMessages: UIMessage[];
  responseMessageId?: string;
}) {
  if (!options.threadId || !options.operation) return;
  await options.memory.settled();
  const thread = await options.memory.getThreadById({ threadId: options.threadId });
  if (!thread) return;
  const metadata = (thread.metadata ?? {}) as ThreadMetadata;
  const branches = readMessageBranches(metadata);
  const current = await recalledMessages(options.memory, options.threadId, options.resourceId);
  const newestAssistant =
    (options.responseMessageId
      ? current.find((message) => message.id === options.responseMessageId)
      : undefined) ?? [...current].reverse().find((message) => message.role === "assistant");

  if (options.operation.kind === "regenerate") {
    const previous = options.operation.previousAssistant;
    const next = snapshot(newestAssistant);
    if (
      !previous ||
      !next ||
      (next.id === previous.id &&
        JSON.stringify(next.parts) === JSON.stringify(previous.parts) &&
        JSON.stringify(next.metadata) === JSON.stringify(previous.metadata))
    )
      return;
    const rootId = findBranchId(branches, previous.id) ?? previous.id;
    const assistantBranch = upsertBranch(branches, rootId, [previous, next], next.id);

    // 重试不改用户消息:把新助手版本配对到触发重试的父用户版本。
    // 父用户消息可能从未编辑过(没有分支记录),物化一个单版本记录,
    // 让"子回复列表"始终能用版本 id 关联
    const parentUserId = findPrecedingUserId(current, next.id);
    let parentRootId = parentUserId ? findBranchId(branches, parentUserId) : undefined;
    if (parentUserId && !parentRootId) {
      const parentUserMessage = current.find((message) => message.id === parentUserId);
      const parentUserSnapshot = snapshot(parentUserMessage);
      if (parentUserSnapshot?.role === "user") {
        parentRootId = parentUserId;
        upsertBranch(branches, parentRootId, [parentUserSnapshot], parentUserSnapshot.id);
      }
    }
    const parentBranch = parentRootId ? branches[parentRootId] : undefined;
    linkActiveVersions(parentBranch, assistantBranch);

    // 首次建档时,被重试的旧助手版本与父用户版本也是一对父子,补上配对
    const previousAssistantVersion = assistantBranch
      ? findVersionByMessage(assistantBranch.versions, previous)
      : undefined;
    const parentVersion = parentBranch?.versions.find(
      (item) => item.id === parentBranch.currentVersionId,
    );
    if (previousAssistantVersion && parentVersion && !previousAssistantVersion.pairVersionId) {
      previousAssistantVersion.pairVersionId = parentVersion.id;
    }
    // 被删掉的下游时间线归入旧助手版本:切回这个版本时整条恢复
    if (previousAssistantVersion && options.operation.previousAssistantTail) {
      previousAssistantVersion.tail = options.operation.previousAssistantTail;
    }
  } else {
    const previousUser = options.operation.previousUser;
    const currentUser = snapshot(
      options.requestMessages.find((message) => message.id === options.operation?.messageId),
    );
    if (!previousUser || !currentUser) return;
    const userRootId = findBranchId(branches, previousUser.id) ?? previousUser.id;
    const userBranch = upsertBranch(
      branches,
      userRootId,
      [previousUser, currentUser],
      currentUser.id,
    );

    const previousAssistant = options.operation.previousAssistant;
    const nextAssistant = snapshot(newestAssistant);
    let assistantBranch: MessageBranchRecord | undefined;
    if (previousAssistant && nextAssistant && previousAssistant.id !== nextAssistant.id) {
      const assistantRootId = findBranchId(branches, previousAssistant.id) ?? previousAssistant.id;
      assistantBranch = upsertBranch(
        branches,
        assistantRootId,
        [previousAssistant, nextAssistant],
        nextAssistant.id,
      );
    }
    // 编辑 = 同一轮生成的用户/助手新版本互相配对,切换一侧可同步另一侧
    linkActiveVersions(userBranch, assistantBranch);

    // 首次建档时,旧用户版本与旧助手版本(被编辑前的原文与原回复)同样是一对
    // 父子,补上配对;已配对的(后续编辑/重试产生的)不动
    const previousUserVersion =
      userBranch && findVersionByMessage(userBranch.versions, previousUser);
    const previousAssistantVersion =
      assistantBranch && previousAssistant
        ? findVersionByMessage(assistantBranch.versions, previousAssistant)
        : undefined;
    if (
      previousUserVersion &&
      previousAssistantVersion &&
      !previousUserVersion.pairVersionId &&
      !previousAssistantVersion.pairVersionId
    ) {
      previousUserVersion.pairVersionId = previousAssistantVersion.id;
      previousAssistantVersion.pairVersionId = previousUserVersion.id;
    }
    // 被删掉的下游时间线归入旧助手版本:切回这个版本时整条恢复
    if (previousAssistantVersion && options.operation.previousAssistantTail) {
      previousAssistantVersion.tail = options.operation.previousAssistantTail;
    }
  }

  await options.memory.updateThread({
    id: options.threadId,
    title: thread.title,
    metadata: { ...metadata, messageBranches: branches },
  });
}
