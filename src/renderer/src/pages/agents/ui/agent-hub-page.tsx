import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  LayoutGridIcon,
  ListIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  UsersRoundIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  type AgentProfile,
  DEFAULT_AGENT_PROFILE,
  deleteAgent,
  generateAgentAssist,
  qk,
  useAgentsQuery,
  useSessionSettings,
} from "@/entities/workbench";
import { AgentProfileDetails, ProfileAvatar } from "@/entities/workbench/ui/agent-profile-details";
import { useAuth } from "@/features/auth";
import { isEditableTarget, isMacPlatform } from "@/shared/config/shortcut-menu";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { AnimatedTabs } from "@/shared/ui/animated-tabs";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Dotm3x3_11 } from "@/shared/ui/dotm-3x3-11";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/shared/ui/empty";
import { Field, FieldLabel } from "@/shared/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/shared/ui/input-group";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/shared/ui/pagination";
import { RainbowButton } from "@/shared/ui/rainbow-button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Textarea } from "@/shared/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/shared/ui/toggle-group";

type HubTab = "all" | "agent" | "team" | "mine";
export function AgentHubPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const agentsQuery = useAgentsQuery();
  const agents = agentsQuery.data ?? [];
  const { user } = useAuth();
  const activeThreadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const { agentSelection, setAgentSelection } = useSessionSettings(
    user?.id ?? "anonymous",
    activeThreadId,
  );
  const setActiveView = (view: string) => void navigate({ to: `/${view}` });
  const [tab, setTab] = React.useState<HubTab>("all");
  const [query, setQuery] = React.useState("");
  const [viewMode, setViewMode] = React.useState<"grid" | "list">("grid");
  const [page, setPage] = React.useState(1);
  const [assistOpen, setAssistOpen] = React.useState(false);
  const [assistType, setAssistType] = React.useState<AgentProfile["type"]>("agent");
  const [assistDescription, setAssistDescription] = React.useState("");
  const [assisting, setAssisting] = React.useState(false);
  const [inspected, setInspected] = React.useState<AgentProfile | null>(null);

  React.useEffect(() => {
    setPage(1);
  }, [tab, query, viewMode]);

  const filtered = agents.filter((profile) => {
    if (tab === "agent" && profile.type !== "agent") return false;
    if (tab === "team" && profile.type !== "team") return false;
    if (tab === "mine" && profile.id === DEFAULT_AGENT_PROFILE.id) return false;
    const haystack =
      `${profile.displayName} ${profile.profession} ${profile.description} ${profile.tags.join(" ")}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

  const pageSize = viewMode === "grid" ? 12 : 10;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginated = React.useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, safePage, pageSize]);

  const openAssist = (type: AgentProfile["type"]) => {
    setAssistType(type);
    setAssistDescription("");
    setAssistOpen(true);
  };

  const createWithAI = async () => {
    if (assisting) return;
    if (!assistDescription.trim()) {
      toast.error(t("agentHub:describePromptRequired"));
      return;
    }
    setAssisting(true);
    try {
      const agent = await generateAgentAssist(assistType, assistDescription.trim());
      await queryClient.invalidateQueries({ queryKey: qk.agents() });
      setAssistOpen(false);
      const participants = [agent, ...agent.members];
      toast.success(
        t("agentHub:aiCreateSuccess", {
          skills: new Set(participants.flatMap((item) => item.skills)).size,
          mcp: new Set(participants.flatMap((item) => item.mcpServers)).size,
        }),
      );
      setInspected(agent);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("agentHub:aiCreateFailed"));
    } finally {
      setAssisting(false);
    }
  };

  const remove = async (profile: AgentProfile) => {
    if (profile.id === DEFAULT_AGENT_PROFILE.id) return;
    try {
      await deleteAgent(profile.id);
      if (inspected?.id === profile.id) setInspected(null);
      await queryClient.invalidateQueries({ queryKey: qk.agents() });
      toast.success(t("agentHub:deleted"));
    } catch {
      toast.error(t("agentHub:deleteFailed"));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
        <InputGroup className="min-w-52 flex-1">
          <InputGroupAddon align="inline-start">
            <SearchIcon className="size-4 text-muted-foreground" />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("agentHub:searchPlaceholder")}
          />
        </InputGroup>
        <RainbowButton onClick={() => openAssist(tab === "team" ? "team" : "agent")}>
          <SparklesIcon />
          {t("agentHub:aiCreate")}
        </RainbowButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mx-5 mt-3 flex items-center justify-between gap-4">
          <AnimatedTabs
            activeTab={tab}
            onChange={(value) => {
              setTab(value as HubTab);
              setPage(1);
            }}
            layoutId="agent-hub-filter"
            variant="segmented"
            aria-label={t("agentHub:categoryAria")}
            className="w-fit"
            tabs={[
              { id: "all", label: t("agentHub:categories.all") },
              { id: "agent", label: t("agentHub:agent") },
              { id: "team", label: t("agentHub:categories.team") },
              { id: "mine", label: t("agentHub:categories.mine") },
            ]}
          />
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {t("agentHub:expertCount", { count: filtered.length })}
            </span>
            <ToggleGroup
              className="h-8"
              variant="outline"
              value={[viewMode]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "grid" || value === "list") setViewMode(value);
              }}
            >
              <ToggleGroupItem
                value="grid"
                aria-label={t("agentHub:gridView")}
                className="size-8 p-0"
              >
                <LayoutGridIcon className="size-3.5" />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="list"
                aria-label={t("agentHub:listView")}
                className="size-8 p-0"
              >
                <ListIcon className="size-3.5" />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {filtered.length === 0 ? (
            <div className="p-5">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SearchIcon />
                  </EmptyMedia>
                  <EmptyTitle>
                    {query.trim() ? t("agentHub:noMatchTitle") : t("agentHub:emptyCategoryTitle")}
                  </EmptyTitle>
                  <EmptyDescription>
                    {query.trim() ? t("agentHub:noMatchDesc") : t("agentHub:emptyCategoryDesc")}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent className="flex-row justify-center gap-2">
                  {query.trim() ? (
                    <Button variant="outline" onClick={() => setQuery("")}>
                      <SearchIcon />
                      {t("agentHub:clearSearch")}
                    </Button>
                  ) : null}
                  <Button variant="outline" onClick={() => openAssist("agent")}>
                    <SparklesIcon />
                    {t("agentHub:aiCreate")}
                  </Button>
                </EmptyContent>
              </Empty>
            </div>
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3.5 p-5">
              {paginated.map((profile) => (
                <AgentGridCard
                  key={profile.id}
                  profile={profile}
                  active={profile.id === agentSelection.id}
                  onUse={async () => {
                    await setAgentSelection(profile);
                    setActiveView("chat");
                  }}
                  onDelete={() => void remove(profile)}
                  onInspect={() => setInspected(profile)}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2 p-5">
              {paginated.map((profile) => (
                <AgentListItem
                  key={profile.id}
                  profile={profile}
                  active={profile.id === agentSelection.id}
                  onUse={async () => {
                    await setAgentSelection(profile);
                    setActiveView("chat");
                  }}
                  onDelete={() => void remove(profile)}
                  onInspect={() => setInspected(profile)}
                />
              ))}
            </div>
          )}
        </ScrollArea>

        {totalPages > 1 ? (
          <div className="flex items-center justify-between border-t px-5 py-2.5 bg-background/80 backdrop-blur-xs">
            <span className="text-xs text-muted-foreground">
              {t("agentHub:pageInfo", {
                current: safePage,
                total: totalPages,
                count: filtered.length,
              })}
            </span>
            <Pagination className="mx-0 w-auto">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    text={t("agentHub:prevPage")}
                    className={cn(
                      "h-8 cursor-pointer text-xs",
                      safePage <= 1 && "pointer-events-none opacity-40",
                    )}
                    onClick={(e) => {
                      e.preventDefault();
                      if (safePage > 1) setPage((p) => p - 1);
                    }}
                  />
                </PaginationItem>
                {getPageNumbers(safePage, totalPages).map((item, idx) =>
                  item === "ellipsis" ? (
                    <PaginationItem key={`ellipsis-${idx}`}>
                      <PaginationEllipsis className="size-8" />
                    </PaginationItem>
                  ) : (
                    <PaginationItem key={item}>
                      <PaginationLink
                        isActive={safePage === item}
                        className="size-8 cursor-pointer text-xs"
                        onClick={(e) => {
                          e.preventDefault();
                          setPage(item);
                        }}
                      >
                        {item}
                      </PaginationLink>
                    </PaginationItem>
                  ),
                )}
                <PaginationItem>
                  <PaginationNext
                    text={t("agentHub:nextPage")}
                    className={cn(
                      "h-8 cursor-pointer text-xs",
                      safePage >= totalPages && "pointer-events-none opacity-40",
                    )}
                    onClick={(e) => {
                      e.preventDefault();
                      if (safePage < totalPages) setPage((p) => p + 1);
                    }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        ) : null}
      </div>

      <Dialog
        open={Boolean(inspected)}
        onOpenChange={(open) => {
          if (!open) setInspected(null);
        }}
      >
        <DialogContent
          className={cn(
            "flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden",
            inspected?.type === "team"
              ? "h-[min(48rem,calc(100dvh-2rem))] sm:max-w-5xl"
              : "sm:max-w-2xl",
          )}
        >
          <DialogHeader className="shrink-0 pr-6">
            <DialogTitle>{t("agentHub:profileDetails")}</DialogTitle>
            <DialogDescription>{t("agentHub:profileDetailsDescription")}</DialogDescription>
          </DialogHeader>
          {inspected ? (
            <AgentProfileDetails key={inspected.id} profile={inspected} onSaved={setInspected} />
          ) : null}
          <DialogFooter className="shrink-0">
            <Button
              onClick={async () => {
                if (!inspected) return;
                await setAgentSelection(inspected);
                setInspected(null);
                setActiveView("chat");
              }}
            >
              {t(inspected?.type === "team" ? "agentHub:useTeamNow" : "agentHub:useExpertNow")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={assistOpen}
        onOpenChange={(open) => {
          if (!assisting) setAssistOpen(open);
        }}
      >
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-xl flex-col overflow-hidden sm:max-w-xl">
          <DialogHeader className="shrink-0 break-words pr-6">
            <DialogTitle>
              {t("agentHub:aiCreateModalTitle", {
                type: assistType === "team" ? t("agentHub:team") : t("agentHub:agent"),
              })}
            </DialogTitle>
            <DialogDescription>{t("agentHub:aiCreateModalDesc")}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 min-w-0 flex-1">
            <div className="grid min-w-0 gap-4 px-1 py-1">
              <fieldset className="grid gap-2 border-0 p-0">
                <legend className="text-sm font-medium">{t("agentHub:createType")}</legend>
                <ToggleGroup
                  className="flex w-fit gap-2"
                  variant="outline"
                  disabled={assisting}
                  value={[assistType]}
                  onValueChange={(next) => {
                    const value = next[0];
                    if (value === "agent" || value === "team") setAssistType(value);
                  }}
                >
                  <ToggleGroupItem value="agent">
                    <BotIcon />
                    {t("agentHub:agent")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="team">
                    <UsersRoundIcon />
                    {t("agentHub:team")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </fieldset>
              <Field>
                <FieldLabel htmlFor="agent-assist-description">
                  {t("agentHub:whatToResponsible")}
                </FieldLabel>
                <Textarea
                  id="agent-assist-description"
                  autoFocus
                  className="min-h-36 max-h-64 w-full resize-y whitespace-pre-wrap break-words"
                  disabled={assisting}
                  maxLength={100_000}
                  value={assistDescription}
                  onChange={(event) => setAssistDescription(event.target.value)}
                  placeholder={t("agentHub:responsibilityPlaceholder")}
                />
              </Field>
              <p className="break-words text-sm text-muted-foreground">
                {t("agentHub:aiCapabilitiesHint")}
              </p>
            </div>
          </ScrollArea>
          <DialogFooter className="shrink-0">
            <DialogClose
              render={
                <Button variant="outline" disabled={assisting}>
                  {t("agentHub:cancel")}
                </Button>
              }
            />
            <Button
              onClick={() => void createWithAI()}
              disabled={assisting || !assistDescription.trim()}
            >
              {assisting ? (
                <Dotm3x3_11 size={14} dotSize={2.2} colorPreset="solid-theme" />
              ) : (
                <SparklesIcon />
              )}
              {assisting ? t("agentHub:generating") : t("agentHub:generateAndCreate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function getPageNumbers(currentPage: number, totalPages: number): (number | "ellipsis")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, "ellipsis", totalPages];
  }
  if (currentPage >= totalPages - 3) {
    return [
      1,
      "ellipsis",
      totalPages - 4,
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    ];
  }
  return [1, "ellipsis", currentPage - 1, currentPage, currentPage + 1, "ellipsis", totalPages];
}

function AgentContextMenuWrapper({
  profile,
  onUse,
  onDelete,
  children,
}: {
  profile: AgentProfile;
  onUse: () => void;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const Icon = profile.type === "team" ? UsersRoundIcon : BotIcon;
  const isDefault = profile.id === DEFAULT_AGENT_PROFILE.id;
  const isMac = React.useMemo(() => isMacPlatform(), []);

  const handleCopyInfo = () => {
    void navigator.clipboard.writeText(profile.displayName);
    toast.success(t("agentHub:copiedName"));
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || isEditableTarget(event.target)) return;

    if (!isDefault) {
      if (event.key === "Delete" || (isMac && event.key === "Backspace")) {
        event.preventDefault();
        onDelete();
      }
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger className="block h-full" onKeyDown={handleKeyDown}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuGroup>
          <ContextMenuLabel className="max-w-44 truncate">{profile.displayName}</ContextMenuLabel>
          <ContextMenuItem onClick={onUse}>
            <Icon className="text-muted-foreground" />
            <span>{t("agentHub:useExpertNow")}</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopyInfo}>
            <CopyIcon className="text-muted-foreground" />
            <span>{t("agentHub:copyExpertName")}</span>
          </ContextMenuItem>
        </ContextMenuGroup>
        {!isDefault ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem variant="destructive" onClick={onDelete}>
                <Trash2Icon className="text-muted-foreground" />
                <span>{t("agentHub:deleteExpert")}</span>
                <ContextMenuShortcut>{isMac ? "⌫" : "Del"}</ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuGroup>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function AgentGridCard({
  profile,
  active,
  onUse,
  onDelete,
  onInspect,
}: {
  profile: AgentProfile;
  active: boolean;
  onUse: () => void;
  onDelete: () => void;
  onInspect: () => void;
}) {
  const { t } = useTranslation();

  const isDefault = profile.id === DEFAULT_AGENT_PROFILE.id;
  const isTeam = profile.type === "team";

  return (
    <AgentContextMenuWrapper profile={profile} onUse={onUse} onDelete={onDelete}>
      <Card
        className={cn(
          "group relative flex h-full min-h-56 flex-col justify-between rounded-xl border bg-card transition-all duration-200 hover:border-primary/40 hover:shadow-xs",
          active && "border-primary/60 ring-2 ring-primary/15 bg-primary/[0.015]",
        )}
      >
        <CardHeader className="p-4 pb-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div
                className={cn(
                  "flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/60 text-foreground transition-colors",
                  active && "border-primary/30 bg-primary/10 text-primary",
                )}
              >
                <ProfileAvatar name={profile.displayName} avatar={profile.avatar} />
              </div>
              <div className="min-w-0">
                <CardTitle className="truncate text-sm font-semibold tracking-tight">
                  {profile.displayName}
                </CardTitle>
                <CardDescription className="truncate text-xs">
                  {profile.profession || (isTeam ? t("agentHub:team") : t("agentHub:generalAgent"))}
                </CardDescription>
              </div>
            </div>
            {active ? (
              <Badge variant="default" className="shrink-0 px-1.5 py-0 text-[10px] font-normal">
                {t("agentHub:inUse")}
              </Badge>
            ) : isTeam ? (
              <Badge
                variant="outline"
                className="shrink-0 px-1.5 py-0 text-[10px] text-muted-foreground"
              >
                {t("agentHub:teamMemberCount", { count: profile.members.length })}
              </Badge>
            ) : null}
          </div>
        </CardHeader>

        <CardContent className="min-h-0 flex-1 p-2 pt-1">
          <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">
            {profile.description || profile.instructions}
          </p>
          {profile.tags.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1">
              {profile.tags.slice(0, 3).map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
                >
                  {tag}
                </Badge>
              ))}
              {profile.tags.length > 3 ? (
                <span className="self-center text-[10px] text-muted-foreground">
                  +{profile.tags.length - 3}
                </span>
              ) : null}
            </div>
          ) : null}
        </CardContent>

        <CardFooter className="gap-1.5 border-t bg-muted/20 p-3">
          <Button size="sm" variant="ghost" onClick={onInspect}>
            {t("agentHub:profileDetails")}
          </Button>
          <Button
            size="sm"
            variant={active ? "outline" : "default"}
            className={cn(
              "h-8 min-w-0 flex-1 text-xs font-medium",
              active && "border-primary/40 bg-primary/5 text-primary hover:bg-primary/10",
            )}
            onClick={onUse}
          >
            {active ? (
              <>
                <CheckIcon className="mr-1 size-3.5" />
                {t("agentHub:inUse")}
              </>
            ) : (
              t("agentHub:select")
            )}
          </Button>
          {!isDefault ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              title={t("agentHub:deleteExpert")}
              aria-label={t("agentHub:deleteExpert")}
              onClick={onDelete}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          ) : null}
        </CardFooter>
      </Card>
    </AgentContextMenuWrapper>
  );
}

function AgentListItem({
  profile,
  active,
  onUse,
  onDelete,
  onInspect,
}: {
  profile: AgentProfile;
  active: boolean;
  onUse: () => void;
  onDelete: () => void;
  onInspect: () => void;
}) {
  const { t } = useTranslation();

  const isDefault = profile.id === DEFAULT_AGENT_PROFILE.id;
  const isTeam = profile.type === "team";

  return (
    <AgentContextMenuWrapper profile={profile} onUse={onUse} onDelete={onDelete}>
      <div
        className={cn(
          "group flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-3 px-4 transition-all duration-150 hover:border-primary/40 hover:bg-muted/30",
          active && "border-primary/60 ring-2 ring-primary/15 bg-primary/[0.015]",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/60 text-foreground transition-colors",
              active && "border-primary/30 bg-primary/10 text-primary",
            )}
          >
            <ProfileAvatar name={profile.displayName} avatar={profile.avatar} />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{profile.displayName}</span>
              {active ? (
                <Badge variant="default" className="h-4 shrink-0 px-1 py-0 text-[10px] font-normal">
                  {t("agentHub:current")}
                </Badge>
              ) : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {profile.profession || (isTeam ? t("agentHub:team") : t("agentHub:generalAgent"))}
            </p>
          </div>

          <div className="hidden min-w-0 flex-1 md:block">
            <p className="truncate text-xs text-muted-foreground">
              {profile.description || profile.instructions}
            </p>
          </div>

          <div className="hidden shrink-0 items-center gap-1 lg:flex">
            {profile.tags.slice(0, 2).map((tag) => (
              <Badge
                key={tag}
                variant="secondary"
                className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
              >
                {tag}
              </Badge>
            ))}
            {isTeam ? (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                {t("agentHub:teamMemberCount", { count: profile.members.length })}
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={onInspect}>
            {t("agentHub:profileDetails")}
          </Button>
          <Button
            size="sm"
            variant={active ? "outline" : "default"}
            className={cn(
              "h-8 px-3 text-xs font-medium",
              active && "border-primary/40 bg-primary/5 text-primary hover:bg-primary/10",
            )}
            onClick={onUse}
          >
            {active ? (
              <>
                <CheckIcon className="mr-1 size-3" />
                {t("agentHub:inUse")}
              </>
            ) : (
              t("agentHub:select")
            )}
          </Button>
          {!isDefault ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              title={t("agentHub:deleteExpert")}
              aria-label={t("agentHub:deleteExpert")}
              onClick={onDelete}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    </AgentContextMenuWrapper>
  );
}

export { AgentHubPage as AgentHub };
