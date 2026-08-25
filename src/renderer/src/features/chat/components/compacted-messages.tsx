import type { UIMessage } from "ai";
import * as React from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import type { CompactedHistoryEntry } from "../types";
import { AssistantAvatar, UserAvatar } from "./avatars";

// ---------------------------------------------------------------------------
// 压缩历史:线程被 summarize 重写后,线程头部出现一条摘要消息卡片;展开可
// 查看被折叠的原始消息(历史不丢失,只是退出模型上下文)。
// ---------------------------------------------------------------------------

/** 展开的压缩历史使用普通消息气泡渲染,但不再参与当前会话请求。 */
function CompactedHistoryMessage({
  entry,
  userId,
}: {
  entry: CompactedHistoryEntry;
  userId: string;
}) {
  if (entry.role === "user") {
    return (
      <Message align="end">
        <MessageAvatar className="self-start group-has-data-[slot=message-footer]/message:translate-y-0">
          <UserAvatar userId={userId} />
        </MessageAvatar>
        <MessageContent className="items-end">
          {entry.text ? (
            <Bubble>
              <BubbleContent>{entry.text}</BubbleContent>
            </Bubble>
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
export function CompactedMessageCard({ message, userId }: { message: UIMessage; userId: string }) {
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
              <CompactedHistoryMessage entry={entry} key={entry.id} userId={userId} />
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
