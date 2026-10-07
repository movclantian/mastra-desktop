import { useQuery } from "@tanstack/react-query";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useInvalidateThreads, useThreadsQuery } from "@/entities/workbench/model/queries/threads";
import type { WorkThread } from "@/entities/workbench/model/types";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/shared/ui/message-scroller";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Textarea } from "@/shared/ui/textarea";
import { abortThread, fetchDisplayState } from "../api/chat-api";
import { buildDisplayMessages } from "../lib/display";
import { type AgentInteraction, asRecord, parseSuspendedRuns } from "../model/types";
import { useSessionView, useThreadSessions } from "../model/use-thread-sessions";
import { AgentInteractionPanel } from "./agent-panels";
import { MessageItem } from "./message-list";
import {
  MessageQuoteCards,
  MessageSelectionScope,
  quotedPrompt,
  useMessageQuotes,
} from "./message-selection";

/** A regular controller Session with its own thread; quotes are the only imported conversation context. */
export function AuxiliaryChat({ threadId, active }: { threadId: string; active: boolean }) {
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const threadsQuery = useThreadsQuery(userId);
  const thread = threadsQuery.data?.find((item) => item.id === threadId);
  return thread ? <AuxiliaryThreadChat thread={thread} userId={userId} active={active} /> : null;
}

function AuxiliaryThreadChat({
  thread,
  userId,
  active,
}: {
  thread: WorkThread;
  userId: string;
  active: boolean;
}) {
  const { t } = useTranslation();
  const threadId = thread.id;
  const parentThreadId = useWorkbenchStore((state) => state.lastKnownThreadId);
  const invalidateThreads = useInvalidateThreads();
  const quotes = useMessageQuotes(threadId);
  const removeQuotes = useWorkbenchStore((state) => state.removeMessageQuotes);
  const [text, setText] = React.useState("");
  const [resumingKeys, setResumingKeys] = React.useState<Set<string>>(new Set());
  const pendingCommand = React.useRef(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const interactionsQuery = useQuery({
    queryKey: ["auxiliary-interactions", userId, threadId],
    queryFn: async () =>
      parseSuspendedRuns((await fetchDisplayState(threadId, userId)).displayState?.suspendedRuns),
  });
  const { getThreadSession } = useThreadSessions(
    userId,
    () => (parentThreadId ? { workspaceSourceThreadId: parentThreadId } : {}),
    (id, busy) => useWorkbenchStore.getState().setThreadBusy(id, busy),
    () => {
      void interactionsQuery.refetch();
      void invalidateThreads(userId);
    },
  );
  const session = getThreadSession(threadId);
  const { messages, status } = useSessionView(session);
  const busy = status === "submitted" || status === "streaming";
  const interactions = interactionsQuery.data ?? [];
  const display = React.useMemo(() => buildDisplayMessages(messages, busy), [messages, busy]);
  React.useEffect(() => {
    if (active) textareaRef.current?.focus();
  }, [active, quotes]);
  const send = async () => {
    if (
      pendingCommand.current ||
      busy ||
      interactions.length ||
      interactionsQuery.isPending ||
      interactionsQuery.isError ||
      !thread ||
      !text.trim()
    )
      return;
    pendingCommand.current = true;
    const draft = text;
    try {
      await session.send({ text: quotedPrompt(draft.trim(), quotes) });
      setText((current) => (current === draft ? "" : current));
      removeQuotes(
        threadId,
        quotes.map((quote) => quote.id),
      );
    } catch {
      /* The Session reports the error and the draft remains available. */
    } finally {
      pendingCommand.current = false;
    }
  };
  const resume = async (interaction: AgentInteraction, resumeData: unknown) => {
    if (pendingCommand.current || !interaction.toolCallId) return;
    pendingCommand.current = true;
    setResumingKeys(new Set([`${threadId}:${interaction.key}`]));
    try {
      const decision = asRecord(resumeData);
      await session.respond(
        interaction.toolCallId,
        interaction.requiresApproval
          ? {
              approved: decision?.approved === true,
              reason: typeof decision?.reason === "string" ? decision.reason : undefined,
            }
          : { resumeData },
      );
    } catch {
      /* The Session reports command failures. */
    } finally {
      pendingCommand.current = false;
      setResumingKeys(new Set());
      void interactionsQuery.refetch();
    }
  };
  return (
    <div className="flex size-full min-h-0 min-w-0 flex-col" data-slot="auxiliary-chat">
      <MessageSelectionScope thread={thread} userId={userId}>
        <MessageScrollerProvider
          autoScroll
          defaultScrollPosition="last-anchor"
          scrollPreviousItemPeek={24}
        >
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent className="px-3 py-3">
                {display.length ? (
                  display.map((entry, index) => (
                    <MessageItem
                      key={entry.key}
                      message={entry.message}
                      userId={userId}
                      readOnly
                      isGenerating={busy}
                      isStreaming={busy && index === display.length - 1}
                      onEdit={() => undefined}
                      onRetry={() => undefined}
                    />
                  ))
                ) : (
                  <p className="py-3 text-xs leading-relaxed text-muted-foreground">
                    {t("chat:selection.sideHint")}
                  </p>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </MessageSelectionScope>
      <ScrollArea className="max-h-[65%] min-w-0 shrink-0 border-t p-2">
        <ScrollArea className="max-h-[40vh]">
          <AgentInteractionPanel
            threadId={threadId}
            interactions={interactions}
            busyKeys={resumingKeys}
            onResume={(interaction, data) => void resume(interaction, data)}
          />
        </ScrollArea>
        {status === "error" && (
          <p role="status" className="px-1 py-1 text-xs text-destructive">
            {t("chat:selection.sideError")}
          </p>
        )}
        <form
          className="flex min-w-0 flex-col rounded-xl border bg-card"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <MessageQuoteCards quotes={quotes} onRemove={(id) => removeQuotes(threadId, [id])} />
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label={t("chat:selection.ask")}
            placeholder={t("chat:selection.sidePlaceholder")}
            className="min-h-20 max-h-36 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex min-w-0 items-center justify-between gap-2 px-2 pb-2">
            <span className="text-xs text-muted-foreground">
              {t("chat:selection.independentThread")}
            </span>
            {busy ? (
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                aria-label={t("chat:selection.stop")}
                onClick={() => {
                  if (session.store.getState().connection !== "connected") session.disconnect();
                  void abortThread(threadId, userId).catch((error) => toast.error(String(error)));
                }}
              >
                <SquareIcon />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon-sm"
                disabled={
                  !text.trim() ||
                  !thread ||
                  interactions.length > 0 ||
                  interactionsQuery.isPending ||
                  interactionsQuery.isError
                }
                aria-label={t("chat:selection.send")}
              >
                <ArrowUpIcon />
              </Button>
            )}
          </div>
        </form>
      </ScrollArea>
    </div>
  );
}
