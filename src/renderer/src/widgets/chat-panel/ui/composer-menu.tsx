import { skipToken, useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BotIcon,
  FileIcon,
  FolderIcon,
  LibraryIcon,
  PlugIcon,
  PlusIcon,
  SparklesIcon,
  TargetIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { fetchMcpServers } from "@/entities/skill/api/skill-api";
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
  PromptInputTools,
  usePromptInputAttachments,
} from "@/shared/ui/ai-elements/prompt-input";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/shared/ui/dropdown-menu";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { fetchChatAssetBlob, fetchChatLibraryAssets, fetchChatSkills } from "../api/chat-api";
import type { MessageFileReference } from "../model/types";
import { ChatSearchSelector } from "./search-selector";

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
  const { agents, agentSelection, setAgentSelection } = useSessionSettings(userId, threadId);
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
    <PromptInputTools>
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
          <ScrollArea className="max-h-[min(28rem,var(--available-height))]">
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
            <DropdownMenuCheckboxItem
              checked={goal}
              onCheckedChange={onGoalChange}
              disabled={!goalAvailable || busy}
            >
              <TargetIcon />
              <span className="min-w-0">
                <span className="block">{t("chat:goal.sendAsGoal")}</span>
                <span className="block whitespace-normal text-xs text-muted-foreground">
                  {t(goalAvailable ? "chat:goal.sendHint" : "chat:goal.workflowUnavailable")}
                </span>
              </span>
            </DropdownMenuCheckboxItem>
          </ScrollArea>
        </PromptInputActionMenuContent>
      </PromptInputActionMenu>
      <ChatSearchSelector />
    </PromptInputTools>
  );
}
