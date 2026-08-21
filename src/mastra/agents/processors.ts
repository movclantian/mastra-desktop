import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { InputProcessor, ProcessorActiveStateSignal } from "@mastra/core/processors";
import { z } from "zod";
import {
  getAssetContext,
  getLibraryAssetId,
  LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY,
  LIBRARY_ATTACHMENT_CAPABILITIES_CONTEXT_KEY,
  LIBRARY_RESOURCE_CONTEXT_KEY,
} from "../library";
import { WORKSPACE_PATH_CONTEXT_KEY } from "../workspace";

/**
 * 资料库附件输入处理器(docs/en/docs/agents/input-processors.mdx):
 * 在请求到达模型之前,把消息里指向资料库的稳定 URL(/work/library/assets/:id/content)
 * 解析为真实内容 —— 已抽取文本按剩余 token 预算注入为文本,图片/音频在模型支持
 * 原生媒体时注入为 file 部分,其余降级为占位说明。预算与模型能力由 chat 路由
 * 写入 RequestContext,未携带 resourceId 时处理器直接放行。
 */
export const libraryAttachmentProcessor: InputProcessor = {
  id: "library-attachments",
  async processLLMRequest({ prompt, requestContext }) {
    const resourceId = requestContext?.get(LIBRARY_RESOURCE_CONTEXT_KEY) as string | undefined;
    if (!resourceId) return;
    const tokenBudget = requestContext?.get(LIBRARY_ATTACHMENT_BUDGET_CONTEXT_KEY);
    const capabilities = requestContext?.get(LIBRARY_ATTACHMENT_CAPABILITIES_CONTEXT_KEY) as
      | { vision?: boolean; audio?: boolean }
      | undefined;
    let remainingTokens = typeof tokenBudget === "number" ? Math.max(0, tokenBudget) : 32_000;
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
          const availableCharacters = Math.max(0, Math.floor(remainingTokens * 3));
          const availableText = context.text.slice(0, availableCharacters);
          remainingTokens = Math.max(0, remainingTokens - Math.ceil(availableText.length / 3));
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
            ? Math.max(1_024, Math.ceil(context.asset.byteSize / 1_024))
            : Math.max(1_024, Math.ceil(context.asset.byteSize / 512));
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
      // content 数组按联合推断成全部 part 类型的并集,直接赋回 LanguageModelV2Message
      // 会因角色 content 窄类型不兼容报 TS2322;各 part 均来自原消息或合法替换,断言即可。
      resolvedPrompt[messageIndex] = { ...message, content } as (typeof resolvedPrompt)[number];
    }
    return changed ? { prompt: resolvedPrompt } : undefined;
  },
};

// ---------------------------------------------------------------------------
// 工作台 state lane(docs/en/docs/harness/signals.mdx 的 State signals)
//
// 三条 lane 各由一个 processor 的 computeStateSignal() 拥有,数据源是本模块的
// 内存镜像 —— 渲染进程各面板把自己那一份 PUT 到
// /work/sessions/:scope/threads/:threadId/workbench-state,路由按 lane 浅合并。
//
// 为什么是 processor 而不是外部直接 sendStateSignal():
// 1) 用户切个文件不该唤醒空闲的 agent —— processor 只在模型真要推理时被调用
// 2) contextWindow.hasSnapshot / lastSnapshot / activeStateSignals 是 processor
//    独有的入参,旧 snapshot 被裁出上下文后能自动补发完整快照,外部推送做不到
// 3) 与 Mastra 内置的 browser lane(BrowserContextProcessor)完全同构
//
// 镜像放在 agents/ 而非 server/ 是为了保持 server/ → agents/ 的单向依赖。
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
  /** 终端面板:会话数与最近一条命令的结果(命令本身跑在 Electron 主进程) */
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

export type WorkbenchState = z.infer<typeof workbenchStateSchema>;
type StateLaneId = keyof WorkbenchState;
type StateLaneValue<K extends StateLaneId> = NonNullable<WorkbenchState[K]>;

const workbenchStateByThread = new Map<string, WorkbenchState>();

/** 按 lane 浅合并:body 里没出现的 lane 保持原值,出现的整条替换。 */
export function mergeWorkbenchState(threadId: string, patch: WorkbenchState): WorkbenchState {
  const next = { ...(workbenchStateByThread.get(threadId) ?? {}), ...patch };
  workbenchStateByThread.set(threadId, next);
  return next;
}

export function readWorkbenchState(threadId: string): WorkbenchState | undefined {
  return workbenchStateByThread.get(threadId);
}

export function clearWorkbenchState(threadId: string): void {
  workbenchStateByThread.delete(threadId);
}

/**
 * 上一轮本 lane 的结构化取值。运行时把 computeStateSignal 返回的 value 放在
 * signal.metadata.value 上(与内置 browser lane 的读法一致)。
 */
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

/** 字段排序后拼装,保证同一状态永远得到同一个 key(Mastra 靠它跳过重复投递)。 */
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
    computeStateSignal(args) {
      const value = readWorkbenchState(args.threadId)?.[options.stateId] as
        | StateLaneValue<K>
        | undefined;
      // 面板从未上报过 → 这条 lane 不产生任何信号(而不是发一条"未知")
      if (!value) return;

      // 旧快照已被上下文窗口裁掉:重发完整快照而非增量,否则模型只看到"变了什么"
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
      parts.push(value.open ? "The user opened the terminal panel." : "The user closed the terminal panel.");
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
  // 字段少且互相关联,增量也给完整的面板画面比逐字段罗列更好读
  delta: (_changed, value) => describeOpenPanels(value),
});

// ---------------------------------------------------------------------------
// AGENTS.md 自动加载(signals.mdx「Send processor context」的官方形态)
//
// 工作区根的 AGENTS.md 在首个模型步注入;agent 自己在工具调用里碰到别处的
// AGENTS.md 时也注入那一份。reactive 信号默认 tagName 为 system-reminder,
// 模型看到 <system-reminder type="dynamic-agents-md" path="...">。
// ---------------------------------------------------------------------------

const AGENTS_FILE = "AGENTS.md";
/** 单份规则文件的注入上限:超出部分截断,避免一个巨大的 AGENTS.md 吃掉上下文 */
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

/**
 * 这份规则是否已经进过本线程的历史。reactive 信号是持久化的,所以历史文本里
 * 能同时搜到标记与路径就说明发过 —— 不必再读一次文件、也不重复占上下文。
 */
function hasSentAgentsMd(messages: unknown[], path: string): boolean {
  const needle = JSON.stringify(path).slice(1, -1);
  for (const message of messages) {
    const raw = JSON.stringify(message ?? "");
    if (raw.includes("dynamic-agents-md") && raw.includes(needle)) return true;
  }
  return false;
}

/** 只看刚完成的那一步的工具入参,避免每步都全量扫历史。 */
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

