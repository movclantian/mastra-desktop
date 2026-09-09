import { CheckCircle2Icon, ChevronDownIcon, Code2Icon, FileDiffIcon, XIcon } from "lucide-react";
import * as React from "react";
import type { WorkspaceFileChange } from "@/entities/workbench";
import { cn } from "@/shared/lib";
import { CodeComparison } from "@/shared/ui/code-comparison";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import { changeLabel, changeLanguage, type WorkspaceChangeGroup } from "../lib/changes";

type FetchChangeContent = (
  changeId: string,
  side: "before" | "after",
) => Promise<{ content: string; binary: boolean } | null>;

export function CodeChangeRow({
  change,
  open,
  onOpenChange,
  fetchContent,
}: {
  change: WorkspaceFileChange;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fetchContent: FetchChangeContent;
}) {
  const ChangeIcon =
    change.kind === "created" ? CheckCircle2Icon : change.kind === "deleted" ? XIcon : FileDiffIcon;
  const [content, setContent] = React.useState<{ before: string; after: string } | null>(null);
  const [contentLoading, setContentLoading] = React.useState(false);
  const [contentError, setContentError] = React.useState(false);

  React.useEffect(() => {
    if (!open || content || contentLoading || contentError) return;
    let cancelled = false;
    setContentLoading(true);
    setContentError(false);
    void Promise.all([
      change.before && change.before.encoding !== "binary"
        ? fetchContent(change.id, "before")
        : Promise.resolve(null),
      change.after && change.after.encoding !== "binary"
        ? fetchContent(change.id, "after")
        : Promise.resolve(null),
    ])
      .then(([before, after]) => {
        if (cancelled) return;
        if (
          (change.before && change.before.encoding !== "binary" && !before) ||
          (change.after && change.after.encoding !== "binary" && !after)
        ) {
          setContentError(true);
          return;
        }
        setContent({ before: before?.content ?? "", after: after?.content ?? "" });
      })
      .catch(() => {
        if (!cancelled) setContentError(true);
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [change, content, contentError, contentLoading, fetchContent, open]);

  const before = content?.before ?? "";
  const after = content?.after ?? "";
  const hasBinarySnapshot =
    change.before?.encoding === "binary" || change.after?.encoding === "binary";
  const timestamp = new Date(change.createdAt);

  return (
    <Collapsible
      className="group/collapsible rounded-md border bg-background"
      onOpenChange={onOpenChange}
      open={open}
    >
      <CollapsibleTrigger className="group sticky top-0 z-10 flex w-full min-w-0 items-center gap-2 border-b bg-background/95 px-2.5 py-2 text-left shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80 hover:bg-muted/80">
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-open/collapsible:rotate-180" />
        <ChangeIcon
          className={cn(
            "size-3.5 shrink-0",
            change.kind === "created"
              ? "text-emerald-600 dark:text-emerald-400"
              : change.kind === "deleted"
                ? "text-red-600 dark:text-red-400"
                : "text-amber-600 dark:text-amber-400",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-medium">{changeLabel(change)}</span>
          <span className="ml-2 font-mono text-muted-foreground">
            {change.toolName.replace(/^mastra_workspace_/, "")}
          </span>
        </span>
        <time className="shrink-0 text-[10px] text-muted-foreground" dateTime={change.createdAt}>
          {Number.isNaN(timestamp.getTime())
            ? ""
            : timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t p-2">
        {hasBinarySnapshot ? (
          <div className="px-1 py-4 text-xs text-muted-foreground">
            二进制快照已完整保存，可通过对象引用读取元数据
          </div>
        ) : contentLoading ? (
          <div className="px-1 py-4 text-xs text-muted-foreground">正在读取完整快照...</div>
        ) : contentError ? (
          <div className="px-1 py-4 text-xs text-destructive">完整快照读取失败</div>
        ) : (
          <CodeComparison
            afterCode={after}
            beforeCode={before}
            filename={change.path}
            language={changeLanguage(change.path)}
          />
        )}
        <div className="mt-2 flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
          <Code2Icon className="size-3" />
          <span>{change.toolName.replace(/^mastra_workspace_/, "")}</span>
          {change.toolCallId ? (
            <span className="truncate font-mono">{change.toolCallId}</span>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function CodeChangeGroup({
  group,
  open,
  onOpenChange,
  expandedChanges,
  onChangeOpen,
  fetchContent,
}: {
  group: WorkspaceChangeGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expandedChanges: Set<string>;
  onChangeOpen: (changeId: string, open: boolean) => void;
  fetchContent: FetchChangeContent;
}) {
  const latest = group.changes[0];
  const LatestIcon =
    latest.kind === "created" ? CheckCircle2Icon : latest.kind === "deleted" ? XIcon : FileDiffIcon;
  const latestTimestamp = new Date(latest.createdAt);

  return (
    <Collapsible
      className="rounded-md border bg-background"
      onOpenChange={onOpenChange}
      open={open}
    >
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/40">
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-open/collapsible:rotate-180" />
        <LatestIcon
          className={cn(
            "size-3.5 shrink-0",
            latest.kind === "created"
              ? "text-emerald-600 dark:text-emerald-400"
              : latest.kind === "deleted"
                ? "text-red-600 dark:text-red-400"
                : "text-amber-600 dark:text-amber-400",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={group.path}>
          {group.path}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {group.changes.length} 次变更
        </span>
        <time className="shrink-0 text-[10px] text-muted-foreground" dateTime={latest.createdAt}>
          {Number.isNaN(latestTimestamp.getTime())
            ? ""
            : latestTimestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t p-2">
        {group.changes.map((change) => (
          <CodeChangeRow
            change={change}
            key={change.id}
            onOpenChange={(nextOpen) => onChangeOpen(change.id, nextOpen)}
            open={expandedChanges.has(change.id)}
            fetchContent={fetchContent}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
