import { MessageCircleIcon, SparklesIcon } from "lucide-react";
import * as React from "react";
import { type MessageSearchHit, useWorkbench } from "@/entities/workbench";
import { Badge } from "@/shared/ui/badge";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/shared/ui/command";
import { DotmCircular4 } from "@/shared/ui/dotm-circular-4";

/**
 * 线程消息检索弹窗(官方 Memory.recall 语义召回,服务端文本匹配兜底)。
 * 入口:「任务列表」分组标签右侧的搜索按钮(SidebarGroupAction)。
 * 点击结果:跳转到对应线程并滚动高亮具体气泡。
 */
export function ThreadSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { searchMessages, setActiveThreadId, setPendingJump } = useWorkbench();
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<MessageSearchHit[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const searchRequestRef = React.useRef(0);

  const runSearch = React.useCallback(
    async (value: string) => {
      const q = value.trim();
      const requestId = ++searchRequestRef.current;
      if (!q) {
        setHits(null);
        setSearching(false);
        return;
      }

      setSearching(true);
      try {
        const nextHits = await searchMessages(q);
        if (requestId === searchRequestRef.current) setHits(nextHits);
      } catch {
        if (requestId === searchRequestRef.current) setHits([]);
      } finally {
        if (requestId === searchRequestRef.current) setSearching(false);
      }
    },
    [searchMessages],
  );

  React.useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      void runSearch(query);
    }, 280);
    return () => window.clearTimeout(timer);
  }, [open, query, runSearch]);

  React.useEffect(() => {
    if (open) return;
    searchRequestRef.current += 1;
    setQuery("");
    setHits(null);
    setSearching(false);
  }, [open]);

  const jumpTo = (hit: MessageSearchHit) => {
    setActiveThreadId(hit.threadId);
    setPendingJump({ threadId: hit.threadId, messageId: hit.messageId });
    onOpenChange(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="检索线程消息"
      description="搜索全部会话中的消息"
      className="sm:max-w-2xl"
    >
      <Command shouldFilter={false}>
        <CommandInput
          autoFocus
          placeholder="输入消息内容，即时搜索…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList className="max-h-[min(60vh,32rem)]">
          {searching ? (
            <CommandEmpty className="flex items-center justify-center gap-2">
              <DotmCircular4 size={16} dotSize={1.8} colorPreset="solid-theme" />
              正在搜索…
            </CommandEmpty>
          ) : hits === null ? (
            <CommandEmpty>输入内容后会自动搜索</CommandEmpty>
          ) : hits.length === 0 ? (
            <CommandEmpty>没有匹配的消息</CommandEmpty>
          ) : (
            <CommandGroup heading="消息结果">
              {hits.map((hit) => (
                <CommandItem
                  key={`${hit.threadId}-${hit.messageId}`}
                  value={`${hit.threadTitle} ${hit.role} ${hit.text}`}
                  onSelect={() => jumpTo(hit)}
                  className="h-auto items-start gap-3 py-2.5"
                >
                  <MessageCircleIcon className="mt-0.5 size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {hit.threadTitle}
                      </span>
                      <span className="shrink-0">{hit.role === "user" ? "我" : "助手"}</span>
                      {hit.semantic ? (
                        <Badge variant="secondary" className="h-4 shrink-0 gap-1 px-1 text-[10px]">
                          <SparklesIcon className="size-2.5" />
                          语义
                        </Badge>
                      ) : null}
                      <span className="ml-auto shrink-0">
                        {new Date(hit.createdAt).toLocaleString()}
                      </span>
                    </span>
                    <span className="mt-1 line-clamp-2 text-sm text-foreground">{hit.text}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
