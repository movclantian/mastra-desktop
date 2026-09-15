/**
 * 自定义输入处理器(docs/en/docs/agents/processors.mdx):
 * - libraryAttachmentProcessor:资料库附件 URL → 真实内容注入
 * - editor / terminal / workbench 三条 state lane(computeStateSignal,
 *   docs/en/docs/harness/signals.mdx「State signals」)
 * - agentsMdProcessor:工作区 AGENTS.md 的自动加载与去重
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { InputProcessor } from "@mastra/core/processors";
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

export const [
  editorStateProcessor,
  terminalStateProcessor,
  workbenchStateProcessor,
]: InputProcessor[] = (["editor", "terminal", "workbench"] as const).map((stateId) => ({
  id: `${stateId}-state`,
  stateId,
  async computeStateSignal({ resourceId, threadId }) {
    const value = (await readWorkbenchState(resourceId, threadId))?.[stateId];
    if (!value) return;
    const contents = JSON.stringify(value);
    return { mode: "snapshot", cacheKey: contents, contents, value };
  },
}));

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
