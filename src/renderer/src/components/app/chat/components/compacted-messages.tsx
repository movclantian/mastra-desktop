import type { UIMessage } from "ai";
import { CheckIcon, PencilIcon, XIcon } from "lucide-react";
import * as React from "react";
import { MessageResponse } from "@/components/ai-elements/message";
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
import { Textarea } from "@/components/ui/textarea";
import { AssistantAvatar, UserAvatar } from "./avatars";
import type { CompactedHistoryEntry } from "../types";

// ---------------------------------------------------------------------------
// 压缩历史:线程被 summarize 重写后,线程头部出现一条摘要消息卡片;展开可
// 查看被折叠的原始消息(历史不丢失,只是退出模型上下文)。
// ---------------------------------------------------------------------------

/** 展开的压缩历史使用普通消息气泡渲染,但不再参与当前会话请求。 */
function CompactedHistoryMessage({
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
