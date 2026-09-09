import type { FileUIPart, UIMessage } from "ai";
import {
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  PencilIcon,
  RefreshCcwIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { MASTRA_SERVER_URL } from "@/shared/api";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/shared/ui/attachment";
import { Badge } from "@/shared/ui/badge";
import { BlurFade } from "@/shared/ui/blur-fade";
import { Bubble, BubbleContent } from "@/shared/ui/bubble";
import { Button } from "@/shared/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import { DotmSquare3 } from "@/shared/ui/dotm-square-3";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/shared/ui/message";
import { MessageScrollerItem } from "@/shared/ui/message-scroller";
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
import { CompactedMessageCard } from "./compacted-messages";

function AssistantPendingIndicator({
  variant = "initial",
}: {
  variant?: "initial" | "after-tool" | "after-interaction";
}) {
  const words =
    variant === "after-tool"
      ? ["已获取工具结果，正在组织回复…", "正在分析工具返回数据…", "正在综合信息生成解答…"]
      : variant === "after-interaction"
        ? ["已收到交互反馈，正在继续执行…", "正在组织下一步回复…"]
        : ["正在深度思考与规划…", "正在解析指令与上下文…", "正在检索工具库与工作区…"];

  return (
    <div className="flex items-center gap-2 py-1.5 text-xs font-medium text-muted-foreground animate-in fade-in duration-200">
      <DotmSquare3 size={15} dotSize={2} colorPreset="solid-theme" />
      <WordRotate
        words={words}
        duration={2200}
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
      // External and malformed URLs stay on their original value.
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
          className={`max-w-full gap-1 ${referenceBadgeClass("file", `${reference.id}:${reference.url}`)}`}
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
  isStreaming,
  onRetry,
  onEdit,
  userId,
  readOnly = false,
}: {
  message: UIMessage;
  isStreaming: boolean;
  onRetry: (messageId: string) => void;
  onEdit: (messageId: string, text: string) => void;
  userId: string;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [editText, setEditText] = React.useState("");
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

  if ((message.metadata as { compactedHistory?: unknown } | undefined)?.compactedHistory) {
    return <CompactedMessageCard message={message} userId={userId} />;
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
  const citationEntries = buildCitationEntries(message.parts);
  const actionFooterClassName =
    "gap-1 px-0 opacity-0 transition-opacity duration-150 pointer-events-none group-hover/message:pointer-events-auto group-hover/message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100";
  const bubbleActionFooterClassName =
    "gap-1 px-0 opacity-0 transition-opacity duration-150 pointer-events-none group-hover/actions:pointer-events-auto group-hover/actions:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100";

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
  const editControls = (
    <>
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
    </>
  );

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
                  <div className="flex justify-end gap-1">{editControls}</div>
                </div>
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
                          <ContextMenuItem onClick={handleCopy}>
                            <CopyIcon className="text-muted-foreground" />
                            <span>复制内容</span>
                            <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                          </ContextMenuItem>
                          {!readOnly ? (
                            <ContextMenuItem onClick={startEditing}>
                              <PencilIcon className="text-muted-foreground" />
                              <span>编辑消息</span>
                            </ContextMenuItem>
                          ) : null}
                        </ContextMenuGroup>
                      </ContextMenuContent>
                    </ContextMenu>
                  ) : null}
                  {!readOnly ? (
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
                        <ContextMenuItem onClick={handleCopy}>
                          <CopyIcon className="text-muted-foreground" />
                          <span>复制回答内容</span>
                          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                        </ContextMenuItem>
                        {!readOnly ? (
                          <ContextMenuItem onClick={() => onRetry(message.id)}>
                            <RefreshCcwIcon className="text-muted-foreground" />
                            <span>重新生成</span>
                            <ContextMenuShortcut>⌘R</ContextMenuShortcut>
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
            {!isStreaming ? (
              <MessageFooter className={actionFooterClassName}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="复制"
                  title="复制"
                  onClick={handleCopy}
                >
                  <CopyIcon />
                </Button>
                {!readOnly ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="重试"
                    title="重试"
                    onClick={() => onRetry(message.id)}
                  >
                    <RefreshCcwIcon />
                  </Button>
                ) : null}
              </MessageFooter>
            ) : null}
          </MessageContent>
        </Message>
      </BlurFade>
    </MessageScrollerItem>
  );
});
