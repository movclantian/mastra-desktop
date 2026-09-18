import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  LayoutGridIcon,
  ListIcon,
  PencilIcon,
  PlusIcon,
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
  saveAgent,
  useAgentsQuery,
  useSessionSettings,
} from "@/entities/workbench";
import { useAuth } from "@/features/auth";
import { isEditableTarget, isMacPlatform } from "@/shared/config/shortcut-menu";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { AnimatedBeam } from "@/shared/ui/animated-beam";
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
import { Dotm3x3_1 } from "@/shared/ui/dotm-3x3-1";
import { Dotm3x3_11 } from "@/shared/ui/dotm-3x3-11";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/shared/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
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
type DraftField =
  | "displayName"
  | "profession"
  | "description"
  | "instructions"
  | "workflowStrategy"
  | "memberText"
  | "workflowStepsJson";
type Draft = {
  type: AgentProfile["type"];
  displayName: string;
  profession: string;
  description: string;
  instructions: string;
  workflowStrategy: "supervisor" | "handoff" | "workflow" | "council";
  memberText: string;
  workflowStepsJson: string;
};

const STRATEGY_KEYS = [
  { value: "supervisor", labelKey: "agentHub:strategies.supervisor" },
  { value: "handoff", labelKey: "agentHub:strategies.handoff" },
  { value: "workflow", labelKey: "agentHub:strategies.workflow" },
  { value: "council", labelKey: "agentHub:strategies.council" },
] as const;

const createEmptyDraft = (type: AgentProfile["type"] = "agent"): Draft => ({
  type,
  displayName: "",
  profession: "",
  description: "",
  instructions: "",
  workflowStrategy: "supervisor",
  memberText: "",
  workflowStepsJson: "[]",
});

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function memberTextFromDraft(value: unknown, defaultMemberName = ""): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter(
      (member): member is Record<string, unknown> => typeof member === "object" && member !== null,
    )
    .map((member) => {
      const name = textValue(member.name) || defaultMemberName;
      const profession = textValue(member.profession);
      const instructions = textValue(member.instructions);
      const skills = Array.isArray(member.skills)
        ? member.skills.filter((value): value is string => typeof value === "string").join(",")
        : "";
      return [name, profession, instructions, skills].join("|");
    })
    .join("\n");
}

function membersFromText(
  value: string,
  defaultName = "",
  defaultDuty = (profession: string) => profession,
): AgentProfile["members"] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [name = defaultName, profession = "", instructions = "", skills = ""] = line.split("|");
      return {
        id: `member-${index + 1}`,
        name: name.trim() || defaultName,
        profession: profession.trim(),
        description: profession.trim(),
        instructions: instructions.trim() || defaultDuty(profession.trim()),
        skills: skills
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        memoryScope: "thread",
      };
    });
}

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
  const [editing, setEditing] = React.useState<AgentProfile | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft>(createEmptyDraft());
  const [saving, setSaving] = React.useState(false);
  const [assistOpen, setAssistOpen] = React.useState(false);
  const [assistType, setAssistType] = React.useState<AgentProfile["type"]>("agent");
  const [assistDescription, setAssistDescription] = React.useState("");
  const [assisting, setAssisting] = React.useState(false);

  const defaultMemberName = t("agentHub:defaultMemberName");
  const defaultMemberDuty = React.useCallback(
    (profession: string) =>
      t("agentHub:defaultMemberDuty", {
        profession: profession || t("agentHub:defaultMemberDutyFallback"),
      }),
    [t],
  );

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

  const updateDraft = (field: DraftField, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const openCreate = (type: AgentProfile["type"]) => {
    setEditing(null);
    setDraft(createEmptyDraft(type));
    setDialogOpen(true);
  };

  const openAssist = (type: AgentProfile["type"]) => {
    setAssistType(type);
    setAssistDescription("");
    setAssistOpen(true);
  };

  const openEdit = (profile: AgentProfile) => {
    setEditing(profile);
    setDraft({
      type: profile.type,
      displayName: profile.displayName,
      profession: profile.profession,
      description: profile.description,
      instructions: profile.instructions,
      workflowStrategy: profile.workflow?.strategy ?? "supervisor",
      workflowStepsJson: JSON.stringify(profile.workflow?.steps ?? [], null, 2),
      memberText: profile.members
        .map(
          (member) =>
            `${member.name}|${member.profession}|${member.instructions}|${member.skills.join(",")}`,
        )
        .join("\n"),
    });
    setDialogOpen(true);
  };

  const generateAssistDraft = async () => {
    if (!assistDescription.trim()) {
      toast.error(t("agentHub:describePromptRequired"));
      return;
    }
    setAssisting(true);
    try {
      const generated = await generateAgentAssist(assistType, assistDescription.trim());
      setEditing(null);
      setDraft({
        type: assistType,
        displayName: textValue(generated.displayName),
        profession: textValue(generated.profession),
        description: textValue(generated.description),
        instructions: textValue(generated.instructions),
        workflowStrategy:
          generated.workflow?.strategy === "handoff" ||
          generated.workflow?.strategy === "workflow" ||
          generated.workflow?.strategy === "council"
            ? generated.workflow.strategy
            : "supervisor",
        memberText: memberTextFromDraft(generated.members, defaultMemberName),
        workflowStepsJson: JSON.stringify(
          Array.isArray(generated.workflow?.steps) ? generated.workflow.steps : [],
          null,
          2,
        ),
      });
      setAssistOpen(false);
      setDialogOpen(true);
      toast.success(t("agentHub:aiDraftSuccess"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("agentHub:aiCreateFailed"));
    } finally {
      setAssisting(false);
    }
  };

  const save = async () => {
    const members = membersFromText(draft.memberText, defaultMemberName, defaultMemberDuty);
    if (!draft.displayName.trim() || !draft.instructions.trim()) {
      toast.error(t("agentHub:nameAndInstructionRequired"));
      return;
    }
    if (draft.type === "team" && members.length === 0) {
      toast.error(t("agentHub:teamNeedsMember"));
      return;
    }
    setSaving(true);
    try {
      let workflowSteps = members.map((member, index) => ({
        id: `step-${index + 1}`,
        memberId: member.id,
      }));
      if (draft.type === "team" && draft.workflowStrategy === "workflow") {
        try {
          const parsed = JSON.parse(draft.workflowStepsJson);
          if (!Array.isArray(parsed)) throw new Error(t("agentHub:nodesMustBeArray"));
          workflowSteps = parsed as typeof workflowSteps;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("agentHub:nodesJsonInvalid"));
          setSaving(false);
          return;
        }
      }
      const savedAgent = await saveAgent({
        ...(editing
          ? {
              id: editing.id,
              tags: editing.tags,
              quickPrompts: editing.quickPrompts,
              skills: editing.skills,
            }
          : {}),
        type: draft.type,
        displayName: draft.displayName,
        profession: draft.profession,
        description: draft.description,
        instructions: draft.instructions,
        name: draft.displayName,
        members,
        workflow:
          draft.type === "team"
            ? {
                strategy: draft.workflowStrategy,
                steps: workflowSteps,
                synthesis: true,
              }
            : undefined,
      });
      await queryClient.invalidateQueries({ queryKey: qk.agents() });
      if (savedAgent) await setAgentSelection(savedAgent);
      setEditing(null);
      setDialogOpen(false);
      toast.success(t("agentHub:configSaved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("agentHub:saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (profile: AgentProfile) => {
    if (profile.id === DEFAULT_AGENT_PROFILE.id) return;
    try {
      await deleteAgent(profile.id);
      await queryClient.invalidateQueries({ queryKey: qk.agents() });
      toast.success(t("agentHub:deleted"));
    } catch {
      toast.error(t("agentHub:deleteFailed"));
    }
  };

  const closeEditor = () => {
    setDialogOpen(false);
    setEditing(null);
    setDraft(createEmptyDraft());
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
        <RainbowButton variant="outline" onClick={() => openAssist("agent")}>
          <SparklesIcon />
          {t("agentHub:aiCreateAgent")}
        </RainbowButton>
        <RainbowButton onClick={() => openAssist("team")}>
          <SparklesIcon />
          {t("agentHub:aiCreateTeam")}
        </RainbowButton>
        <Button
          variant="ghost"
          title={t("agentHub:manualCreate")}
          aria-label={t("agentHub:manualCreate")}
          size="icon"
          onClick={() => openCreate("agent")}
        >
          <PlusIcon />
        </Button>
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
                  <Button onClick={() => openCreate("agent")}>
                    <PlusIcon />
                    {t("agentHub:manualCreate")}
                  </Button>
                  <Button variant="outline" onClick={() => openAssist("agent")}>
                    <SparklesIcon />
                    {t("agentHub:aiCreate")}
                  </Button>
                </EmptyContent>
              </Empty>
            </div>
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3.5 p-5">
              {paginated.map((profile) => (
                <AgentGridCard
                  key={profile.id}
                  profile={profile}
                  active={profile.id === agentSelection.id}
                  onUse={async () => {
                    await setAgentSelection(profile);
                    setActiveView("chat");
                  }}
                  onEdit={() => openEdit(profile)}
                  onDelete={() => void remove(profile)}
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
                  onEdit={() => openEdit(profile)}
                  onDelete={() => void remove(profile)}
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

      <Dialog open={assistOpen} onOpenChange={setAssistOpen}>
        <DialogContent className="max-w-xl sm:max-w-xl">
          <DialogHeader className="pr-6">
            <DialogTitle>
              {t("agentHub:aiCreateModalTitle", {
                type: assistType === "team" ? t("agentHub:team") : t("agentHub:agent"),
              })}
            </DialogTitle>
            <DialogDescription>{t("agentHub:aiCreateModalDesc")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 px-0.5 py-1">
            <fieldset className="grid gap-2 border-0 p-0">
              <legend className="text-sm font-medium">{t("agentHub:createType")}</legend>
              <ToggleGroup
                className="flex w-fit gap-2"
                variant="outline"
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
                className="min-h-36 resize-y"
                value={assistDescription}
                onChange={(event) => setAssistDescription(event.target.value)}
                placeholder={t("agentHub:responsibilityPlaceholder")}
              />
            </Field>
          </div>
          <DialogFooter>
            <DialogClose
              render={
                <Button variant="outline" disabled={assisting}>
                  {t("agentHub:cancel")}
                </Button>
              }
            />
            <Button
              onClick={() => void generateAssistDraft()}
              disabled={assisting || !assistDescription.trim()}
            >
              {assisting ? (
                <Dotm3x3_11 size={14} dotSize={2.2} colorPreset="solid-theme" />
              ) : (
                <SparklesIcon />
              )}
              {assisting ? t("agentHub:generating") : t("agentHub:generateDraft")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => (open ? setDialogOpen(true) : closeEditor())}
      >
        <DialogContent className="flex max-h-[min(90vh,52rem)] max-w-2xl sm:max-w-2xl flex-col">
          <DialogHeader className="pr-6">
            <DialogTitle>
              {t("agentHub:editOrConfirm", {
                action: editing ? t("agentHub:edit") : t("agentHub:confirm"),
                type: draft.type === "team" ? t("agentHub:team") : t("agentHub:agent"),
              })}
            </DialogTitle>
            <DialogDescription>
              {editing ? t("agentHub:editSubtitle") : t("agentHub:confirmSubtitle")}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1 px-1">
            <div className="grid gap-4 px-1 py-2">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="agent-display-name">{t("agentHub:nameLabel")}</FieldLabel>
                  <Input
                    id="agent-display-name"
                    value={draft.displayName}
                    onChange={(event) => updateDraft("displayName", event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="agent-profession">{t("agentHub:positionLabel")}</FieldLabel>
                  <Input
                    id="agent-profession"
                    value={draft.profession}
                    onChange={(event) => updateDraft("profession", event.target.value)}
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="agent-description">{t("agentHub:introLabel")}</FieldLabel>
                <Textarea
                  id="agent-description"
                  className="min-h-20 resize-y"
                  value={draft.description}
                  onChange={(event) => updateDraft("description", event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-instructions">
                  {t("agentHub:instructionsLabel")}
                </FieldLabel>
                <Textarea
                  id="agent-instructions"
                  className="min-h-32 resize-y"
                  value={draft.instructions}
                  onChange={(event) => updateDraft("instructions", event.target.value)}
                />
              </Field>
              {draft.type === "team" ? (
                <>
                  <fieldset className="grid gap-2 border-0 p-0 text-sm font-medium">
                    <legend>{t("agentHub:executionStrategy")}</legend>
                    <ToggleGroup
                      className="flex w-full flex-wrap gap-2"
                      variant="outline"
                      value={[draft.workflowStrategy]}
                      onValueChange={(next) => {
                        const value = next[0];
                        if (
                          value === "supervisor" ||
                          value === "handoff" ||
                          value === "workflow" ||
                          value === "council"
                        ) {
                          updateDraft("workflowStrategy", value);
                        }
                      }}
                    >
                      {STRATEGY_KEYS.map((option) => (
                        <ToggleGroupItem
                          key={option.value}
                          value={option.value}
                          className="h-8 px-3 text-xs"
                        >
                          {t(option.labelKey)}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    <span className="text-xs font-normal text-muted-foreground">
                      {t("agentHub:workflowStrategyHint")}
                    </span>
                    <TeamFlowPreview
                      strategy={draft.workflowStrategy}
                      members={membersFromText(
                        draft.memberText,
                        defaultMemberName,
                        defaultMemberDuty,
                      ).map((member) => member.name)}
                    />
                  </fieldset>
                  <Field>
                    <FieldLabel htmlFor="agent-team-members">
                      {t("agentHub:teamMembers")}
                    </FieldLabel>
                    <Textarea
                      id="agent-team-members"
                      className="min-h-28 resize-y"
                      placeholder={t("agentHub:teamMembersPlaceholder")}
                      value={draft.memberText}
                      onChange={(event) => updateDraft("memberText", event.target.value)}
                    />
                    <FieldDescription className="text-xs text-muted-foreground">
                      {t("agentHub:teamMembersHint")}
                    </FieldDescription>
                  </Field>
                  {draft.workflowStrategy === "workflow" ? (
                    <Field>
                      <FieldLabel htmlFor="agent-workflow-steps">
                        {t("agentHub:workflowSteps")}
                      </FieldLabel>
                      <Textarea
                        id="agent-workflow-steps"
                        className="min-h-40 resize-y font-mono text-xs"
                        value={draft.workflowStepsJson}
                        onChange={(event) => updateDraft("workflowStepsJson", event.target.value)}
                        placeholder={
                          '[{"id":"review","kind":"approval","approval":{"title":"Review","description":"Please approve to continue"}}]'
                        }
                      />
                      <FieldDescription className="text-xs text-muted-foreground">
                        {t("agentHub:workflowStepsHint")}
                      </FieldDescription>
                    </Field>
                  ) : null}
                </>
              ) : null}
            </div>
          </ScrollArea>
          <DialogFooter>
            <DialogClose
              render={
                <Button variant="outline" disabled={saving}>
                  {t("agentHub:cancel")}
                </Button>
              }
            />
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" /> : null}
              {saving ? t("agentHub:saving") : t("agentHub:saveAndUse")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const FLOW_NODE_CLASS =
  "z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-background text-[10px] font-medium shadow-xs";

/**
 * 团队编排拓扑预览:把执行策略画成真实的连线动画,光束方向即数据流方向 ——
 * supervisor 从中枢放射委派、handoff 顺序交接、council 并行评议后汇聚、
 * workflow 按显式节点串联。改策略或改成员即时重画。
 */
function TeamFlowPreview({
  strategy,
  members,
}: {
  strategy: Draft["workflowStrategy"];
  members: string[];
}) {
  const { t } = useTranslation();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const hubRef = React.useRef<HTMLDivElement>(null);
  const visible = members
    .slice(0, 5)
    .map((name, index) => ({ key: `${index}:${name}`, name, order: index + 1 }));
  // 每个节点需要独立的 RefObject(AnimatedBeam 的入参形态)。只随节点数量重建,
  // 否则每次输入都换掉 ref 身份,光束会不断重算路径而闪烁。
  const nodeRefs = React.useRef<Array<{ current: HTMLDivElement | null }>>([]);
  if (nodeRefs.current.length !== visible.length) {
    nodeRefs.current = visible.map((_, index) => nodeRefs.current[index] ?? { current: null });
  }

  if (visible.length === 0) return null;

  const chained = strategy === "handoff" || strategy === "workflow";
  const hubLabel =
    strategy === "supervisor"
      ? t("agentHub:strategySupervisor")
      : strategy === "council"
        ? t("agentHub:strategyCouncil")
        : null;
  const hubFirst = strategy === "supervisor";

  const beams = chained
    ? visible.slice(0, -1).map((item, index) => ({
        key: `chain:${item.key}`,
        fromRef: nodeRefs.current[index],
        toRef: nodeRefs.current[index + 1],
        delay: index * 0.4,
      }))
    : visible.map((item, index) => ({
        key: `hub:${item.key}`,
        fromRef: hubFirst ? hubRef : nodeRefs.current[index],
        toRef: hubFirst ? nodeRefs.current[index] : hubRef,
        delay: index * 0.35,
      }));

  const hub = hubLabel ? (
    <div ref={hubRef} className={cn(FLOW_NODE_CLASS, "border-primary/50 bg-primary/10")}>
      {hubLabel}
    </div>
  ) : null;

  const memberColumn = (
    <div className={cn("flex min-w-0 gap-2", chained ? "flex-1 items-center" : "flex-col")}>
      {visible.map((item) => (
        <div
          key={item.key}
          className={cn("flex min-w-0 items-center gap-1.5", chained && "flex-1 justify-center")}
        >
          <div ref={nodeRefs.current[item.order - 1]} className={FLOW_NODE_CLASS} title={item.name}>
            {item.order}
          </div>
          {!chained ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{item.name}</span>
          ) : null}
        </div>
      ))}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className="relative mt-1 flex w-full items-center gap-4 overflow-hidden rounded-lg border bg-muted/20 p-3"
    >
      {chained ? (
        memberColumn
      ) : hubFirst ? (
        <>
          {hub}
          {memberColumn}
        </>
      ) : (
        <>
          {memberColumn}
          {hub}
        </>
      )}

      {beams.map((beam) => (
        <AnimatedBeam
          key={beam.key}
          containerRef={containerRef}
          fromRef={beam.fromRef}
          toRef={beam.toRef}
          duration={3}
          delay={beam.delay}
          pathColor="var(--border)"
          pathWidth={1.5}
          gradientStartColor="var(--primary)"
          gradientStopColor="var(--accent)"
        />
      ))}

      {members.length > visible.length ? (
        <span className="z-10 shrink-0 text-xs text-muted-foreground">
          +{members.length - visible.length}
        </span>
      ) : null}
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
  onEdit,
  onDelete,
  children,
}: {
  profile: AgentProfile;
  onUse: () => void;
  onEdit: () => void;
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
    if (event.isComposing || isEditableTarget(event.target)) return;

    if (!isDefault) {
      if (event.key === "F2") {
        event.preventDefault();
        onEdit();
      } else if (event.key === "Delete" || (isMac && event.key === "Backspace")) {
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
              <ContextMenuItem onClick={onEdit}>
                <PencilIcon className="text-muted-foreground" />
                <span>{t("agentHub:editConfig")}</span>
                <ContextMenuShortcut>F2</ContextMenuShortcut>
              </ContextMenuItem>
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
  onEdit,
  onDelete,
}: {
  profile: AgentProfile;
  active: boolean;
  onUse: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const Icon = profile.type === "team" ? UsersRoundIcon : BotIcon;
  const isDefault = profile.id === DEFAULT_AGENT_PROFILE.id;
  const isTeam = profile.type === "team";

  return (
    <AgentContextMenuWrapper profile={profile} onUse={onUse} onEdit={onEdit} onDelete={onDelete}>
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
                <Icon className="size-5" />
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
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                title={t("agentHub:edit")}
                aria-label={t("agentHub:edit")}
                onClick={onEdit}
              >
                <PencilIcon className="size-3.5" />
              </Button>
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
            </>
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
  onEdit,
  onDelete,
}: {
  profile: AgentProfile;
  active: boolean;
  onUse: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const Icon = profile.type === "team" ? UsersRoundIcon : BotIcon;
  const isDefault = profile.id === DEFAULT_AGENT_PROFILE.id;
  const isTeam = profile.type === "team";

  return (
    <AgentContextMenuWrapper profile={profile} onUse={onUse} onEdit={onEdit} onDelete={onDelete}>
      <div
        className={cn(
          "group flex items-center justify-between gap-4 rounded-xl border bg-card p-3 px-4 transition-all duration-150 hover:border-primary/40 hover:bg-muted/30",
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
            <Icon className="size-4" />
          </div>

          <div className="w-48 min-w-0 shrink-0">
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
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                title={t("agentHub:edit")}
                aria-label={t("agentHub:edit")}
                onClick={onEdit}
              >
                <PencilIcon className="size-3.5" />
              </Button>
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
            </>
          ) : null}
        </div>
      </div>
    </AgentContextMenuWrapper>
  );
}

export { AgentHubPage as AgentHub };
