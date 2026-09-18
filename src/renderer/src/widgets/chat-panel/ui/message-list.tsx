import type { FileUIPart, UIMessage } from "ai";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GitForkIcon,
  PencilIcon,
  RefreshCcwIcon,
  SmilePlusIcon,
  SparklesIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XIcon,
} from "lucide-react";
import { search as searchEmojis } from "node-emoji";
import * as React from "react";
import { toast } from "sonner";
import { MASTRA_SERVER_URL } from "@/shared/api";
import { formatShortcutDisplay, isMacPlatform } from "@/shared/config/shortcut-menu";
import { useTranslation } from "@/shared/i18n";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/shared/ui/attachment";
import { Badge } from "@/shared/ui/badge";
import { BlurFade } from "@/shared/ui/blur-fade";
import { Bubble, BubbleContent, BubbleReactions } from "@/shared/ui/bubble";
import { Button, buttonVariants } from "@/shared/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import { DotmSquare3 } from "@/shared/ui/dotm-square-3";
import { Input } from "@/shared/ui/input";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/shared/ui/message";
import { MessageScrollerItem } from "@/shared/ui/message-scroller";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Textarea } from "@/shared/ui/textarea";
import { WordRotate } from "@/shared/ui/word-rotate";
import { fetchChatAssetBlob } from "../api/chat-api";
import {
  buildCitationEntries,
  createCitationRehypePlugins,
  withResolvedFootnotes,
} from "../lib/citation-utils";
import {
  asString,
  getAssistantSegments,
  getPlanDraft,
  getTraceStepStatus,
  type MessageFileReference,
  type MessageReaction,
  referenceBadgeClass,
} from "../model/types";
import {
  AssistantAvatar,
  CitationProvider,
  FootnoteCitation,
  MarkdownSection,
  UserAvatar,
} from "./";
import { AgentInteractionHistory } from "./agent-panels";
import { AssistantTrace } from "./assistant-trace";

function AssistantPendingIndicator({
  variant = "initial",
}: {
  variant?: "initial" | "after-tool" | "after-interaction";
}) {
  const { t } = useTranslation();
  const words = React.useMemo(() => {
    const key =
      variant === "after-tool"
        ? "chat:messages.pendingAfterTool"
        : variant === "after-interaction"
          ? "chat:messages.pendingAfterInteraction"
          : "chat:messages.pendingInitial";
    const translated = t(key, { returnObjects: true });
    return Array.isArray(translated) ? (translated as string[]) : [];
  }, [variant, t]);

  return (
    <div className="flex items-center gap-2 py-1.5 text-xs font-medium text-muted-foreground animate-in fade-in duration-200">
      <DotmSquare3 size={15} dotSize={2} colorPreset="solid-theme" />
      <WordRotate
        words={words}
        duration={6000}
        className="text-xs font-medium text-muted-foreground"
      />
    </div>
  );
}

const CITATION_MARKDOWN_COMPONENTS = { section: MarkdownSection, sup: FootnoteCitation };
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
      {files.map((file) => (
        <MessageAttachment
          file={file}
          key={`${messageId}-${file.url}-${file.filename ?? file.mediaType ?? "file"}`}
        />
      ))}
    </AttachmentGroup>
  );
}

function MessageAttachment({ file }: { file: FileUIPart }) {
  const { t } = useTranslation();
  const isImage = file.mediaType?.startsWith("image/") ?? false;
  const title = file.filename ?? t("chat:messages.untitledAttachment");
  const [resolvedUrl, setResolvedUrl] = React.useState(file.url);
  const [loadState, setLoadState] = React.useState<"processing" | "error" | "done">("done");

  React.useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    setResolvedUrl(file.url);
    let isMastraResource = false;
    try {
      isMastraResource =
        new URL(file.url, window.location.href).origin === new URL(MASTRA_SERVER_URL).origin;
    } catch {
      // External and malformed URLs stay on their original value.
    }
    if (!isMastraResource) {
      setLoadState("done");
      return () => undefined;
    }
    setLoadState("processing");
    void fetchChatAssetBlob(file.url)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (disposed) {
          URL.revokeObjectURL(objectUrl);
        } else {
          setResolvedUrl(objectUrl);
          setLoadState("done");
        }
      })
      .catch(() => {
        if (!disposed) setLoadState("error");
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.url]);

  return (
    <Attachment size="sm" state={loadState} className="max-w-[min(100%,18rem)]">
      <AttachmentMedia variant={isImage ? "image" : "icon"}>
        {isImage && loadState === "done" && resolvedUrl ? (
          <img src={resolvedUrl} alt={title} />
        ) : (
          <FileTextIcon aria-hidden="true" />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{title}</AttachmentTitle>
        <AttachmentDescription>
          {loadState === "error"
            ? t("chat:messages.loadFailed")
            : loadState === "processing"
              ? t("chat:messages.loading")
              : file.mediaType || t("chat:messages.file")}
        </AttachmentDescription>
      </AttachmentContent>
      {loadState === "done" && resolvedUrl ? (
        <>
          <AttachmentActions>
            <AttachmentAction
              aria-label={t("chat:messages.openAttachment", { title })}
              render={<a href={resolvedUrl} rel="noreferrer" target="_blank" />}
              title={t("chat:messages.openAttachment", { title })}
            >
              <ExternalLinkIcon />
            </AttachmentAction>
            <AttachmentAction
              aria-label={t("chat:messages.downloadAttachment", { title })}
              render={<a download={title} href={resolvedUrl} />}
              title={t("chat:messages.downloadAttachment", { title })}
            >
              <DownloadIcon />
            </AttachmentAction>
            <AttachmentAction
              aria-label={t("chat:messages.copyAttachmentAddress", { title })}
              onClick={() => {
                void navigator.clipboard.writeText(file.url);
                toast.success(t("chat:messages.attachmentAddressCopied"));
              }}
              title={t("chat:messages.copyAttachmentAddress", { title })}
            >
              <CopyIcon />
            </AttachmentAction>
          </AttachmentActions>
          <AttachmentTrigger
            render={
              <a
                href={resolvedUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={t("chat:messages.openAttachment", {
                  title,
                })}
              />
            }
          />
        </>
      ) : null}
    </Attachment>
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
      typeof item.url === "string" &&
      (item.mediaType === undefined || typeof item.mediaType === "string")
    );
  });
}

function getMessageFiles(message: UIMessage, references: MessageFileReference[]): FileUIPart[] {
  const files = message.parts.filter((part): part is FileUIPart => part.type === "file");
  const urls = new Set(files.map((file) => file.url));
  return [
    ...files,
    ...references
      .filter((reference) => !urls.has(reference.url))
      .map(
        (reference): FileUIPart => ({
          type: "file",
          url: reference.url,
          filename: reference.filename,
          mediaType: reference.mediaType ?? "application/octet-stream",
        }),
      ),
  ];
}

function getMessageReactions(message: UIMessage): MessageReaction[] {
  const raw = (message.metadata as { reactions?: unknown } | undefined)?.reactions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((reaction): reaction is MessageReaction => {
    if (typeof reaction !== "object" || reaction === null) return false;
    const item = reaction as Record<string, unknown>;
    return (
      typeof item.emoji === "string" &&
      item.emoji.length > 0 &&
      Array.isArray(item.userIds) &&
      item.userIds.every((id) => typeof id === "string")
    );
  });
}

function hasUserReaction(reactions: MessageReaction[], emoji: string, userId: string): boolean {
  return reactions.some(
    (reaction) => reaction.emoji === emoji && reaction.userIds.includes(userId),
  );
}

const ALL_EMOJI_OPTIONS = searchEmojis("");
const EMOJI_BATCH_SIZE = 80;

function ReactionPickerButton({
  messageId,
  onToggleReaction,
}: {
  messageId: string;
  onToggleReaction: (messageId: string, emoji: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [visibleCount, setVisibleCount] = React.useState(EMOJI_BATCH_SIZE);
  const filteredEmojis = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return ALL_EMOJI_OPTIONS;
    return ALL_EMOJI_OPTIONS.filter(
      ({ emoji, name }) =>
        emoji.includes(normalizedQuery) || name.toLowerCase().includes(normalizedQuery),
    );
  }, [query]);

  const selectEmoji = (emoji: string) => {
    onToggleReaction(messageId, emoji);
    setOpen(false);
    setQuery("");
    setVisibleCount(EMOJI_BATCH_SIZE);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setQuery("");
          setVisibleCount(EMOJI_BATCH_SIZE);
        }
      }}
    >
      <PopoverTrigger
        aria-label={t("chat:messages.addReaction")}
        className={buttonVariants({ variant: "ghost", size: "icon-xs" })}
        data-slot="button"
        title={t("chat:messages.reaction")}
        type="button"
      >
        <SmilePlusIcon />
      </PopoverTrigger>
      {open ? (
        <PopoverContent align="end" className="w-80 gap-2 p-2">
          <Input
            aria-label={t("chat:messages.searchReactions")}
            onChange={(event) => {
              setQuery(event.target.value);
              setVisibleCount(EMOJI_BATCH_SIZE);
            }}
            placeholder={t("chat:messages.searchReactions")}
            value={query}
          />
          <ScrollArea className="h-64 w-full">
            <div className="grid grid-cols-8 gap-0.5 pr-2">
              {filteredEmojis.length > 0 ? (
                filteredEmojis.slice(0, visibleCount).map(({ emoji, name }) => (
                  <Button
                    aria-label={t("chat:messages.reactionWithEmoji", { emoji })}
                    className="text-base leading-none"
                    key={name}
                    onClick={() => selectEmoji(emoji)}
                    size="icon-sm"
                    title={`:${name}:`}
                    type="button"
                    variant="ghost"
                  >
                    {emoji}
                  </Button>
                ))
              ) : (
                <span className="col-span-full py-6 text-center text-xs text-muted-foreground">
                  {t("chat:messages.noReactionsFound")}
                </span>
              )}
              {visibleCount < filteredEmojis.length ? (
                <Button
                  className="col-span-full w-full"
                  onClick={() => setVisibleCount((count) => count + EMOJI_BATCH_SIZE)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {t("chat:messages.moreReactions", {
                    count: filteredEmojis.length - visibleCount,
                  })}
                </Button>
              ) : null}
            </div>
          </ScrollArea>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/** 气泡角标上的已有反应(官方 BubbleReactions):点击切换本人反应 */
function MessageBubbleReactions({
  messageId,
  reactions,
  userId,
  onToggleReaction,
}: {
  messageId: string;
  reactions: MessageReaction[];
  userId: string;
  onToggleReaction: (messageId: string, emoji: string) => void;
}) {
  const { t } = useTranslation();
  if (reactions.length === 0) return null;
  return (
    <BubbleReactions aria-label={t("chat:messages.messageReactions")}>
      {reactions.map((reaction) => (
        <button
          aria-label={t("chat:messages.reactionsCount", {
            emoji: reaction.emoji,
            count: reaction.userIds.length,
          })}
          aria-pressed={reaction.userIds.includes(userId)}
          className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs transition-colors hover:bg-accent aria-pressed:bg-accent"
          key={reaction.emoji}
          onClick={() => onToggleReaction(messageId, reaction.emoji)}
          type="button"
        >
          <span>{reaction.emoji}</span>
          {reaction.userIds.length > 1 ? (
            <span className="text-muted-foreground">{reaction.userIds.length}</span>
          ) : null}
        </button>
      ))}
    </BubbleReactions>
  );
}

export const MessageItem = React.memo(function MessageItem({
  message,
  isStreaming,
  isGenerating = false,
  onRetry,
  onEdit,
  userId,
  readOnly = false,
  showAvatar = true,
  sendFailed = false,
  onRetrySend,
  onToggleReaction,
  onForkFromMessage,
}: {
  message: UIMessage;
  isStreaming: boolean;
  /** Hide actions for every message while the thread is generating. */
  isGenerating?: boolean;
  onRetry: (messageId: string) => void;
  onEdit: (messageId: string, text: string) => void;
  userId: string;
  readOnly?: boolean;
  /** MessageGroup 分组中隐藏头像:连续同一发送者仅末条展示头像(官方 message-group) */
  showAvatar?: boolean;
  /** 用户消息发送失败:常驻"发送失败 + 行内重试"(官方 message-actions) */
  sendFailed?: boolean;
  onRetrySend?: () => void;
  /** 表情反应切换(官方 BubbleReactions 业务对接) */
  onToggleReaction?: (messageId: string, emoji: string) => void;
  /** 从该消息处创建分支(官方 cloneThread 的 messageFilter 截断点) */
  onForkFromMessage?: (messageId: string) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = React.useState(false);
  const [editText, setEditText] = React.useState("");
  const isUser = message.role === "user";
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  React.useEffect(() => {
    if (!editing) setEditText(text);
  }, [editing, text]);

  const assistantSegments = isUser ? [] : getAssistantSegments(message.parts, message.id);
  // 官方 message-demo:reactions 角标只挂在合并消息的最后一个文本气泡上
  const lastTextSegment = [...assistantSegments]
    .reverse()
    .find((segment) => segment.type === "text");
  const skillNames = Array.isArray(
    (message.metadata as { skillNames?: unknown } | undefined)?.skillNames,
  )
    ? (message.metadata as { skillNames: unknown[] }).skillNames.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : [];
  const fileReferences = getMessageFileReferences(message);
  const files = getMessageFiles(message, fileReferences);
  const reactions = getMessageReactions(message);
  const citationEntries = buildCitationEntries(message.parts);
  const actionFooterClassName =
    "gap-1 px-0 opacity-0 transition-opacity duration-150 pointer-events-none group-hover/message:pointer-events-auto group-hover/message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100";
  const bubbleActionFooterClassName =
    "gap-1 px-0 opacity-0 transition-opacity duration-150 pointer-events-none group-hover/actions:pointer-events-auto group-hover/actions:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100";
  const hideActions = isStreaming || isGenerating;
  const canReact = !hideActions && onToggleReaction !== undefined;
  const isMac = React.useMemo(() => isMacPlatform(), []);

  const handleCopy = () => {
    void navigator.clipboard.writeText(text);
    toast.success(t("chat:messages.copiedToClipboard"));
  };

  const handleUserBubbleKeyDown = (event: React.KeyboardEvent) => {
    if (event.isComposing) return;
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (mod && (event.key === "c" || event.key === "C") && !window.getSelection()?.toString()) {
      event.preventDefault();
      handleCopy();
    }
  };

  const handleAssistantBubbleKeyDown = (event: React.KeyboardEvent) => {
    if (event.isComposing) return;
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (mod && (event.key === "c" || event.key === "C") && !window.getSelection()?.toString()) {
      event.preventDefault();
      handleCopy();
    } else if (mod && (event.key === "r" || event.key === "R") && !readOnly) {
      event.preventDefault();
      onRetry(message.id);
    }
  };
  const startEditing = () => {
    setEditText(text);
    setEditing(true);
  };
  const editControls = (
    <>
      <Button
        aria-label={t("chat:messages.cancelEdit")}
        onClick={() => setEditing(false)}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <XIcon />
      </Button>
      <Button
        aria-label={t("chat:messages.saveEdit")}
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
    </>
  );

  if (isUser) {
    return (
      <MessageScrollerItem messageId={message.id} scrollAnchor>
        <BlurFade duration={0.2} blur="3px">
          <Message align="end">
            {/* 官方 message-group:分组中非末条消息渲染空头像占位,视觉上折叠连续消息 */}
            <MessageAvatar className="self-start group-has-data-[slot=message-footer]/message:translate-y-0">
              {showAvatar ? <UserAvatar userId={userId} /> : null}
            </MessageAvatar>
            <MessageContent className="items-end">
              {editing ? (
                <div className="flex w-full max-w-2xl self-end flex-col items-end gap-2">
                  <Textarea
                    autoFocus
                    className="min-h-20 w-full resize-y"
                    onChange={(event) => setEditText(event.target.value)}
                    value={editText}
                  />
                  <div className="flex justify-end gap-1">{editControls}</div>
                </div>
              ) : (
                <div className="group/actions flex w-fit max-w-full flex-col items-end gap-0.5">
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
                      <ContextMenuTrigger className="max-w-full" onKeyDown={handleUserBubbleKeyDown}>
                        <Bubble
                          align="end"
                          className="max-w-full"
                          variant={sendFailed ? "destructive" : "default"}
                        >
                          <BubbleContent>{text}</BubbleContent>
                          {canReact ? (
                            <MessageBubbleReactions
                              messageId={message.id}
                              onToggleReaction={onToggleReaction}
                              reactions={reactions}
                              userId={userId}
                            />
                          ) : null}
                        </Bubble>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-48">
                        <ContextMenuGroup>
                          <ContextMenuItem onClick={handleCopy}>
                            <CopyIcon className="text-muted-foreground" />
                            <span>{t("chat:messages.copyContent")}</span>
                            <ContextMenuShortcut>{formatShortcutDisplay(["Mod", "C"], isMac)}</ContextMenuShortcut>
                          </ContextMenuItem>
                          {!readOnly ? (
                            <ContextMenuItem onClick={startEditing}>
                              <PencilIcon className="text-muted-foreground" />
                              <span>{t("chat:messages.editMessage")}</span>
                            </ContextMenuItem>
                          ) : null}
                          {onForkFromMessage ? (
                            <ContextMenuItem onClick={() => onForkFromMessage(message.id)}>
                              <GitForkIcon className="text-muted-foreground" />
                              <span>{t("chat:messages.forkFromMessage")}</span>
                            </ContextMenuItem>
                          ) : null}
                        </ContextMenuGroup>
                      </ContextMenuContent>
                    </ContextMenu>
                  ) : null}
                  {sendFailed && onRetrySend ? (
                    // 官方 message-actions:发送失败在 MessageFooter 常驻失败提示与行内重试
                    <MessageFooter className="gap-2">
                      <span className="font-normal text-destructive">
                        {t("chat:messages.sendFailed")}
                      </span>
                      <Button
                        aria-label={t("chat:messages.retrySend")}
                        onClick={onRetrySend}
                        size="icon-xs"
                        title={t("chat:messages.retry")}
                        type="button"
                        variant="ghost"
                      >
                        <RefreshCcwIcon />
                      </Button>
                    </MessageFooter>
                  ) : !readOnly ? (
                    <MessageFooter
                      className={
                        hideActions
                          ? `${bubbleActionFooterClassName} invisible`
                          : bubbleActionFooterClassName
                      }
                    >
                      {canReact ? (
                        <ReactionPickerButton
                          messageId={message.id}
                          onToggleReaction={onToggleReaction}
                        />
                      ) : null}
                      {onForkFromMessage ? (
                        <Button
                          aria-label={t("chat:messages.forkFromMessage")}
                          onClick={() => onForkFromMessage(message.id)}
                          size="icon-xs"
                          title={t("chat:messages.forkFromMessage")}
                          type="button"
                          variant="ghost"
                        >
                          <GitForkIcon />
                        </Button>
                      ) : null}
                      <Button
                        aria-label={t("chat:messages.editMessage")}
                        onClick={startEditing}
                        size="icon-xs"
                        title={t("chat:messages.edit")}
                        type="button"
                        variant="ghost"
                      >
                        <PencilIcon />
                      </Button>
                    </MessageFooter>
                  ) : null}
                </div>
              )}
            </MessageContent>
          </Message>
        </BlurFade>
      </MessageScrollerItem>
    );
  }

  return (
    <MessageScrollerItem messageId={message.id}>
      <BlurFade duration={0.2} blur="3px">
        <Message>
          <MessageAvatar className="self-start group-has-data-[slot=message-footer]/message:translate-y-0">
            <AssistantAvatar />
          </MessageAvatar>
          <MessageContent>
            <MessageHeader className="px-0">MastraWork</MessageHeader>
            <MessageAttachments files={files} messageId={message.id} />
            {isStreaming && assistantSegments.length === 0 ? (
              <AssistantPendingIndicator variant="initial" />
            ) : null}
            <CitationProvider entries={citationEntries}>
              {assistantSegments.map((segment) =>
                segment.type === "event" ? (
                  <Bubble className="max-w-full" key={segment.key} variant="tinted">
                    <BubbleContent className="text-xs">{segment.text}</BubbleContent>
                  </Bubble>
                ) : segment.type === "trace" ? (
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
                    <ContextMenuTrigger className="w-full" onKeyDown={handleAssistantBubbleKeyDown}>
                      <Bubble variant="ghost">
                        <BubbleContent>
                          <MessageResponse
                            components={CITATION_MARKDOWN_COMPONENTS}
                            rehypePlugins={CITATION_REHYPE_PLUGINS}
                          >
                            {withResolvedFootnotes(segment.text, citationEntries)}
                          </MessageResponse>
                        </BubbleContent>
                        {canReact && segment === lastTextSegment ? (
                          <MessageBubbleReactions
                            messageId={message.id}
                            onToggleReaction={onToggleReaction}
                            reactions={reactions}
                            userId={userId}
                          />
                        ) : null}
                      </Bubble>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-48">
                      <ContextMenuGroup>
                        <ContextMenuItem onClick={handleCopy}>
                          <CopyIcon className="text-muted-foreground" />
                          <span>{t("chat:messages.copyAnswer")}</span>
                          <ContextMenuShortcut>{formatShortcutDisplay(["Mod", "C"], isMac)}</ContextMenuShortcut>
                        </ContextMenuItem>
                        {onForkFromMessage ? (
                          <ContextMenuItem onClick={() => onForkFromMessage(message.id)}>
                            <GitForkIcon className="text-muted-foreground" />
                            <span>{t("chat:messages.forkFromMessage")}</span>
                          </ContextMenuItem>
                        ) : null}
                        {!readOnly ? (
                          <ContextMenuItem onClick={() => onRetry(message.id)}>
                            <RefreshCcwIcon className="text-muted-foreground" />
                            <span>{t("chat:messages.regenerate")}</span>
                            <ContextMenuShortcut>{formatShortcutDisplay(["Mod", "R"], isMac)}</ContextMenuShortcut>
                          </ContextMenuItem>
                        ) : null}
                      </ContextMenuGroup>
                    </ContextMenuContent>
                  </ContextMenu>
                ),
              )}
              {isStreaming &&
                assistantSegments.length > 0 &&
                (() => {
                  const lastSegment = assistantSegments[assistantSegments.length - 1];
                  if (lastSegment.type === "trace") {
                    const hasActiveStep = lastSegment.parts.some(
                      (part) => getTraceStepStatus(part) === "active",
                    );
                    if (!hasActiveStep) return <AssistantPendingIndicator variant="after-tool" />;
                  } else if (lastSegment.type === "interaction") {
                    return <AssistantPendingIndicator variant="after-interaction" />;
                  }
                  return null;
                })()}
            </CitationProvider>
            <MessageFooter
              className={hideActions ? `${actionFooterClassName} invisible` : actionFooterClassName}
            >
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("chat:messages.copyContent")}
                title={t("chat:messages.copyContent")}
                onClick={handleCopy}
              >
                <CopyIcon />
              </Button>
              {canReact ? (
                <>
                  {/* 官方 message-actions:助手消息 Like / Dislike 评分操作 */}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("chat:messages.like")}
                    aria-pressed={hasUserReaction(reactions, "👍", userId)}
                    title={t("chat:messages.like")}
                    className={
                      hasUserReaction(reactions, "👍", userId) ? "text-primary" : undefined
                    }
                    onClick={() => onToggleReaction?.(message.id, "👍")}
                  >
                    <ThumbsUpIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("chat:messages.dislike")}
                    aria-pressed={hasUserReaction(reactions, "👎", userId)}
                    title={t("chat:messages.dislike")}
                    className={
                      hasUserReaction(reactions, "👎", userId) ? "text-primary" : undefined
                    }
                    onClick={() => onToggleReaction?.(message.id, "👎")}
                  >
                    <ThumbsDownIcon />
                  </Button>
                  <ReactionPickerButton
                    messageId={message.id}
                    onToggleReaction={onToggleReaction}
                  />
                </>
              ) : null}
              {onForkFromMessage ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("chat:messages.forkFromMessage")}
                  title={t("chat:messages.forkFromMessage")}
                  onClick={() => onForkFromMessage(message.id)}
                >
                  <GitForkIcon />
                </Button>
              ) : null}
              {!readOnly ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("chat:messages.retry")}
                  title={t("chat:messages.retry")}
                  onClick={() => onRetry(message.id)}
                >
                  <RefreshCcwIcon />
                </Button>
              ) : null}
            </MessageFooter>
          </MessageContent>
        </Message>
      </BlurFade>
    </MessageScrollerItem>
  );
});
