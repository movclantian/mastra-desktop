import { useNavigate } from "@tanstack/react-router";
import { CopyIcon, MessageSquarePlusIcon, QuoteIcon, XIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { libraryAssetFromUrl } from "@/entities/library";
import { createThreadRequest, fetchThreads } from "@/entities/workbench/api/workbench-api";
import { useInvalidateThreads } from "@/entities/workbench/model/queries/threads";
import type { MessageQuote, WorkThread } from "@/entities/workbench/model/types";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useTranslation } from "@/shared/i18n";
import { MessageAnchor } from "@/shared/ui/ai-elements/message";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent } from "@/shared/ui/popover";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { WORKSPACE_FILE_FRAGMENT, workspacePathFromLink } from "../lib/citation-utils";

const MessageScope = React.createContext<WorkThread | undefined>(undefined);
const EMPTY_QUOTES: MessageQuote[] = [];

export function useMessageQuotes(threadId: string | null) {
  return useWorkbenchStore(
    (state) => (threadId ? state.messageQuotes[threadId] : undefined) ?? EMPTY_QUOTES,
  );
}

export function quotedPrompt(text: string, quotes: MessageQuote[]) {
  if (!quotes.length) return text;
  return `${quotes
    .map(
      (quote) =>
        `${quote.text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}`,
    )
    .join("\n\n")}\n\n${text}`;
}

export function MessageQuoteCards({
  quotes,
  onRemove,
}: {
  quotes: MessageQuote[];
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (!quotes.length) return null;
  return (
    <ScrollArea className="max-h-32 min-w-0 w-full" data-slot="message-quotes">
      <div className="flex flex-col gap-1 p-2">
        {quotes.map((quote) => (
          <div
            key={quote.id}
            className="flex min-w-0 items-start gap-1 rounded-md border bg-muted/40 px-2 py-1.5"
          >
            <QuoteIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <button
              type="button"
              className="min-w-0 flex-1 text-left text-xs hover:text-primary"
              title={quote.text}
              onClick={() => {
                useWorkbenchStore
                  .getState()
                  .setPendingJump({ threadId: quote.threadId, messageId: quote.messageId });
                void navigate({ to: "/chat", search: { thread: quote.threadId } });
              }}
            >
              <span className="line-clamp-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {quote.text}
              </span>
            </button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("chat:selection.removeQuote")}
              onClick={() => onRemove(quote.id)}
            >
              <XIcon />
            </Button>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

/** Keep Streamdown's normal link behavior; workspace references open the owned file preview. */
export function MessageLink({ node: _node, ...props }: React.ComponentProps<typeof MessageAnchor>) {
  const thread = React.useContext(MessageScope);
  const { t } = useTranslation();
  const asset = props.href
    ? libraryAssetFromUrl(
        props.href,
        props.title ||
          React.Children.toArray(props.children)
            .filter((child) => typeof child === "string")
            .join(""),
      )
    : null;
  if (asset)
    return (
      <button
        type="button"
        title={asset.filename}
        className={
          props.className ??
          "cursor-pointer break-words text-primary underline underline-offset-4 [overflow-wrap:anywhere]"
        }
        onClick={() => {
          const store = useWorkbenchStore.getState();
          if (store.lastKnownThreadId) store.requestFilePreview(store.lastKnownThreadId, asset);
        }}
      >
        {props.children}
      </button>
    );
  if (!props.href?.startsWith(WORKSPACE_FILE_FRAGMENT)) return <MessageAnchor {...props} />;
  return (
    <button
      type="button"
      className="cursor-pointer break-words text-primary underline underline-offset-4 [overflow-wrap:anywhere]"
      onClick={() => {
        let path: string | null = null;
        try {
          path = workspacePathFromLink(
            decodeURIComponent(props.href?.slice(WORKSPACE_FILE_FRAGMENT.length) ?? ""),
            thread?.metadata.workspacePath,
          );
        } catch {
          /* malformed link */
        }
        if (!thread || !path) {
          toast.error(t("chat:selection.outsideWorkspace"));
          return;
        }
        // The panel belongs to the main thread; auxiliary threads share its workspace.
        const store = useWorkbenchStore.getState();
        if (store.lastKnownThreadId) store.requestWorkspaceFile(store.lastKnownThreadId, path);
      }}
    >
      {props.children}
    </button>
  );
}

export function MessageSelectionScope({
  thread,
  userId,
  children,
}: {
  thread?: WorkThread;
  userId: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const [selection, setSelection] = React.useState<{ quote: MessageQuote; rect: DOMRect } | null>(
    null,
  );
  const [opening, setOpening] = React.useState(false);
  const openingRef = React.useRef(false);
  const invalidateThreads = useInvalidateThreads();
  React.useEffect(() => {
    setSelection(null);
    if (!thread) return;
    let frame = 0;
    let selecting = false;
    const inspect = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (selecting || toolbarRef.current?.contains(document.activeElement)) return;
        const selected = window.getSelection();
        const text = selected?.toString().trim();
        if (!selected || selected.isCollapsed || selected.rangeCount !== 1 || !text) {
          setSelection(null);
          return;
        }
        const range = selected.getRangeAt(0);
        const element = (node: Node) => (node instanceof Element ? node : node.parentElement);
        const start = element(range.startContainer);
        const end = element(range.endContainer);
        const region = start?.closest<HTMLElement>("[data-message-text]");
        if (
          !region ||
          region !== end?.closest("[data-message-text]") ||
          !rootRef.current?.contains(region) ||
          start?.closest("button,input,textarea,select,[contenteditable=true]") ||
          end?.closest("button,input,textarea,select,[contenteditable=true]")
        ) {
          setSelection(null);
          return;
        }
        const messageId = region.dataset.messageText;
        const rect = range.getBoundingClientRect();
        if (!messageId || (!rect.width && !rect.height)) {
          setSelection(null);
          return;
        }
        setSelection({
          quote: { id: crypto.randomUUID(), threadId: thread.id, messageId, text },
          rect,
        });
      });
    };
    const close = () => {
      window.cancelAnimationFrame(frame);
      setSelection(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) return;
      selecting = event.button === 0;
      close();
    };
    const onPointerUp = () => {
      selecting = false;
      inspect();
    };
    const onKey = (event: KeyboardEvent) => (event.key === "Escape" ? close() : inspect());
    document.addEventListener("selectionchange", inspect);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("keyup", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", inspect);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("keyup", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [thread?.id]);
  const dismiss = () => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };
  const askInSideChat = async () => {
    if (!selection || !thread || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    const store = useWorkbenchStore.getState();
    const parentId = store.lastKnownThreadId;
    const quote = selection.quote;
    try {
      let id = store.panelTabs.find((tab) => tab.kind === "chat")?.id;
      if (id && !(await fetchThreads(userId)).some((item) => item.id === id)) {
        store.forgetThread(id);
        id = undefined;
      }
      if (!id) {
        // Workspace binding is submitted with the first message, never through thread CRUD.
        const metadata = thread.metadata;
        const child = await createThreadRequest(userId, {
          title: `${t("chat:selection.auxiliary")} · ${quote.text.slice(0, 36)}`,
          metadata: {
            currentModeId: metadata.currentModeId,
            currentModelId: metadata.currentModelId,
            reasoningEffort: metadata.reasoningEffort,
          },
        });
        id = child.id;
        await invalidateThreads(userId);
      }
      if (useWorkbenchStore.getState().lastKnownThreadId !== parentId) return;
      store.addMessageQuote(id, quote);
      store.openAuxiliaryChat(id);
      dismiss();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common:error"));
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };
  return (
    <MessageScope.Provider value={thread}>
      <div ref={rootRef} className="contents" data-slot="message-selection-scope">
        {children}
      </div>
      <Popover
        open={selection !== null}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
      >
        <PopoverContent
          ref={toolbarRef}
          anchor={selection ? { getBoundingClientRect: () => selection.rect } : null}
          side="top"
          sideOffset={6}
          initialFocus={false}
          finalFocus={false}
          onPointerDown={(event) => event.preventDefault()}
          className="w-auto max-w-[calc(100vw-1rem)] flex-row flex-wrap gap-0.5 p-1"
          aria-label={t("chat:selection.actions")}
        >
          <Button
            variant="ghost"
            size="sm"
            disabled={opening}
            onClick={() => {
              if (!selection) return;
              void navigator.clipboard
                .writeText(selection.quote.text)
                .then(() => toast.success(t("common:copied")))
                .catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : t("common:error")),
                );
              dismiss();
            }}
          >
            <CopyIcon />
            {t("common:copy")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={opening}
            onClick={() => {
              const store = useWorkbenchStore.getState();
              if (selection && store.lastKnownThreadId)
                store.addMessageQuote(store.lastKnownThreadId, selection.quote);
              dismiss();
            }}
          >
            <QuoteIcon />
            {t("chat:selection.quote")}
          </Button>
          <Button variant="ghost" size="sm" disabled={opening} onClick={() => void askInSideChat()}>
            <MessageSquarePlusIcon />
            {t("chat:selection.ask")}
          </Button>
        </PopoverContent>
      </Popover>
    </MessageScope.Provider>
  );
}
