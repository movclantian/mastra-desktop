import type { FileUIPart, UIMessage } from "ai";
import {
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  GitForkIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  RefreshCcwIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { MASTRA_SERVER_URL } from "@/api/client";
import {
  MessageBranch,
  MessageBranchContent,
  MessageBranchNext,
  MessageBranchPage,
  MessageBranchPrevious,
  MessageBranchSelector,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { Badge } from "@/components/ui/badge";
import { BlurFade } from "@/components/ui/blur-fade";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DotmSquare3 } from "@/components/ui/dotm-square-3";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { Textarea } from "@/components/ui/textarea";
import { WordRotate } from "@/components/ui/word-rotate";
import { fetchChatAssetBlob } from "../api";
import {
  buildCitationEntries,
  createCitationRehypePlugins,
  withResolvedFootnotes,
} from "../lib/citation-utils";
import {
  asString,
  getAssistantSegments,
  getPlanDraft,
  type MessageBranchRecord,
  type MessageFileReference,
  referenceBadgeClass,
} from "../types";
import { AgentInteractionHistory } from "./agent-panels";
import { AssistantTrace } from "./assistant-trace";
import { AssistantAvatar, UserAvatar } from "./avatars";
import { CitationProvider, FootnoteCitation, MarkdownSection } from "./citations";
import { CompactedMessageCard } from "./compacted-messages";

// ---------------------------------------------------------------------------
// 消息渲染:文本、推理与工具均按 UIMessage.parts 的原始顺序展示。
// MessageScroller 处理流式锚定;Message/MessageResponse 保持官方消息样式。
// 执行轨迹(assistant-trace)、压缩历史(compacted-messages)、头像(avatars)
// 在各自的兄弟模块中。
// ---------------------------------------------------------------------------

const CITATION_MARKDOWN_COMPONENTS = {
  section: MarkdownSection,
  sup: FootnoteCitation,
};
const CITATION_REHYPE_PLUGINS = createCitationRehypePlugins();

function MessageAttachments({
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
        return <MessageAttachment key={id} file={file} />;
      })}
    </AttachmentGroup>
  );
}

function MessageAttachment({ file }: { file: FileUIPart }) {
  const isImage = file.mediaType?.startsWith("image/") ?? false;
  const title = file.filename ?? "未命名附件";
  const [resolvedUrl, setResolvedUrl] = React.useState(file.url);

  React.useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    setResolvedUrl(file.url);
    let isMastraResource = false;
    try {
      isMastraResource =
        new URL(file.url, window.location.href).origin === new URL(MASTRA_SERVER_URL).origin;
    } catch {
      // Data/blob URLs and malformed external values stay on their original URL.
    }
    if (!isMastraResource) return () => undefined;
    void fetchChatAssetBlob(file.url)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (disposed) URL.revokeObjectURL(objectUrl);
        else setResolvedUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.url]);

  return (
    <Attachment size="sm" className="max-w-[min(100%,18rem)]">
      <AttachmentMedia variant={isImage ? "image" : "icon"}>
        {isImage ? <img src={resolvedUrl} alt={title} /> : <FileTextIcon aria-hidden="true" />}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{title}</AttachmentTitle>
        <AttachmentDescription>{file.mediaType || "文件"}</AttachmentDescription>
      </AttachmentContent>
      {resolvedUrl ? (
        <AttachmentTrigger
          render={
            <a href={resolvedUrl} target="_blank" rel="noreferrer" aria-label={`打开 ${title}`} />
          }
        />
      ) : null}
    </Attachment>
  );
}

function MessageFileReferenceBadges({ references }: { references: MessageFileReference[] }) {
  if (references.length === 0) return null;
  return (
    <div className="flex max-w-full flex-wrap justify-end gap-1">
      {references.map((reference) => (
        <Badge
          className={`max-w-full gap-1 ${referenceBadgeClass(
            "file",
            `${reference.id}:${reference.url}`,
          )}`}
          key={`${reference.id}:${reference.url}`}
          variant="outline"
        >
          <FileTextIcon className="size-3 shrink-0" />
          <span className="max-w-60 truncate">{reference.filename}</span>
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
  onClone: (messageIndex: number) => void;
  onCloneMessage: (messageId: string, messageIndex: number) => void;
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
        aria-label={isUser ? "克隆此消息" : "克隆此轮对话"}
        title={isUser ? "克隆此消息" : "克隆此轮对话(包含对应请求)"}
        onClick={() => onCloneMessage(message.id, messageIndex)}
      >
        <MessageSquarePlusIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="从这里克隆线程"
        title="从这里克隆线程"
        onClick={() => onClone(messageIndex)}
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
        <BlurFade duration={0.2} blur="3px">
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
                            (value): value is string =>
                              typeof value === "string" && value.length > 0,
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
                                  className={`gap-1 ${referenceBadgeClass("skill", skill)}`}
                                  key={skill}
                                  variant="outline"
                                >
                                  <SparklesIcon className="size-3" />
                                  {skill}
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
                            <ContextMenu>
                              <ContextMenuTrigger className="max-w-full">
                                <Bubble
                                  className="max-w-full"
                                  ref={versionIndex === activeBranchIndex ? bubbleRef : undefined}
                                >
                                  <BubbleContent>{versionText}</BubbleContent>
                                </Bubble>
                              </ContextMenuTrigger>
                              <ContextMenuContent className="w-48">
                                <ContextMenuGroup>
                                  <ContextMenuItem onClick={() => handleCopy()}>
                                    <CopyIcon className="text-muted-foreground" />
                                    <span>复制内容</span>
                                    <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                                  </ContextMenuItem>
                                  <ContextMenuItem onClick={startEditing}>
                                    <PencilIcon className="text-muted-foreground" />
                                    <span>编辑消息</span>
                                  </ContextMenuItem>
                                </ContextMenuGroup>
                                <ContextMenuSeparator />
                                <ContextMenuGroup>
                                  <ContextMenuItem
                                    onClick={() => onCloneMessage(versionMessage.id, messageIndex)}
                                  >
                                    <MessageSquarePlusIcon className="text-muted-foreground" />
                                    <span>克隆此消息</span>
                                  </ContextMenuItem>
                                  <ContextMenuItem onClick={() => onClone(messageIndex)}>
                                    <GitForkIcon className="text-muted-foreground" />
                                    <span>从此处克隆线程</span>
                                  </ContextMenuItem>
                                </ContextMenuGroup>
                              </ContextMenuContent>
                            </ContextMenu>
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
                          className={`gap-1 ${referenceBadgeClass("skill", skill)}`}
                          key={skill}
                          variant="outline"
                        >
                          <SparklesIcon className="size-3" />
                          {skill}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <MessageAttachments align="end" files={files} messageId={message.id} />
                  {text ? (
                    <ContextMenu>
                      <ContextMenuTrigger className="max-w-full">
                        <Bubble className="max-w-full" ref={bubbleRef}>
                          <BubbleContent>{text}</BubbleContent>
                        </Bubble>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-48">
                        <ContextMenuGroup>
                          <ContextMenuItem onClick={() => handleCopy()}>
                            <CopyIcon className="text-muted-foreground" />
                            <span>复制内容</span>
                            <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                          </ContextMenuItem>
                          <ContextMenuItem onClick={startEditing}>
                            <PencilIcon className="text-muted-foreground" />
                            <span>编辑消息</span>
                          </ContextMenuItem>
                        </ContextMenuGroup>
                        <ContextMenuSeparator />
                        <ContextMenuGroup>
                          <ContextMenuItem onClick={() => onCloneMessage(message.id, messageIndex)}>
                            <MessageSquarePlusIcon className="text-muted-foreground" />
                            <span>克隆此消息</span>
                          </ContextMenuItem>
                          <ContextMenuItem onClick={() => onClone(messageIndex)}>
                            <GitForkIcon className="text-muted-foreground" />
                            <span>从此处克隆线程</span>
                          </ContextMenuItem>
                        </ContextMenuGroup>
                      </ContextMenuContent>
                    </ContextMenu>
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
        </BlurFade>
      </MessageScrollerItem>
    );
  }

  // 助手消息:ghost Bubble + MessageResponse(无框 markdown,message-markdown.tsx 模式)
  return (
    <MessageScrollerItem messageId={message.id}>
      <BlurFade duration={0.2} blur="3px">
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
            {isStreaming && assistantSegments.length === 0 ? (
              <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground font-medium">
                <DotmSquare3 size={15} dotSize={2} colorPreset="solid-theme" />
                <WordRotate
                  words={[
                    "正在深度思考与规划…",
                    "正在解析指令与上下文…",
                    "正在检索工具库与工作区…",
                    "正在调度智能体组织回复…",
                  ]}
                  duration={2200}
                  className="text-xs text-muted-foreground font-medium"
                />
              </div>
            ) : null}
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
                            <ContextMenu key={segment.key}>
                              <ContextMenuTrigger className="w-full">
                                <Bubble variant="ghost">
                                  <BubbleContent>
                                    <MessageResponse
                                      components={CITATION_MARKDOWN_COMPONENTS}
                                      rehypePlugins={CITATION_REHYPE_PLUGINS}
                                    >
                                      {segment.text}
                                    </MessageResponse>
                                  </BubbleContent>
                                </Bubble>
                              </ContextMenuTrigger>
                              <ContextMenuContent className="w-48">
                                <ContextMenuGroup>
                                  <ContextMenuItem onClick={() => handleCopy()}>
                                    <CopyIcon className="text-muted-foreground" />
                                    <span>复制回答内容</span>
                                    <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                                  </ContextMenuItem>
                                  <ContextMenuItem onClick={() => onRetry(message.id)}>
                                    <RefreshCcwIcon className="text-muted-foreground" />
                                    <span>重新生成</span>
                                    <ContextMenuShortcut>⌘R</ContextMenuShortcut>
                                  </ContextMenuItem>
                                </ContextMenuGroup>
                                <ContextMenuSeparator />
                                <ContextMenuGroup>
                                  <ContextMenuItem
                                    onClick={() => onCloneMessage(message.id, messageIndex)}
                                  >
                                    <MessageSquarePlusIcon className="text-muted-foreground" />
                                    <span>克隆此轮对话</span>
                                  </ContextMenuItem>
                                  <ContextMenuItem onClick={() => onClone(messageIndex)}>
                                    <GitForkIcon className="text-muted-foreground" />
                                    <span>从此处克隆线程</span>
                                  </ContextMenuItem>
                                </ContextMenuGroup>
                              </ContextMenuContent>
                            </ContextMenu>
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
                      <ContextMenu key={segment.key}>
                        <ContextMenuTrigger className="w-full">
                          <Bubble variant="ghost">
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
                        </ContextMenuTrigger>
                        <ContextMenuContent className="w-48">
                          <ContextMenuGroup>
                            <ContextMenuItem onClick={() => handleCopy()}>
                              <CopyIcon className="text-muted-foreground" />
                              <span>复制回答内容</span>
                              <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => onRetry(message.id)}>
                              <RefreshCcwIcon className="text-muted-foreground" />
                              <span>重新生成</span>
                              <ContextMenuShortcut>⌘R</ContextMenuShortcut>
                            </ContextMenuItem>
                          </ContextMenuGroup>
                          <ContextMenuSeparator />
                          <ContextMenuGroup>
                            <ContextMenuItem
                              onClick={() => onCloneMessage(message.id, messageIndex)}
                            >
                              <MessageSquarePlusIcon className="text-muted-foreground" />
                              <span>克隆此轮对话</span>
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => onClone(messageIndex)}>
                              <GitForkIcon className="text-muted-foreground" />
                              <span>从此处克隆线程</span>
                            </ContextMenuItem>
                          </ContextMenuGroup>
                        </ContextMenuContent>
                      </ContextMenu>
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
      </BlurFade>
    </MessageScrollerItem>
  );
});
