import type { FileUIPart, UIMessage } from "ai";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FileTextIcon,
  GitForkIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  RefreshCcwIcon,
  SparklesIcon,
  WaypointsIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import {
  MessageBranch,
  MessageBranchContent,
  MessageBranchNext,
  MessageBranchPage,
  MessageBranchPrevious,
  MessageBranchSelector,
  MessageResponse,
} from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import { ToolInput, ToolOutput, type ToolPart } from "@/components/ai-elements/tool";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { AgentInteractionHistory } from "./agent-panels";
import {
  buildCitationEntries,
  createCitationRehypePlugins,
  withResolvedFootnotes,
} from "./citation-utils";
import { CitationProvider, FootnoteCitation, MarkdownSection } from "./citations";
import {
  asString,
  type CompactedHistoryEntry,
  getAssistantSegments,
  getPlanDraft,
  getTraceStepStatus,
  type MessageBranchRecord,
  type MessageFileReference,
  type TracePart,
} from "./types";

const CITATION_MARKDOWN_COMPONENTS = {
  section: MarkdownSection,
  sup: FootnoteCitation,
};
const CITATION_REHYPE_PLUGINS = createCitationRehypePlugins();

// ---------------------------------------------------------------------------
// 随机头像:https://v2.xxapi.cn/api/head 返回 JSON 包装
// { code, data: "https://images.xxapi.cn/..." },需先取 data 再渲染图片 URL。
// URL 按缓存键持久化到 localStorage(跨会话稳定,重启不再请求 API);图片用
// <img> 直接加载 —— <img> 不受 CORS 约束(该 CDN 不带 Access-Control-Allow-
// Origin,fetch 会失败),多实例渲染同一 URL 由浏览器 HTTP 缓存去重,仅一次
// 网络请求。助手固定一张;用户按 userId 分键,同一账号始终同一张。
// ---------------------------------------------------------------------------

function loadCachedHeadUrl(cacheKey: string): string | null {
  try {
    return localStorage.getItem(cacheKey);
  } catch {
    return null;
  }
}

const headUrlMemory = new Map<string, string>();
const headUrlPromises = new Map<string, Promise<string | null>>();

function fetchRandomHeadUrl(cacheKey: string): Promise<string | null> {
  let promise = headUrlPromises.get(cacheKey);
  if (!promise) {
    promise = (async () => {
      // 已有持久化 URL(上次会话取到的)则直接复用,不请求随机头像 API
      const remoteUrl =
        loadCachedHeadUrl(cacheKey) ??
        (await fetch("https://v2.xxapi.cn/api/head")
          .then((r) => r.json() as Promise<{ data?: string }>)
          .then((body) => body.data ?? null)
          .catch(() => null));
      if (!remoteUrl) return null;
      try {
        localStorage.setItem(cacheKey, remoteUrl);
      } catch {
        /* 存储不可用时仅内存缓存 */
      }
      headUrlMemory.set(cacheKey, remoteUrl); // 后续挂载的实例同步命中,不闪 fallback 图标
      return remoteUrl;
    })();
    // 失败(null)不缓存 Promise:一次网络抖动/CSP 拦截不该把整个会话钉死在
    // fallback,下次组件挂载(或换线程)重新请求
    void promise.then((url) => {
      if (!url) headUrlPromises.delete(cacheKey);
    });
    headUrlPromises.set(cacheKey, promise);
  }
  return promise;
}

const RandomHeadAvatar = React.memo(function RandomHeadAvatar({
  alt,
  cacheKey,
  fallback,
  fallbackClassName,
}: {
  alt: string;
  cacheKey: string;
  fallback: React.ReactNode;
  fallbackClassName: string;
}) {
  const [headUrl, setHeadUrl] = React.useState<string | null>(headUrlMemory.get(cacheKey) ?? null);
  React.useEffect(() => {
    if (!headUrl) void fetchRandomHeadUrl(cacheKey).then(setHeadUrl);
  }, [cacheKey, headUrl]);

  return (
    <Avatar>
      {headUrl ? <AvatarImage alt={alt} src={headUrl} /> : null}
      <AvatarFallback className={fallbackClassName}>{fallback}</AvatarFallback>
    </Avatar>
  );
});

export const AssistantAvatar = React.memo(function AssistantAvatar() {
  return (
    <RandomHeadAvatar
      alt="MastraWork"
      cacheKey="mastra-work:assistant-head-url"
      fallback={<WaypointsIcon className="size-4" />}
      fallbackClassName="bg-sidebar-primary text-sidebar-primary-foreground"
    />
  );
});

function UserAvatar({ userId }: { userId: string }) {
  return (
    <RandomHeadAvatar
      alt="用户头像"
      cacheKey={`mastra-work:user-head-url:${userId}`}
      fallback="我"
      fallbackClassName="bg-primary text-primary-foreground"
    />
  );
}

// ---------------------------------------------------------------------------
// 执行轨迹:推理步骤走官方 ChainOfThought 渲染;工具步骤按 docs/aielements/
// task.tsx 的 Task 模式 —— 连续的工具 part 归为一组,整组渲染成一个 Task
// (折叠触发器 + TaskContent 左边框时间线 + TaskItem 单行摘要)。
// 组件仍按 part 引用 memo:AI SDK 流式更新时未变更的 part 保持引用稳定
// (AI SDK v5 特性),已完成步骤可跳过重渲染,这是流式不卡顿的根治手段。
// ---------------------------------------------------------------------------

export const ReasoningStepItem = React.memo(function ReasoningStepItem({
  part,
  isStreaming,
}: {
  part: Extract<TracePart, { type: "reasoning" }>;
  isStreaming: boolean;
}) {
  const partStreaming = isStreaming && part.state === "streaming";
  return (
    <ChainOfThoughtStep label="" status={partStreaming ? "active" : "complete"}>
      <Reasoning className="mb-0" defaultOpen={partStreaming} isStreaming={partStreaming}>
        <ReasoningTrigger />
        {/*
         * 流式与完成态统一走 ReasoningContent(Streamdown):Streamdown 为流式
         * 增量解析设计,块级 memo,每 token 只重解析尾部未完成块 —— 与主回答
         * (MessageResponse)同一条渲染路径,不存在"每 token 全量重跑"。
         * 之前流式态用纯文本、结束后切 Markdown,会造成完成瞬间的排版闪变。
         */}
        <ReasoningContent>{part.text || "此模型未返回可展示的推理摘要"}</ReasoningContent>
      </Reasoning>
    </ChainOfThoughtStep>
  );
});

/**
 * 工具步骤:TaskItem 单行摘要(状态图标 + 工具名 + 关键参数)。
 * 有参数或输出时整行可点,展开显示 ToolInput/ToolOutput 的 JSON 详情
 * (默认收起,需要时再看,不再无条件倾倒原始数据)。
 */
export const ToolStepItem = React.memo(function ToolStepItem({ part }: { part: ToolPart }) {
  const [open, setOpen] = React.useState(false);
  const name = part.type === "dynamic-tool" ? part.toolName : part.type.replace("tool-", "");
  const active = getTraceStepStatus(part) === "active";
  const failed = part.state === "output-error";
  const errorText = "errorText" in part ? part.errorText : undefined;
  const hasInput = part.input !== undefined;
  const output = "output" in part ? part.output : undefined;
  const input = (part.input ?? {}) as Record<string, unknown>;
  // 参数摘要:取第一个有值的短字符串(query/url/path 等关键参数通常排在最前)
  const hint = Object.values(input).find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const hintLabel = hint ? (hint.length > 64 ? `${hint.slice(0, 64)}…` : hint) : null;
  const hasDetails = hasInput || output !== undefined;

  const summary = (
    <>
      {name}
      {hintLabel ? <span className="text-muted-foreground/70"> · {hintLabel}</span> : null}
      {failed ? (
        <span className="block text-destructive text-xs">{errorText ?? "调用失败"}</span>
      ) : null}
    </>
  );

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <TaskItem className="flex items-start gap-2">
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
          {active ? (
            <Spinner className="size-3.5" />
          ) : failed ? (
            <XIcon className="size-3.5 text-destructive" />
          ) : (
            <CheckIcon className="size-3.5" />
          )}
        </span>
        {hasDetails ? (
          <button
            className="min-w-0 flex-1 break-words text-left"
            onClick={() => setOpen(!open)}
            type="button"
          >
            {summary}
          </button>
        ) : (
          <span className="min-w-0 flex-1 break-words">{summary}</span>
        )}
        {hasDetails ? (
          <ChevronDownIcon
            className={`mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        ) : null}
      </TaskItem>
      {hasDetails ? (
        <CollapsibleContent>
          <div className="mt-1 space-y-2 pl-6">
            {hasInput ? <ToolInput input={part.input} /> : null}
            {output !== undefined ? <ToolOutput errorText={errorText} output={output} /> : null}
          </div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
});

/**
 * 工具组:连续的工具 part 归为一组,渲染成一个 Task(折叠头 + 时间线)。
 * 必须和推理步骤一样包在 ChainOfThoughtStep 里 —— 那层的 `div.relative` 图标列
 * (圆点 + absolute 竖线)就是左侧时间线;少了它,工具组会贴到最左与 Header 平齐,
 * 和推理步骤错开一个图标列的宽度,层级就断了。
 */
function ToolGroup({ tools }: { tools: ToolPart[] }) {
  const active = tools.some((tool) => getTraceStepStatus(tool) === "active");
  return (
    <ChainOfThoughtStep label="" status={active ? "active" : "complete"}>
      <Task className="w-full">
        {/* w-full:折叠头占满整行,chevron 与外层 Header 的一样右对齐 */}
        <TaskTrigger className="w-full" title={`工具调用 · ${tools.length} 步`}>
          <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
            <WrenchIcon className="size-4" />
            <p className="flex-1 text-left text-sm">工具调用 · {tools.length} 步</p>
            <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
          </div>
        </TaskTrigger>
        <TaskContent>
          {tools.map((tool) => (
            <ToolStepItem key={tool.toolCallId} part={tool} />
          ))}
        </TaskContent>
      </Task>
    </ChainOfThoughtStep>
  );
}

export function AssistantTrace({
  parts,
  isStreaming,
}: {
  parts: TracePart[];
  isStreaming: boolean;
}) {
  const reasoningCount = parts.filter((part) => part.type === "reasoning").length;
  const toolCount = parts.length - reasoningCount;
  const active = parts.some((part) => getTraceStepStatus(part) === "active");
  const summary = [reasoningCount ? "思考" : null, toolCount ? "工具调用" : null]
    .filter(Boolean)
    .join("与");
  const [open, setOpen] = React.useState(isStreaming && active);
  const wasStreaming = React.useRef(isStreaming);

  React.useEffect(() => {
    if (isStreaming && active && !wasStreaming.current) {
      setOpen(true);
    }
    if (!isStreaming && wasStreaming.current) {
      setOpen(false);
    }
    wasStreaming.current = isStreaming;
  }, [active, isStreaming]);

  // 按原始顺序铺开:推理步骤原位渲染,连续工具 part 聚成一个 Task 组
  const items: Array<{ key: string; node: React.ReactNode }> = [];
  let toolRun: ToolPart[] = [];
  const flushTools = () => {
    if (toolRun.length === 0) return;
    const tools = toolRun;
    toolRun = [];
    items.push({ key: `tools-${tools[0].toolCallId}`, node: <ToolGroup tools={tools} /> });
  };
  parts.forEach((part, index) => {
    if (part.type === "reasoning") {
      flushTools();
      items.push({
        key: part.id ?? `reasoning-${index}`,
        node: <ReasoningStepItem isStreaming={isStreaming} part={part} />,
      });
      return;
    }
    toolRun.push(part);
  });
  flushTools();

  return (
    <ChainOfThought className="max-w-full" onOpenChange={setOpen} open={open}>
      <ChainOfThoughtHeader>
        {active ? "正在处理" : `${summary || "执行轨迹"} · ${parts.length} 个步骤`}
      </ChainOfThoughtHeader>
      {/* 不额外缩进:每个步骤自带 ChainOfThoughtStep 的图标列,圆点正好落在
          Header 的 BrainIcon 那一列,步骤正文与 Header 文字起点对齐;
          再往内一层的层级由工具组 TaskContent 自带的 border-l 时间线承担 */}
      <ChainOfThoughtContent>
        {items.map((item) => (
          <React.Fragment key={item.key}>{item.node}</React.Fragment>
        ))}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

export function MessageAttachments({
  files,
  messageId,
  align = "start",
}: {
  files: FileUIPart[];
  messageId: string;
  align?: "start" | "end";
}) {
  if (files.length === 0) return null;

  return (
    <AttachmentGroup className={align === "end" ? "max-w-full justify-end" : "max-w-full"}>
      {files.map((file, index) => {
        const id = `${messageId}-file-${index}`;
        const isImage = file.mediaType?.startsWith("image/") ?? false;
        const title = file.filename ?? "未命名附件";
        return (
          <Attachment key={id} size="sm" className="max-w-[min(100%,18rem)]">
            <AttachmentMedia variant={isImage ? "image" : "icon"}>
              {isImage ? <img src={file.url} alt={title} /> : <FileTextIcon aria-hidden="true" />}
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>{title}</AttachmentTitle>
              <AttachmentDescription>{file.mediaType || "文件"}</AttachmentDescription>
            </AttachmentContent>
            {file.url ? (
              <AttachmentTrigger
                render={
                  <a
                    href={file.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`打开 ${title}`}
                  />
                }
              />
            ) : null}
          </Attachment>
        );
      })}
    </AttachmentGroup>
  );
}

function MessageFileReferenceBadges({ references }: { references: MessageFileReference[] }) {
  if (references.length === 0) return null;
  return (
    <div className="flex max-w-full flex-wrap justify-end gap-1">
      {references.map((reference) => (
        <Badge
          className="max-w-full gap-1 border-primary/30 bg-primary/10 text-primary"
          key={`${reference.id}:${reference.url}`}
          variant="outline"
        >
          <FileTextIcon className="size-3 shrink-0" />
          <span className="max-w-60 truncate">@{reference.filename}</span>
        </Badge>
      ))}
    </div>
  );
}

function getMessageFileReferences(message: UIMessage): MessageFileReference[] {
  const raw = (message.metadata as { fileReferences?: unknown } | undefined)?.fileReferences;
  if (!Array.isArray(raw)) return [];
  return raw.filter((reference): reference is MessageFileReference => {
    if (typeof reference !== "object" || reference === null) return false;
    const item = reference as Record<string, unknown>;
    return (
      typeof item.id === "string" &&
      typeof item.filename === "string" &&
      typeof item.url === "string"
    );
  });
}

// ---------------------------------------------------------------------------
// 消息渲染:文本、推理与工具均按 UIMessage.parts 的原始顺序展示。
// MessageScroller 处理流式锚定;Message/MessageResponse 保持官方消息样式。
// ---------------------------------------------------------------------------

/** 展开的压缩历史使用普通消息气泡渲染,但不再参与当前会话请求。 */
export function CompactedHistoryMessage({
  entry,
  onEdit,
  userId,
}: {
  entry: CompactedHistoryEntry;
  onEdit: (messageId: string, text: string) => void;
  userId: string;
}) {
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(entry.text);
  if (entry.role === "user") {
    return (
      <Message align="end">
        <MessageAvatar className="self-start group-has-data-[slot=message-footer]/message:translate-y-0">
          <UserAvatar userId={userId} />
        </MessageAvatar>
        <MessageContent className="items-end">
          {editing ? (
            <div className="flex w-[min(100%,42rem)] max-w-full self-end flex-col items-end gap-2">
              <Textarea
                autoFocus
                className="min-h-20 w-full resize-y"
                onChange={(event) => setText(event.target.value)}
                value={text}
              />
              <div className="flex justify-end gap-1">
                <Button
                  aria-label="取消编辑"
                  onClick={() => setEditing(false)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
                <Button
                  aria-label="从此消息创建修正分支"
                  disabled={!text.trim()}
                  onClick={() => {
                    onEdit(entry.id, text.trim());
                    setEditing(false);
                  }}
                  size="icon-xs"
                  type="button"
                >
                  <CheckIcon />
                </Button>
              </div>
            </div>
          ) : entry.text ? (
            <Bubble>
              <BubbleContent>{entry.text}</BubbleContent>
            </Bubble>
          ) : null}
          {!editing ? (
            <MessageFooter className="pointer-events-none justify-end gap-1 px-0 opacity-0 transition-opacity duration-150 group-hover/message:pointer-events-auto group-hover/message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
              <Button
                aria-label="编辑已压缩消息"
                onClick={() => setEditing(true)}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <PencilIcon />
              </Button>
            </MessageFooter>
          ) : null}
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message>
      <MessageAvatar className="self-start">
        <AssistantAvatar />
      </MessageAvatar>
      <MessageContent>
        <MessageHeader className="px-0">MastraWork</MessageHeader>
        {entry.text ? (
          <Bubble variant="ghost">
            <BubbleContent>
              <MessageResponse>{entry.text}</MessageResponse>
            </BubbleContent>
          </Bubble>
        ) : null}
      </MessageContent>
    </Message>
  );
}

/**
 * 压缩摘要消息卡片:渲染在线程头部(时序正确),默认只显示摘要,
 * 可展开查看被折叠的原始消息 —— 历史不丢失,只是退出模型上下文。
 */
export function CompactedMessageCard({
  message,
  onEdit,
  userId,
}: {
  message: UIMessage;
  onEdit: (messageId: string, text: string) => void;
  userId: string;
}) {
  const history =
    (message.metadata as { compactedHistory?: CompactedHistoryEntry[] } | undefined)
      ?.compactedHistory ?? [];
  const raw = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const summary = raw.includes("\n\n") ? raw.slice(raw.indexOf("\n\n") + 2) : raw;
  const [open, setOpen] = React.useState(false);

  return (
    <MessageScrollerItem messageId={message.id} scrollAnchor>
      <Collapsible onOpenChange={setOpen} open={open}>
        <div className="flex w-full flex-col gap-2 py-1">
          {/* 展开时历史消息位于压缩边界之前,后续消息仍由外层 messages.map 按顺序渲染。 */}
          <CollapsibleContent className="flex flex-col gap-6">
            {history.map((entry) => (
              <CompactedHistoryMessage
                entry={entry}
                key={entry.id}
                onEdit={onEdit}
                userId={userId}
              />
            ))}
          </CollapsibleContent>
          <Marker role="status" variant="separator">
            <MarkerContent>Conversation compacted</MarkerContent>
          </Marker>
          <div className="rounded-lg border bg-muted/40 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                已折叠 {history.length} 条早期消息,摘要如下
              </span>
              <Button onClick={() => setOpen(!open)} size="sm" variant="ghost">
                {open ? "收起原始消息" : `展开原始消息(${history.length})`}
              </Button>
            </div>
            <p className="mt-1 text-sm whitespace-pre-wrap">{summary}</p>
          </div>
        </div>
      </Collapsible>
    </MessageScrollerItem>
  );
}

export const MessageItem = React.memo(function MessageItem({
  message,
  messageIndex,
  isStreaming,
  onRetry,
  onClone,
  onCloneMessage,
  onEdit,
  onEditCompacted,
  userId,
  branch,
  parentUserVersionId,
  onBranchChange,
}: {
  message: UIMessage;
  messageIndex: number;
  isStreaming: boolean;
  /**
   * 重试**这一条**助手消息(chat-panel 转成 regenerate({ messageId }))。
   * 由本组件回传 id 而不是让父组件包一层内联箭头函数 —— MessageItem 是 memo 的,
   * 内联函数会让每个流式 delta 都把整条消息列表重渲染一遍。
   */
  onRetry: (messageId: string) => void;
  onClone: (messageLimit: number) => void;
  onCloneMessage: (messageId: string) => void;
  onEdit: (messageId: string, text: string) => void;
  onEditCompacted: (messageId: string, text: string) => void;
  userId: string;
  branch?: MessageBranchRecord;
  /** 当前激活用户节点的分支版本 id;助手切换器用它筛选直接子回复(数据源铁律)。 */
  parentUserVersionId?: string;
  onBranchChange?: (rootId: string, versionId: string) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [editText, setEditText] = React.useState("");
  // 编辑框宽度 = 气泡实际渲染宽度(点击编辑瞬间测量),避免固定宽度造成
  // 短消息编辑时编辑框水平漂移;下限 16rem 保证极短消息仍可编辑
  const [editWidth, setEditWidth] = React.useState<number | null>(null);
  const bubbleRef = React.useRef<HTMLDivElement | null>(null);
  const isUser = message.role === "user";
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const files = message.parts.filter((part) => part.type === "file");
  React.useEffect(() => {
    if (!editing) setEditText(text);
  }, [editing, text]);
  // 压缩摘要消息:特殊卡片渲染(摘要 + 可展开折叠历史),不走普通气泡
  if ((message.metadata as { compactedHistory?: unknown } | undefined)?.compactedHistory) {
    return <CompactedMessageCard message={message} onEdit={onEditCompacted} userId={userId} />;
  }

  const assistantSegments = isUser ? [] : getAssistantSegments(message.parts, message.id);
  const skillNames = Array.isArray(
    (message.metadata as { skillNames?: unknown } | undefined)?.skillNames,
  )
    ? (message.metadata as { skillNames: unknown[] }).skillNames.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : [];
  const fileReferences = getMessageFileReferences(message);
  // 行内引用表:脚注定义 + 检索工具输出/结构化报告的标题与摘要
  const citationEntries = buildCitationEntries(message.parts);
  const branchVersions = branch?.versions.filter((item) => item.role === message.role) ?? [];
  const activeBranchIndex = (() => {
    if (!branch) return 0;
    const selectedVersionIndex = branchVersions.findIndex(
      (item) => item.id === branch.currentVersionId,
    );
    if (selectedVersionIndex >= 0) return selectedVersionIndex;
    // A message loaded during a branch refresh can briefly carry the
    // selected message id before the branch manifest arrives. Use that id as
    // a stable fallback instead of showing the first historical version.
    const selectedMessageIndex = branchVersions.findIndex((item) => item.message.id === message.id);
    return selectedMessageIndex >= 0 ? selectedMessageIndex : 0;
  })();
  // 助手切换器数据源铁律:可选项仅来自当前激活用户节点(parentUserVersionId)
  // 的直接子回复 —— 即 pairVersionId 指向该用户版本的助手版本;子回复数量 < 2
  // 时整个切换器隐藏。旧数据(版本全都没有配对)退回全量版本列表,历史线程
  // 不至于失去切换器。用户切换节点时 parentUserVersionId 变化,本列表随之重算
  const assistantSwitchableVersions = !isUser
    ? (() => {
        const children = branchVersions.filter(
          (item) => parentUserVersionId !== undefined && item.pairVersionId === parentUserVersionId,
        );
        if (children.length > 0) return children;
        return branchVersions.length > 1 && branchVersions.every((item) => !item.pairVersionId)
          ? branchVersions
          : [];
      })()
    : [];
  const assistantActiveBranchIndex = (() => {
    if (assistantSwitchableVersions.length === 0) return 0;
    const byCurrent = assistantSwitchableVersions.findIndex(
      (item) => item.id === branch?.currentVersionId,
    );
    if (byCurrent >= 0) return byCurrent;
    const byMessage = assistantSwitchableVersions.findIndex(
      (item) => item.message.id === message.id,
    );
    return byMessage >= 0 ? byMessage : 0;
  })();

  const handleCopy = () => {
    void navigator.clipboard.writeText(text);
    toast.success("已复制到剪贴板");
  };

  const startEditing = () => {
    const width = bubbleRef.current?.offsetWidth;
    setEditWidth(width ? Math.max(width, 256) : null);
    setEditText(text);
    setEditing(true);
  };

  // 助手消息整行即内容区(ghost 气泡占满宽度),按消息行悬停揭示;
  // 不加 justify-end:分支选择器与操作按钮整体靠气泡左侧
  const actionFooterClassName =
    "gap-1 px-0 opacity-0 transition-opacity duration-150 pointer-events-none group-hover/message:pointer-events-auto group-hover/message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100";
  // 用户消息按气泡簇(group/actions)悬停揭示,鼠标在行内空白处不显示操作按钮
  const bubbleActionFooterClassName =
    "gap-1 px-0 opacity-0 transition-opacity duration-150 pointer-events-none group-hover/actions:pointer-events-auto group-hover/actions:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100";
  const assistantActionButtons = (
    <>
      <Button variant="ghost" size="icon-xs" aria-label="复制" title="复制" onClick={handleCopy}>
        <CopyIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="仅克隆此消息"
        title="仅克隆此消息"
        onClick={() => onCloneMessage(message.id)}
      >
        <MessageSquarePlusIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="从这里克隆线程"
        title="从这里克隆线程"
        onClick={() => onClone(messageIndex + 1)}
      >
        <GitForkIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="重试"
        title="重试"
        onClick={() => onRetry(message.id)}
      >
        <RefreshCcwIcon />
      </Button>
    </>
  );

  // 用户消息:默认 Bubble + 纯文本(message-demo.tsx 模式)
  // scrollAnchor 是官方推荐的回合锚定:新回合开始时用户气泡钉在视口顶部
  // (上方保留上一轮 peek),回复在其下方流入;回复长过视口(内部 spacer
  // 归零)时库按设计交接给 scrollToEnd 转为跟随底部 —— 与 autoScroll 组合
  // 即官方 streaming 示例的行为。滚动条拖动不解除锚定的库缺口由
  // MessageScrollerViewport 包装层补偿(见 ui/message-scroller)。
  if (isUser) {
    return (
      <MessageScrollerItem messageId={message.id} scrollAnchor>
        <Message align="end">
          <MessageAvatar className="self-start group-has-data-[slot=message-footer]/message:translate-y-0">
            <UserAvatar userId={userId} />
          </MessageAvatar>
          <MessageContent className="items-end">
            {editing ? (
              <div
                className="flex max-w-full self-end flex-col items-end gap-2"
                style={{ width: editWidth ? `${editWidth}px` : "min(100%, 42rem)" }}
              >
                <Textarea
                  autoFocus
                  className="min-h-20 w-full resize-y"
                  onChange={(event) => setEditText(event.target.value)}
                  value={editText}
                />
                <div className="flex justify-end gap-1">
                  <Button
                    aria-label="取消编辑"
                    onClick={() => {
                      setEditText(text);
                      setEditing(false);
                    }}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <XIcon />
                  </Button>
                  <Button
                    aria-label="保存编辑"
                    disabled={!editText.trim()}
                    onClick={() => {
                      onEdit(message.id, editText.trim());
                      setEditing(false);
                    }}
                    size="icon-xs"
                    type="button"
                  >
                    <CheckIcon />
                  </Button>
                </div>
              </div>
            ) : branchVersions.length > 1 ? (
              <MessageBranch
                className="group/actions w-fit max-w-full justify-items-end"
                defaultBranch={activeBranchIndex}
                onBranchChange={(index) =>
                  onBranchChange?.(
                    branch?.rootId ?? message.id,
                    branchVersions[index]?.id ?? branch?.currentVersionId ?? "",
                  )
                }
              >
                <MessageBranchContent>
                  {branchVersions.map((item, versionIndex) => {
                    const versionMessage = item.message;
                    const versionText = versionMessage.parts
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("\n");
                    const versionSkills = Array.isArray(versionMessage.metadata?.skillNames)
                      ? versionMessage.metadata.skillNames.filter(
                          (value): value is string => typeof value === "string" && value.length > 0,
                        )
                      : [];
                    const versionFiles = versionMessage.parts.filter(
                      (part) => part.type === "file",
                    );
                    const versionFileReferences = getMessageFileReferences(versionMessage);
                    return (
                      <React.Fragment key={item.id}>
                        {versionSkills.length > 0 ? (
                          <div className="flex max-w-full flex-wrap justify-end gap-1">
                            {versionSkills.map((skill) => (
                              <Badge
                                className="gap-1 border-primary/30 bg-primary/10 text-primary"
                                key={skill}
                                variant="outline"
                              >
                                <SparklesIcon className="size-3" />/{skill}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                        <MessageFileReferenceBadges references={versionFileReferences} />
                        <MessageAttachments
                          align="end"
                          files={versionFiles}
                          messageId={versionMessage.id}
                        />
                        {versionText ? (
                          <Bubble
                            className="max-w-full"
                            ref={versionIndex === activeBranchIndex ? bubbleRef : undefined}
                          >
                            <BubbleContent>{versionText}</BubbleContent>
                          </Bubble>
                        ) : null}
                      </React.Fragment>
                    );
                  })}
                </MessageBranchContent>
                <MessageFooter className={bubbleActionFooterClassName}>
                  <MessageBranchSelector>
                    <MessageBranchPrevious />
                    <MessageBranchPage />
                    <MessageBranchNext />
                  </MessageBranchSelector>
                  <Button
                    aria-label="编辑消息"
                    onClick={startEditing}
                    size="icon-xs"
                    title="编辑"
                    type="button"
                    variant="ghost"
                  >
                    <PencilIcon />
                  </Button>
                </MessageFooter>
              </MessageBranch>
            ) : (
              <div className="group/actions flex w-fit max-w-full flex-col items-end gap-0.5">
                <MessageFileReferenceBadges references={fileReferences} />
                {skillNames.length > 0 ? (
                  <div className="flex max-w-full flex-wrap justify-end gap-1">
                    {skillNames.map((skill) => (
                      <Badge
                        className="gap-1 border-primary/30 bg-primary/10 text-primary"
                        key={skill}
                        variant="outline"
                      >
                        <SparklesIcon className="size-3" />/{skill}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <MessageAttachments align="end" files={files} messageId={message.id} />
                {text ? (
                  <Bubble className="max-w-full" ref={bubbleRef}>
                    <BubbleContent>{text}</BubbleContent>
                  </Bubble>
                ) : null}
                <MessageFooter className={bubbleActionFooterClassName}>
                  <Button
                    aria-label="编辑消息"
                    onClick={startEditing}
                    size="icon-xs"
                    title="编辑"
                    type="button"
                    variant="ghost"
                  >
                    <PencilIcon />
                  </Button>
                </MessageFooter>
              </div>
            )}
          </MessageContent>
        </Message>
      </MessageScrollerItem>
    );
  }

  // 助手消息:ghost Bubble + MessageResponse(无框 markdown,message-markdown.tsx 模式)
  return (
    <MessageScrollerItem messageId={message.id}>
      <Message>
        {/* translate-y-0 覆盖官方 footer 触发的 -translate-y-8:
            官方设计 Avatar 底对齐时靠它避开 footer 行;我们顶部对齐(self-start)
            后上移会把旧消息(带 footer)的 Avatar 移出气泡顶部导致不显示 */}
        <MessageAvatar className="self-start group-has-data-[slot=message-footer]/message:translate-y-0">
          <AssistantAvatar />
        </MessageAvatar>
        <MessageContent>
          {/* px-0 固定间距:官方默认 px-3,仅当消息内出现 ghost Bubble(正文到达)才变
              px-0,会导致流式初期头像与名称间距先宽后窄的跳动;助手消息恒为无框样式 */}
          <MessageHeader className="px-0">MastraWork</MessageHeader>
          <MessageAttachments files={files} messageId={message.id} />
          {/* 流式起步阶段(尚无任何文本/推理/工具 part)立即显示思考占位,
              避免头像+名称出现后空白一段,再突然弹出"思考"卡片 */}
          {isStreaming && assistantSegments.length === 0 ? <Shimmer>正在思考…</Shimmer> : null}
          <CitationProvider entries={citationEntries}>
            {assistantSwitchableVersions.length >= 2 ? (
              <MessageBranch
                defaultBranch={assistantActiveBranchIndex}
                onBranchChange={(index) =>
                  onBranchChange?.(
                    branch?.rootId ?? message.id,
                    assistantSwitchableVersions[index]?.id ?? branch?.currentVersionId ?? "",
                  )
                }
              >
                <MessageBranchContent>
                  {assistantSwitchableVersions.map((item) => (
                    <React.Fragment key={item.id}>
                      {getAssistantSegments(item.message.parts, item.message.id).map((segment) =>
                        segment.type === "trace" ? (
                          <AssistantTrace
                            key={segment.key}
                            isStreaming={false}
                            parts={segment.parts}
                          />
                        ) : segment.type === "interaction" ? (
                          <AgentInteractionHistory
                            interaction={segment.interaction}
                            key={segment.key}
                          />
                        ) : (
                          <Bubble key={segment.key} variant="ghost">
                            <BubbleContent>
                              <MessageResponse
                                components={CITATION_MARKDOWN_COMPONENTS}
                                rehypePlugins={CITATION_REHYPE_PLUGINS}
                              >
                                {segment.text}
                              </MessageResponse>
                            </BubbleContent>
                          </Bubble>
                        ),
                      )}
                    </React.Fragment>
                  ))}
                </MessageBranchContent>
                <MessageFooter className={actionFooterClassName}>
                  <MessageBranchSelector>
                    <MessageBranchPrevious />
                    <MessageBranchPage />
                    <MessageBranchNext />
                  </MessageBranchSelector>
                  {assistantActionButtons}
                </MessageFooter>
              </MessageBranch>
            ) : null}
            {assistantSwitchableVersions.length < 2
              ? assistantSegments.map((segment) =>
                  segment.type === "trace" ? (
                    <AssistantTrace
                      key={segment.key}
                      isStreaming={isStreaming}
                      parts={segment.parts}
                    />
                  ) : segment.type === "interaction" ? (
                    <AgentInteractionHistory
                      interaction={
                        segment.interaction.toolName === "submit_plan"
                          ? {
                              ...segment.interaction,
                              plan: getPlanDraft(
                                [message],
                                asString(segment.interaction.suspendPayload?.path),
                              ),
                            }
                          : segment.interaction
                      }
                      key={segment.key}
                    />
                  ) : (
                    <Bubble key={segment.key} variant="ghost">
                      <BubbleContent>
                        {/* 脚注引用换成 InlineCitation 悬浮卡;相邻角标合并;定义区隐藏 */}
                        <MessageResponse
                          components={CITATION_MARKDOWN_COMPONENTS}
                          rehypePlugins={CITATION_REHYPE_PLUGINS}
                        >
                          {withResolvedFootnotes(segment.text, citationEntries)}
                        </MessageResponse>
                      </BubbleContent>
                    </Bubble>
                  ),
                )
              : null}
          </CitationProvider>
          {/* 操作栏与分支选择器保持同一行,且只在悬停/键盘聚焦时出现;
              分支模式下操作栏在 MessageBranch 的 footer 里,这里只渲染无分支态。 */}
          {!isStreaming && assistantSwitchableVersions.length < 2 ? (
            <MessageFooter className={actionFooterClassName}>
              {assistantActionButtons}
            </MessageFooter>
          ) : null}
        </MessageContent>
      </Message>
    </MessageScrollerItem>
  );
});
