import { skipToken, useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BotIcon,
  CheckIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  GlobeIcon,
  HammerIcon,
  LibraryIcon,
  MapIcon,
  PlugIcon,
  PlusIcon,
  ShieldIcon,
  SparklesIcon,
  TargetIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { fetchMcpServers } from "@/entities/skill/api/skill-api";
import {
  APPROVAL_PRESETS,
  DEFAULT_MODE_ID,
  matchApprovalPreset,
  WORK_MODE_IDS,
} from "@/entities/workbench";
import { fetchTree, workspaceRawFileUrl } from "@/entities/workbench/api/workbench-api";
import { useSessionSettings } from "@/entities/workbench/model/use-session-settings";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import {
  PromptInputActionAddAttachments,
  PromptInputActionAddScreenshot,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputButton,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/shared/ui/ai-elements/prompt-input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { fetchChatAssetBlob, fetchChatLibraryAssets, fetchChatSkills } from "../api/chat-api";
import type { MessageFileReference } from "../model/types";
import { SearchMenuItems } from "./search-menu";

const MODE_ICONS = { build: HammerIcon, plan: MapIcon, review: EyeIcon };

export function ComposerMenu({
  screenshotEnabled,
  skills,
  onSkillsChange,
  onFileReference,
  goal,
  onGoalChange,
  goalAvailable,
  busy,
}: {
  screenshotEnabled: boolean;
  skills: string[];
  onSkillsChange: (skills: string[]) => void;
  onFileReference: (file: MessageFileReference) => void;
  goal: boolean;
  onGoalChange: (goal: boolean) => void;
  goalAvailable: boolean;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const navigate = useNavigate();
  const threadId = useRouterState({
    select: (state) => (state.location.search as { thread?: string }).thread ?? null,
  });
  const {
    agents,
    agentSelection,
    setAgentSelection,
    modeId,
    setModeId,
    searchSelection,
    setSearchSelection,
    permissionRules,
    setPermissionRules,
  } = useSessionSettings(userId, threadId);
  const ActiveModeIcon = MODE_ICONS[modeId];
  const changeMode = (id: typeof modeId) =>
    void setModeId(id).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : t("common:error")),
    );
  const attachments = usePromptInputAttachments();
  const queueFiles = useWorkbenchStore((state) => state.queueLibraryFiles);
  const [open, setOpen] = React.useState(false);
  const [directory, setDirectory] = React.useState("");
  const currentThreadId = React.useRef(threadId);
  currentThreadId.current = threadId;
  const [addingFile, setAddingFile] = React.useState(false);
  const library = useQuery({
    queryKey: ["composer-library", userId],
    queryFn: () => fetchChatLibraryAssets(userId),
    enabled: open,
  });
  const availableSkills = useQuery({
    queryKey: ["composer-skills", userId],
    queryFn: () => fetchChatSkills<{ name: string; description: string }>(),
    enabled: open,
  });
  const mcp = useQuery({
    queryKey: ["composer-mcp", userId],
    queryFn: fetchMcpServers,
    enabled: open,
  });
  const tree = useQuery({
    queryKey: ["composer-files", userId, threadId, directory],
    queryFn: threadId ? () => fetchTree(threadId, userId, directory) : skipToken,
    enabled: open && Boolean(threadId),
  });
  React.useEffect(() => {
    setDirectory("");
  }, [threadId]);
  const empty = (loading: boolean, failed: boolean) => (
    <p className="px-2 py-3 text-xs text-muted-foreground">
      {t(loading ? "common:loading" : failed ? "common:error" : "common:empty")}
    </p>
  );

  return (
    <PromptInputTools className="flex-wrap">
      <PromptInputActionMenu open={open} onOpenChange={setOpen}>
        <PromptInputActionMenuTrigger
          aria-label={t("chat:composer.add")}
          title={t("chat:composer.add")}
          size="icon-sm"
          variant={goal ? "secondary" : "outline"}
        >
          <PlusIcon />
        </PromptInputActionMenuTrigger>
        <PromptInputActionMenuContent side="top" className="w-60 overflow-hidden">
          <ScrollArea className="max-h-[min(28rem,calc(var(--available-height)-0.5rem))]">
            <PromptInputActionAddAttachments label={t("chat:composer.localFiles")} />
            {screenshotEnabled && (
              <PromptInputActionAddScreenshot label={t("chat:prompt.takeScreenshot")} />
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <LibraryIcon />
                {t("sidebar:library")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-72 overflow-hidden">
                <ScrollArea className="max-h-[min(20rem,calc(var(--available-height)-3rem))]">
                  {library.data?.length
                    ? library.data.map((file) => (
                        <DropdownMenuItem
                          key={file.id}
                          disabled={attachments.files.some((item) => item.url === file.url)}
                          onClick={() => {
                            queueFiles([{ type: "file", ...file }]);
                            onFileReference(file);
                          }}
                        >
                          <FileIcon />
                          <span className="min-w-0 break-all">{file.filename}</span>
                        </DropdownMenuItem>
                      ))
                    : empty(library.isPending, library.isError)}
                </ScrollArea>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void navigate({ to: "/library" })}>
                  {t("chat:composer.manageLibrary")}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={!threadId}>
                <FolderIcon />
                {t("chat:composer.workspaceFiles")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-72 overflow-hidden">
                {directory && (
                  <DropdownMenuItem
                    closeOnClick={false}
                    onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/"))}
                  >
                    {t("common:back")}
                  </DropdownMenuItem>
                )}
                <ScrollArea className="max-h-[min(20rem,calc(var(--available-height)-3rem))]">
                  {tree.data?.length
                    ? tree.data.map((file) => (
                        <DropdownMenuItem
                          key={file.path}
                          closeOnClick={file.type !== "dir"}
                          disabled={addingFile}
                          onClick={() => {
                            if (file.type === "dir") {
                              setDirectory(file.path);
                              return;
                            }
                            if (!threadId) return;
                            setAddingFile(true);
                            void fetchChatAssetBlob(
                              workspaceRawFileUrl(threadId, userId, file.path),
                            )
                              .then((blob) => {
                                if (currentThreadId.current !== threadId) return;
                                attachments.add([new File([blob], file.name, { type: blob.type })]);
                              })
                              .catch((error: unknown) =>
                                toast.error(
                                  error instanceof Error ? error.message : t("common:error"),
                                ),
                              )
                              .finally(() => setAddingFile(false));
                          }}
                        >
                          {file.type === "dir" ? <FolderIcon /> : <FileIcon />}
                          <span className="min-w-0 break-all">{file.name}</span>
                        </DropdownMenuItem>
                      ))
                    : empty(tree.isPending, tree.isError)}
                </ScrollArea>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <SparklesIcon />
                {t("sidebar:skills")}
                <span className="ml-auto text-xs text-muted-foreground">{skills.length}/4</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-72 overflow-hidden">
                <ScrollArea className="max-h-[min(20rem,calc(var(--available-height)-3rem))]">
                  {availableSkills.data?.length
                    ? availableSkills.data.map((skill) => (
                        <DropdownMenuCheckboxItem
                          key={skill.name}
                          checked={skills.includes(skill.name)}
                          disabled={!skills.includes(skill.name) && skills.length >= 4}
                          closeOnClick={false}
                          onCheckedChange={(checked) =>
                            onSkillsChange(
                              checked
                                ? [...skills, skill.name]
                                : skills.filter((name) => name !== skill.name),
                            )
                          }
                        >
                          <span className="min-w-0">
                            <span className="block break-all">{skill.name}</span>
                            <span className="block whitespace-normal break-words text-xs text-muted-foreground">
                              {skill.description}
                            </span>
                          </span>
                        </DropdownMenuCheckboxItem>
                      ))
                    : empty(availableSkills.isPending, availableSkills.isError)}
                </ScrollArea>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void navigate({ to: "/skills" })}>
                  {t("chat:composer.manageSkills")}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <BotIcon />
                <span className="min-w-0 truncate">{agentSelection.displayName}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-72 overflow-hidden">
                <ScrollArea className="max-h-[min(20rem,calc(var(--available-height)-3rem))]">
                  {agents.map((agent) => (
                    <DropdownMenuCheckboxItem
                      key={agent.id}
                      checked={agent.id === agentSelection.id}
                      disabled={busy}
                      onCheckedChange={() => {
                        void setAgentSelection(agent).catch((error: unknown) =>
                          toast.error(error instanceof Error ? error.message : t("common:error")),
                        );
                      }}
                    >
                      <span className="min-w-0 break-words">{agent.displayName}</span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </ScrollArea>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void navigate({ to: "/agents" })}>
                  {t("chat:composer.manageAgents")}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <PlugIcon />
                {t("chat:composer.connections")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64 overflow-hidden">
                <ScrollArea className="max-h-[min(16rem,calc(var(--available-height)-3rem))]">
                  {mcp.data?.some((server) => server.enabled)
                    ? mcp.data
                        .filter((server) => server.enabled)
                        .map((server) => (
                          <DropdownMenuItem
                            key={server.id}
                            onClick={() =>
                              void navigate({ to: "/skills", search: { section: "mcp" } })
                            }
                          >
                            <PlugIcon />
                            <span className="min-w-0 break-words">{server.name}</span>
                          </DropdownMenuItem>
                        ))
                    : empty(mcp.isPending, mcp.isError)}
                </ScrollArea>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => void navigate({ to: "/skills", search: { section: "mcp" } })}
                >
                  {t("chat:composer.manageConnections")}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <GlobeIcon />
                <span className="min-w-0 flex-1">{t("chat:search.title")}</span>
                {searchSelection && <CheckIcon className="size-3.5" />}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60 overflow-hidden">
                <SearchMenuItems selection={searchSelection} onSelect={setSearchSelection} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ActiveModeIcon />
                <span className="min-w-0 flex-1">{t("chat:modes.title")}</span>
                <span className="text-xs text-muted-foreground">
                  {t(`chat:modes.${modeId}.label`)}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64 overflow-hidden">
                <ScrollArea className="max-h-[min(24rem,calc(var(--available-height)-0.5rem))]">
                  {WORK_MODE_IDS.map((id) => {
                    const Icon = MODE_ICONS[id];
                    return (
                      <DropdownMenuCheckboxItem
                        key={id}
                        checked={modeId === id}
                        disabled={busy}
                        onCheckedChange={() => changeMode(id)}
                      >
                        <Icon />
                        <span className="min-w-0">
                          <span className="block">{t(`chat:modes.${id}.label`)}</span>
                          <span className="block whitespace-normal break-words text-xs text-muted-foreground">
                            {t(`chat:modes.${id}.desc`)}
                          </span>
                        </span>
                      </DropdownMenuCheckboxItem>
                    );
                  })}
                </ScrollArea>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ShieldIcon />
                {t("chat:approvals.title")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64 overflow-hidden">
                <ScrollArea className="max-h-[min(24rem,calc(var(--available-height)-0.5rem))]">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{t("chat:approvals.title")}</DropdownMenuLabel>
                    {APPROVAL_PRESETS.map((preset) => (
                      <DropdownMenuItem
                        key={preset.id}
                        onClick={() =>
                          void setPermissionRules(preset.rules).catch((error: unknown) =>
                            toast.error(error instanceof Error ? error.message : t("common:error")),
                          )
                        }
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block">
                            {t(
                              preset.id === "standard"
                                ? "chat:approvals.standard.label"
                                : "chat:approvals.allowAll.label",
                            )}
                          </span>
                          <span className="block whitespace-normal break-words text-xs text-muted-foreground">
                            {t(
                              preset.id === "standard"
                                ? "chat:approvals.standard.desc"
                                : modeId === "plan"
                                  ? "chat:approvals.allowAll.planDesc"
                                  : "chat:approvals.allowAll.desc",
                            )}
                          </span>
                        </span>
                        {matchApprovalPreset(permissionRules) === preset.id && <CheckIcon />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </ScrollArea>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuCheckboxItem
              checked={goal}
              onCheckedChange={onGoalChange}
              disabled={!goalAvailable || busy}
            >
              <TargetIcon />
              <span className="min-w-0">{t("chat:goal.title")}</span>
            </DropdownMenuCheckboxItem>
          </ScrollArea>
        </PromptInputActionMenuContent>
      </PromptInputActionMenu>
      {modeId !== DEFAULT_MODE_ID && (
        <PromptInputButton
          aria-label={t("chat:modes.resetToBuild")}
          title={t("chat:modes.resetToBuild")}
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => changeMode(DEFAULT_MODE_ID)}
        >
          <ActiveModeIcon />
          <span className="max-w-20 truncate text-xs">{t(`chat:modes.${modeId}.label`)}</span>
          <XIcon className="size-3" />
        </PromptInputButton>
      )}
      {goal && (
        <PromptInputButton
          aria-label={t("chat:goal.cancelMode")}
          title={t("chat:goal.composerHint")}
          size="sm"
          variant="secondary"
          onClick={() => onGoalChange(false)}
        >
          <TargetIcon />
          <span className="text-xs">{t("chat:goal.title")}</span>
          <XIcon className="size-3" />
        </PromptInputButton>
      )}
      {searchSelection && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <PromptInputButton aria-label={t("chat:search.title")} size="sm" variant="outline" />
            }
          >
            <GlobeIcon />
            <span className="max-w-28 truncate text-xs">
              {t(`chat:search.engines.${searchSelection.engine}.label`)} ·{" "}
              {t(`chat:search.depths.${searchSelection.depth}.label`)}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" className="w-60 overflow-hidden">
            <SearchMenuItems selection={searchSelection} onSelect={setSearchSelection} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </PromptInputTools>
  );
}
