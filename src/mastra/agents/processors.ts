/**
 * 自定义输入处理器(docs/en/docs/agents/processors.mdx):
 * - libraryAttachmentProcessor:资料库附件 URL → 真实内容注入
 * - editor / terminal / workbench 三条 state lane(computeStateSignal,
 *   docs/en/docs/harness/signals.mdx「State signals」)
 * - agentsMdProcessor:工作区 AGENTS.md 的自动加载与去重
 * - promptCacheProcessor:Anthropic 前缀缓存断点(必须挂在处理器链末尾)
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { InputProcessor, ProcessorActiveStateSignal } from "@mastra/core/processors";
import { z } from "zod";
import {
  getAssetContext,
  getLibraryAssetId,
  LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY,
  LIBRARY_ATTACHMENT_CAPABILITIES_CONTEXT_KEY,
  LIBRARY_RESOURCE_CONTEXT_KEY,
} from "../rag";
import { appStorage } from "../storage";
import { WORKSPACE_PATH_CONTEXT_KEY } from "../workspace";

/**
 * 资料库附件输入处理器 (docs/en/docs/agents/processors.mdx):
 * 在请求到达模型之前,把消息里指向资料库的稳定 URL 解析为真实内容。
 */
/** 未显式传入预算时的默认附件 token 上限。 */
const DEFAULT_ATTACHMENT_TOKEN_BUDGET = 32_000;
/** token → 字符换算系数(OpenAI 经验值,1 token ≈ 3 字符,非精确)。 */
const CHARS_PER_TOKEN_APPROX = 3;
/** 图片/音频附件的 token 估算:每 N 字节计 1 token,且不低于该下限。 */
const IMAGE_BYTES_PER_TOKEN = 1_024;
const AUDIO_BYTES_PER_TOKEN = 512;
const MIN_MEDIA_ATTACHMENT_TOKENS = 1_024;

export const libraryAttachmentProcessor: InputProcessor = {
  id: "library-attachments",
  async processLLMRequest({ prompt, requestContext }) {
    const resourceId = requestContext?.get(LIBRARY_RESOURCE_CONTEXT_KEY) as string | undefined;
    if (!resourceId) return;
    const tokenBudget = requestContext?.get(LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY);
    const capabilities = requestContext?.get(LIBRARY_ATTACHMENT_CAPABILITIES_CONTEXT_KEY) as
      | { vision?: boolean; audio?: boolean }
      | undefined;
    let remainingTokens =
      typeof tokenBudget === "number" ? Math.max(0, tokenBudget) : DEFAULT_ATTACHMENT_TOKEN_BUDGET;
    let changed = false;
    const resolvedPrompt = [...prompt];
    for (let messageIndex = prompt.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = prompt[messageIndex];
      if (message.role !== "user" && message.role !== "assistant") continue;
      const content = [];
      for (const part of message.content) {
        if (part.type !== "file") {
          content.push(part);
          continue;
        }
        const assetId = getLibraryAssetId(part.data);
        if (!assetId) {
          content.push(part);
          continue;
        }
        changed = true;
        const context = await getAssetContext(resourceId, assetId);
        if (!context) {
          content.push({
            type: "text" as const,
            text: `[附件不可用: ${part.filename ?? "未命名附件"}]`,
          });
          continue;
        }
        if (context.text) {
          const availableCharacters = Math.max(
            0,
            Math.floor(remainingTokens * CHARS_PER_TOKEN_APPROX),
          );
          const availableText = context.text.slice(0, availableCharacters);
          remainingTokens = Math.max(
            0,
            remainingTokens - Math.ceil(availableText.length / CHARS_PER_TOKEN_APPROX),
          );
          content.push({
            type: "text" as const,
            text: availableText
              ? `附件「${context.asset.filename}」内容:\n\n${availableText}${availableText.length < context.text.length ? "\n\n[附件内容已按剩余上下文窗口截断]" : ""}`
              : `[附件「${context.asset.filename}」未注入: 当前线程已没有可用的附件上下文预算]`,
          });
          continue;
        }
        if (context.dataUrl) {
          const supported = context.asset.mediaType.startsWith("image/")
            ? capabilities?.vision === true
            : context.asset.mediaType.startsWith("audio/") && capabilities?.audio === true;
          const estimatedTokens = context.asset.mediaType.startsWith("image/")
            ? Math.max(
                MIN_MEDIA_ATTACHMENT_TOKENS,
                Math.ceil(context.asset.byteSize / IMAGE_BYTES_PER_TOKEN),
              )
            : Math.max(
                MIN_MEDIA_ATTACHMENT_TOKENS,
                Math.ceil(context.asset.byteSize / AUDIO_BYTES_PER_TOKEN),
              );
          if (supported && estimatedTokens <= remainingTokens) {
            remainingTokens -= estimatedTokens;
            content.push({
              type: "file" as const,
              data: context.dataUrl,
              filename: context.asset.filename,
              mediaType: context.asset.mediaType,
            });
          } else {
            content.push({
              type: "text" as const,
              text: supported
                ? `[附件「${context.asset.filename}」未注入: 剩余上下文不足]`
                : `[附件「${context.asset.filename}」未注入: 当前模型不支持该原生媒体类型]`,
            });
          }
          continue;
        }
        content.push({
          type: "text" as const,
          text: `[已上传附件: ${context.asset.filename}; 当前格式不能直接发送给模型]`,
        });
      }
      resolvedPrompt[messageIndex] = { ...message, content } as (typeof resolvedPrompt)[number];
    }
    return changed ? { prompt: resolvedPrompt } : undefined;
  },
};

// ---------------------------------------------------------------------------
// 工作台 state lane (docs/en/docs/harness/signals.mdx 的 State signals)
// ---------------------------------------------------------------------------

const terminalStatusSchema = z.enum(["connecting", "ready", "exited", "error"]);

export const workbenchStateSchema = z.object({
  /** 工作区编辑器:等价于 IDE 的「当前打开文件 / 选中项」上下文 */
  editor: z
    .object({
      workspacePath: z.string().optional(),
      openPath: z.string().optional(),
      dirty: z.boolean().optional(),
      selectedPath: z.string().optional(),
    })
    .optional(),
  /** 终端面板:会话数与最近一条命令的结果 */
  terminal: z
    .object({
      open: z.boolean(),
      sessionCount: z.number().int().nonnegative(),
      activeTitle: z.string().optional(),
      activeStatus: terminalStatusSchema.optional(),
      lastCommand: z.string().optional(),
      lastExitCode: z.number().int().optional(),
    })
    .optional(),
  /** 面板可见性:用户此刻的注意力在哪 */
  workbench: z
    .object({
      workspacePanelOpen: z.boolean(),
      workspacePanelTab: z.string().optional(),
      terminalPanelOpen: z.boolean(),
      libraryOpen: z.boolean(),
    })
    .optional(),
});

type WorkbenchState = z.infer<typeof workbenchStateSchema>;
type StateLaneId = keyof WorkbenchState;
type StateLaneValue<K extends StateLaneId> = NonNullable<WorkbenchState[K]>;

const WORKBENCH_STATE_TYPE = "workbench";
const workbenchWrites = new Map<string, Promise<unknown>>();

async function getWorkbenchStateStore() {
  return appStorage.getStore("threadState");
}

function stateThreadId(resourceId: string, threadId: string): string {
  return JSON.stringify([resourceId, threadId]);
}

export async function mergeWorkbenchState(
  resourceId: string,
  threadId: string,
  patch: WorkbenchState,
): Promise<WorkbenchState> {
  const store = await getWorkbenchStateStore();
  const key = stateThreadId(resourceId, threadId);
  const previous = workbenchWrites.get(key) ?? Promise.resolve();
  const next = previous.then(async () => {
    const current =
      (await store?.getState<WorkbenchState>({ threadId: key, type: WORKBENCH_STATE_TYPE })) ?? {};
    const merged = workbenchStateSchema.parse({ ...current, ...patch });
    await store?.setState({ threadId: key, type: WORKBENCH_STATE_TYPE, value: merged });
    return merged;
  });
  workbenchWrites.set(key, next);
  try {
    return await next;
  } finally {
    if (workbenchWrites.get(key) === next) workbenchWrites.delete(key);
  }
}

async function readWorkbenchState(
  resourceId: string,
  threadId: string,
): Promise<WorkbenchState | undefined> {
  const store = await getWorkbenchStateStore();
  return store?.getState<WorkbenchState>({
    threadId: stateThreadId(resourceId, threadId),
    type: WORKBENCH_STATE_TYPE,
  });
}

function stateSignalValue<K extends StateLaneId>(
  signal: ProcessorActiveStateSignal | undefined,
): StateLaneValue<K> | undefined {
  const value = signal?.metadata?.value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as StateLaneValue<K>;
  }
  return undefined;
}

function mostRecentStateValue<K extends StateLaneId>(
  signals: ProcessorActiveStateSignal[],
): StateLaneValue<K> | undefined {
  for (let index = signals.length - 1; index >= 0; index -= 1) {
    const value = stateSignalValue<K>(signals[index]);
    if (value) return value;
  }
  return undefined;
}

function changedFields<T extends Record<string, unknown>>(
  previous: T | undefined,
  next: T,
): Partial<T> {
  if (!previous) return { ...next };
  const changed: Partial<T> = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const field = key as keyof T;
    if (previous[field] !== next[field]) changed[field] = next[field];
  }
  return changed;
}

function stableCacheKey(laneId: string, value: Record<string, unknown>): string {
  const fields = Object.keys(value)
    .sort()
    .map((key) => `${key}=${String(value[key])}`);
  return `${laneId}:${fields.join("|")}`;
}

function createStateLaneProcessor<K extends StateLaneId>(options: {
  stateId: K;
  snapshot: (value: StateLaneValue<K>) => string;
  delta: (changed: Partial<StateLaneValue<K>>, value: StateLaneValue<K>) => string;
}): InputProcessor {
  return {
    id: `${options.stateId}-state`,
    stateId: options.stateId,
    async computeStateSignal(args) {
      const value = (await readWorkbenchState(args.resourceId, args.threadId))?.[options.stateId] as
        | StateLaneValue<K>
        | undefined;
      if (!value) return;

      const shouldRefreshSnapshot = Boolean(args.lastSnapshot && !args.contextWindow.hasSnapshot);
      const previous =
        mostRecentStateValue<K>(args.activeStateSignals) ?? stateSignalValue<K>(args.lastSnapshot);
      const changed = changedFields(previous, value);
      if (previous && Object.keys(changed).length === 0 && !shouldRefreshSnapshot) return;

      const isDelta = Boolean(previous && !shouldRefreshSnapshot);
      return {
        id: options.stateId,
        cacheKey: stableCacheKey(options.stateId, value),
        mode: isDelta ? "delta" : "snapshot",
        tagName: "state",
        contents: isDelta ? options.delta(changed, value) : options.snapshot(value),
        value,
        ...(isDelta ? { delta: changed } : {}),
        attributes: { type: options.stateId, updated: new Date().toISOString() },
        metadata: { value },
      };
    },
  };
}

export const editorStateProcessor = createStateLaneProcessor({
  stateId: "editor",
  snapshot: (value) => {
    const parts = [
      value.openPath
        ? `The user has ${value.openPath} open in the workspace editor${value.dirty ? " with unsaved changes" : ""}.`
        : "No file is open in the workspace editor.",
    ];
    if (value.selectedPath && value.selectedPath !== value.openPath) {
      parts.push(`File tree selection: ${value.selectedPath}.`);
    }
    if (value.workspacePath) parts.push(`Workspace root: ${value.workspacePath}.`);
    return parts.join(" ");
  },
  delta: (changed, value) => {
    const parts: string[] = [];
    if ("openPath" in changed) {
      parts.push(
        value.openPath
          ? `The user switched the editor to ${value.openPath}.`
          : "The user closed the open editor file.",
      );
    }
    if ("dirty" in changed) {
      parts.push(
        value.dirty
          ? `${value.openPath ?? "The open file"} now has unsaved changes.`
          : `${value.openPath ?? "The open file"} has been saved.`,
      );
    }
    if ("selectedPath" in changed) {
      parts.push(
        value.selectedPath
          ? `File tree selection: ${value.selectedPath}.`
          : "File tree selection cleared.",
      );
    }
    if ("workspacePath" in changed) parts.push(`Workspace root: ${value.workspacePath ?? "none"}.`);
    return parts.join(" ");
  },
});

function describeTerminalCommand(value: StateLaneValue<"terminal">): string | undefined {
  if (!value.lastCommand) return undefined;
  const exit =
    typeof value.lastExitCode === "number" ? ` (exit code ${value.lastExitCode})` : " (running)";
  return `Last command the user ran in the terminal: ${value.lastCommand}${exit}.`;
}

export const terminalStateProcessor = createStateLaneProcessor({
  stateId: "terminal",
  snapshot: (value) => {
    const parts = [
      value.open
        ? `The terminal panel is open with ${value.sessionCount} session(s)${
            value.activeTitle ? `, active "${value.activeTitle}"` : ""
          }${value.activeStatus ? ` (${value.activeStatus})` : ""}.`
        : "The terminal panel is closed.",
    ];
    const command = describeTerminalCommand(value);
    if (command) parts.push(command);
    return parts.join(" ");
  },
  delta: (changed, value) => {
    const parts: string[] = [];
    if ("open" in changed) {
      parts.push(
        value.open ? "The user opened the terminal panel." : "The user closed the terminal panel.",
      );
    }
    if ("sessionCount" in changed) parts.push(`Terminal sessions: ${value.sessionCount}.`);
    if ("activeTitle" in changed || "activeStatus" in changed) {
      parts.push(
        `Active terminal: ${value.activeTitle ?? "none"}${
          value.activeStatus ? ` (${value.activeStatus})` : ""
        }.`,
      );
    }
    if ("lastCommand" in changed || "lastExitCode" in changed) {
      const command = describeTerminalCommand(value);
      if (command) parts.push(command);
    }
    return parts.join(" ");
  },
});

function describeOpenPanels(value: StateLaneValue<"workbench">): string {
  const open: string[] = [];
  if (value.workspacePanelOpen) {
    open.push(`the workspace panel (${value.workspacePanelTab ?? "files"} tab)`);
  }
  if (value.terminalPanelOpen) open.push("the terminal panel");
  if (value.libraryOpen) open.push("the library");
  return open.length
    ? `The user currently has ${open.join(", ")} open.`
    : "The user has no side panels open.";
}

export const workbenchStateProcessor = createStateLaneProcessor({
  stateId: "workbench",
  snapshot: describeOpenPanels,
  delta: (_changed, value) => describeOpenPanels(value),
});

// ---------------------------------------------------------------------------
// AGENTS.md 自动加载 (docs/en/docs/harness/signals.mdx)
// ---------------------------------------------------------------------------

const AGENTS_FILE = "AGENTS.md";
const MAX_AGENTS_MD_CHARACTERS = 24_000;

async function readAgentsMd(path: string): Promise<string | undefined> {
  try {
    const contents = await readFile(path, "utf8");
    const trimmed = contents.trim();
    if (!trimmed) return undefined;
    return trimmed.length > MAX_AGENTS_MD_CHARACTERS
      ? `${trimmed.slice(0, MAX_AGENTS_MD_CHARACTERS)}\n\n[AGENTS.md truncated]`
      : trimmed;
  } catch {
    return undefined;
  }
}

function hasSentAgentsMd(messages: MastraDBMessage[], path: string): boolean {
  return messages.some((message) => {
    const metadata = message.content.metadata;
    if (!metadata || typeof metadata !== "object") return false;
    const signal = metadata.signal;
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) return false;
    const attributes = (signal as { attributes?: unknown }).attributes;
    if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return false;
    const record = attributes as { type?: unknown; path?: unknown };
    return record.type === "dynamic-agents-md" && record.path === path;
  });
}

function agentsMdPathsFromStep(step: unknown): string[] {
  const calls = (step as { toolCalls?: Array<{ input?: unknown }> } | undefined)?.toolCalls ?? [];
  const paths: string[] = [];
  for (const call of calls) {
    if (!call.input || typeof call.input !== "object") continue;
    for (const value of Object.values(call.input as Record<string, unknown>)) {
      if (typeof value === "string" && value.endsWith(AGENTS_FILE) && isAbsolute(value)) {
        paths.push(value);
      }
    }
  }
  return paths;
}

export const agentsMdProcessor: InputProcessor = {
  id: "agents-md",
  async processInputStep({ messageList, requestContext, sendSignal, stepNumber, steps }) {
    if (!sendSignal) return messageList;

    const candidates = new Set<string>();
    if (stepNumber === 0) {
      const workspacePath = requestContext?.get(WORKSPACE_PATH_CONTEXT_KEY) as string | undefined;
      if (workspacePath) candidates.add(join(workspacePath, AGENTS_FILE));
    } else {
      for (const path of agentsMdPathsFromStep(steps.at(-1))) candidates.add(path);
    }
    if (candidates.size === 0) return messageList;

    const messages = messageList.get.all.db();
    for (const path of candidates) {
      if (hasSentAgentsMd(messages, path)) continue;
      const contents = await readAgentsMd(path);
      if (!contents) continue;
      await sendSignal({
        type: "reactive",
        contents,
        attributes: { type: "dynamic-agents-md", path },
        metadata: { path },
      });
    }
    return messageList;
  },
};

// ---------------------------------------------------------------------------
// 前缀缓存断点 (docs/en/reference/processors/processor-interface.mdx 的 processLLMRequest)
// ---------------------------------------------------------------------------

/**
 * Anthropic 是三家供应商里唯一需要**显式**声明缓存边界的:OpenAI 与 Gemini 只要前缀
 * 逐字节一致就自动命中,Anthropic 要在内容块上打 cache_control 断点。
 *
 * 渲染顺序是 tools → system → messages,按稳定性分三段(上限 4 个,还留一个余量):
 * 1. **第一条** system 消息 —— Mastra 的 getAllSystemMessages() 是
 *    [...untagged, ...tagged],Agent 的 instructions 数组在前、memory(OM 观察 /
 *    working memory)在后,所以第一条就是最稳定的 BASE_INSTRUCTIONS。工具定义排在
 *    它前面,一并进这段前缀:换模式改了后面的 mode/skills 文案、OM 折叠了观察,
 *    这一段仍然命中。
 * 2. **最后一条** system 消息 —— 兜住 mode / 技能 / OM 那些易变的 system 段。
 * 3. prompt 的最后一条消息 —— agentic loop 每步都在尾部追加,本步写入、下一步命中。
 *
 * 多打断点不会多付写入费:命中的前缀算 read(0.1x)并顺带刷新 TTL,写入只发生在
 * 「最后一次命中之后到最末断点」这一段 —— 断点只是把命中边界切得更细。
 *
 * 上限 4 个由 @ai-sdk/anthropic 的 CacheControlValidator 兜底(超出只警告不报错)。
 *
 * 必须注册在 inputProcessors 的**最后**:guardrails 里的 ProviderHistoryCompat 等同样在
 * processLLMRequest 改写 prompt,晚改写的一方会覆盖早先挂上的 providerOptions。
 */
function providerNamespace(model: { provider?: string }): string {
  // 与 @ai-sdk/anthropic 的 providerOptionsName 同一套规则:取第一个点之前的部分
  // ('anthropic.messages' → 'anthropic'),供应商包正是按这个键读 providerOptions。
  const provider = typeof model.provider === "string" ? model.provider : "";
  const dotIndex = provider.indexOf(".");
  return dotIndex === -1 ? provider : provider.slice(0, dotIndex);
}

export const promptCacheProcessor: InputProcessor = {
  id: "prompt-cache-breakpoints",
  processLLMRequest({ model, prompt }) {
    if (providerNamespace(model) !== "anthropic") return;
    if (prompt.length === 0) return;

    // Set 去重:只有一条 system 消息、或整个 prompt 只有 system 时索引会重合
    const breakpoints = new Set<number>([prompt.length - 1]);
    const firstSystemIndex = prompt.findIndex((message) => message.role === "system");
    if (firstSystemIndex >= 0) {
      breakpoints.add(firstSystemIndex);
      breakpoints.add(prompt.findLastIndex((message) => message.role === "system"));
    }

    const next = [...prompt];
    for (const index of breakpoints) {
      const message = next[index];
      next[index] = {
        ...message,
        providerOptions: {
          ...message.providerOptions,
          anthropic: {
            ...message.providerOptions?.anthropic,
            cacheControl: { type: "ephemeral" },
          },
        },
      };
    }
    return { prompt: next };
  },
};
