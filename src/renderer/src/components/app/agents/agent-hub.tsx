import {
  BotIcon,
  CopyIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  UsersRoundIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { MASTRA_SERVER_URL } from "@/lib/providers";
import { type AgentProfile, DEFAULT_AGENT_PROFILE, useWorkbench } from "@/lib/workbench";

type HubTab = "all" | "agent" | "team" | "mine";
type DraftField =
  | "displayName"
  | "profession"
  | "description"
  | "instructions"
  | "workflowStrategy"
  | "memberText";
type Draft = {
  type: AgentProfile["type"];
  displayName: string;
  profession: string;
  description: string;
  instructions: string;
  workflowStrategy: "supervisor" | "sequence" | "parallel";
  memberText: string;
};

type AssistDraft = {
  displayName?: unknown;
  profession?: unknown;
  description?: unknown;
  instructions?: unknown;
  workflow?: { strategy?: unknown };
  members?: unknown;
};

const createEmptyDraft = (type: AgentProfile["type"] = "agent"): Draft => ({
  type,
  displayName: "",
  profession: "",
  description: "",
  instructions: "",
  workflowStrategy: "supervisor",
  memberText: "",
});

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function memberTextFromDraft(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter(
      (member): member is Record<string, unknown> => typeof member === "object" && member !== null,
    )
    .map((member) => {
      const name = textValue(member.name) || "团队成员";
      const profession = textValue(member.profession);
      const instructions = textValue(member.instructions);
      const skills = Array.isArray(member.skills)
        ? member.skills.filter((value): value is string => typeof value === "string").join(",")
        : "";
      const tools = Array.isArray(member.tools)
        ? member.tools.filter((value): value is string => typeof value === "string").join(",")
        : "";
      return [name, profession, instructions, skills, tools].join("|");
    })
    .join("\n");
}

function membersFromText(value: string): AgentProfile["members"] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [name = "团队成员", profession = "", instructions = "", skills = "", tools = ""] =
        line.split("|");
      return {
        id: `member-${index + 1}`,
        name: name.trim() || "团队成员",
        profession: profession.trim(),
        description: profession.trim(),
        instructions: instructions.trim() || `负责${profession.trim() || "完成分配的专业任务"}。`,
        skills: skills
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        tools: tools
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        memoryScope: "thread",
      };
    });
}

export function AgentHub() {
  const { agents, refreshAgents, setAgentSelection, setAgentOpen } = useWorkbench();
  const [tab, setTab] = React.useState<HubTab>("all");
  const [query, setQuery] = React.useState("");
  const [editing, setEditing] = React.useState<AgentProfile | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft>(createEmptyDraft());
  const [saving, setSaving] = React.useState(false);
  const [assistOpen, setAssistOpen] = React.useState(false);
  const [assistType, setAssistType] = React.useState<AgentProfile["type"]>("agent");
  const [assistDescription, setAssistDescription] = React.useState("");
  const [assisting, setAssisting] = React.useState(false);

  const filtered = agents.filter((profile) => {
    if (tab === "agent" && profile.type !== "agent") return false;
    if (tab === "team" && profile.type !== "team") return false;
    if (tab === "mine" && profile.id === DEFAULT_AGENT_PROFILE.id) return false;
    const haystack =
      `${profile.displayName} ${profile.profession} ${profile.description} ${profile.tags.join(" ")}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });

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
      memberText: profile.members
        .map(
          (member) =>
            `${member.name}|${member.profession}|${member.instructions}|${member.skills.join(",")}|${member.tools.join(",")}`,
        )
        .join("\n"),
    });
    setDialogOpen(true);
  };

  const generateAssistDraft = async () => {
    if (!assistDescription.trim()) {
      toast.error("请先描述你想要的 Agent 或团队");
      return;
    }
    setAssisting(true);
    try {
      const response = await fetch(`${MASTRA_SERVER_URL}/work/agents/assist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: assistType, description: assistDescription.trim() }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        draft?: AssistDraft;
        error?: string;
      };
      if (!response.ok || !payload.draft) {
        throw new Error(payload.error ?? "AI 创建失败,请稍后重试");
      }
      const generated = payload.draft;
      setEditing(null);
      setDraft({
        type: assistType,
        displayName: textValue(generated.displayName),
        profession: textValue(generated.profession),
        description: textValue(generated.description),
        instructions: textValue(generated.instructions),
        workflowStrategy:
          generated.workflow?.strategy === "sequence" || generated.workflow?.strategy === "parallel"
            ? generated.workflow.strategy
            : "supervisor",
        memberText: memberTextFromDraft(generated.members),
      });
      setAssistOpen(false);
      setDialogOpen(true);
      toast.success("AI 已生成草稿,请确认后保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "AI 创建失败");
    } finally {
      setAssisting(false);
    }
  };

  const save = async () => {
    const members = membersFromText(draft.memberText);
    if (!draft.displayName.trim() || !draft.instructions.trim()) {
      toast.error("请至少填写名称和工作指令");
      return;
    }
    if (draft.type === "team" && members.length === 0) {
      toast.error("团队至少需要一位成员");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`${MASTRA_SERVER_URL}/work/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
                  steps: members.map((member, index) => ({
                    id: `step-${index + 1}`,
                    memberId: member.id,
                  })),
                  synthesis: true,
                }
              : undefined,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "保存失败");
      }
      const payload = (await response.json().catch(() => ({}))) as { agent?: AgentProfile };
      await refreshAgents();
      if (payload.agent) await setAgentSelection(payload.agent);
      setEditing(null);
      setDialogOpen(false);
      toast.success("Agent 配置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (profile: AgentProfile) => {
    if (profile.id === DEFAULT_AGENT_PROFILE.id) return;
    const response = await fetch(
      `${MASTRA_SERVER_URL}/work/agents/${encodeURIComponent(profile.id)}`,
      {
        method: "DELETE",
      },
    );
    if (response.ok) {
      await refreshAgents();
      toast.success("Agent 已删除");
    } else {
      toast.error("删除失败");
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
        <div className="relative min-w-52 flex-1">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-8"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 Agent、团队或职责"
          />
        </div>
        <Button variant="outline" onClick={() => openAssist("agent")}>
          <SparklesIcon />
          AI 创建 Agent
        </Button>
        <Button onClick={() => openAssist("team")}>
          <SparklesIcon />
          AI 创建团队
        </Button>
        <Button
          variant="ghost"
          title="手动创建"
          aria-label="手动创建"
          size="icon"
          onClick={() => openCreate("agent")}
        >
          <PlusIcon />
        </Button>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as HubTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mx-5 mt-3 w-fit">
          <TabsTrigger value="all">全部</TabsTrigger>
          <TabsTrigger value="agent">Agent</TabsTrigger>
          <TabsTrigger value="team">Agent 团队</TabsTrigger>
          <TabsTrigger value="mine">我的</TabsTrigger>
        </TabsList>
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3 p-5">
            {filtered.map((profile) => (
              <AgentCard
                key={profile.id}
                profile={profile}
                onUse={async () => {
                  await setAgentSelection(profile);
                  setAgentOpen(false);
                }}
                onEdit={() => openEdit(profile)}
                onDelete={() => void remove(profile)}
              />
            ))}
          </div>
        </ScrollArea>
      </Tabs>

      <Dialog open={assistOpen} onOpenChange={setAssistOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>AI 创建{assistType === "team" ? " Agent 团队" : " Agent"}</DialogTitle>
            <DialogDescription>
              用一句话描述目标、专业领域和工作方式。生成的草稿会打开编辑器,你可以在保存前微调。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <fieldset className="grid gap-2 border-0 p-0">
              <legend className="text-sm font-medium">创建类型</legend>
              <div className="flex gap-2">
                {(["agent", "team"] as const).map((type) => (
                  <Button
                    key={type}
                    type="button"
                    variant={assistType === type ? "secondary" : "outline"}
                    aria-pressed={assistType === type}
                    onClick={() => setAssistType(type)}
                  >
                    {type === "team" ? <UsersRoundIcon /> : <BotIcon />}
                    {type === "team" ? "Agent 团队" : "Agent"}
                  </Button>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-2 text-sm font-medium">
              <label htmlFor="agent-assist-description">你想让它负责什么?</label>
              <Textarea
                id="agent-assist-description"
                autoFocus
                className="min-h-36 resize-y"
                value={assistDescription}
                onChange={(event) => setAssistDescription(event.target.value)}
                placeholder="例如: 审查 React 项目的性能和安全问题,输出按优先级排序的修改建议。"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssistOpen(false)} disabled={assisting}>
              取消
            </Button>
            <Button
              onClick={() => void generateAssistDraft()}
              disabled={assisting || !assistDescription.trim()}
            >
              {assisting ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />}
              {assisting ? "正在生成…" : "生成草稿"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => (open ? setDialogOpen(true) : closeEditor())}
      >
        <DialogContent className="flex max-h-[min(90vh,52rem)] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>
              {editing ? "编辑" : "确认"}
              {draft.type === "team" ? " Agent 团队" : " Agent"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "只保留会影响执行的配置,模型与密钥沿用设置中的供应商。"
                : "AI 已填好基础配置,确认或微调后即可使用。"}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1 pr-3">
            <div className="grid gap-4 py-2">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5 text-sm font-medium">
                  <label htmlFor="agent-display-name">名称</label>
                  <Input
                    id="agent-display-name"
                    value={draft.displayName}
                    onChange={(event) => updateDraft("displayName", event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5 text-sm font-medium">
                  <label htmlFor="agent-profession">定位</label>
                  <Input
                    id="agent-profession"
                    value={draft.profession}
                    onChange={(event) => updateDraft("profession", event.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-1.5 text-sm font-medium">
                <label htmlFor="agent-description">简介</label>
                <Textarea
                  id="agent-description"
                  className="min-h-20 resize-y"
                  value={draft.description}
                  onChange={(event) => updateDraft("description", event.target.value)}
                />
              </div>
              <div className="grid gap-1.5 text-sm font-medium">
                <label htmlFor="agent-instructions">工作指令</label>
                <Textarea
                  id="agent-instructions"
                  className="min-h-32 resize-y"
                  value={draft.instructions}
                  onChange={(event) => updateDraft("instructions", event.target.value)}
                />
              </div>
              {draft.type === "team" ? (
                <>
                  <fieldset className="grid gap-2 border-0 p-0 text-sm font-medium">
                    <legend>执行策略</legend>
                    <div className="flex flex-wrap gap-2">
                      {(["supervisor", "sequence", "parallel"] as const).map((strategy) => (
                        <Button
                          key={strategy}
                          type="button"
                          size="sm"
                          variant={draft.workflowStrategy === strategy ? "secondary" : "outline"}
                          aria-pressed={draft.workflowStrategy === strategy}
                          onClick={() => updateDraft("workflowStrategy", strategy)}
                        >
                          {strategy === "supervisor"
                            ? "智能委派"
                            : strategy === "sequence"
                              ? "按成员顺序"
                              : "并行协作"}
                        </Button>
                      ))}
                    </div>
                    <span className="text-xs font-normal text-muted-foreground">
                      保存后会注册为 Mastra dynamic workflow,成员顺序来自下方列表。
                    </span>
                  </fieldset>
                  <div className="grid gap-1.5 text-sm font-medium">
                    <label htmlFor="agent-team-members">团队成员</label>
                    <Textarea
                      id="agent-team-members"
                      className="min-h-28 resize-y"
                      placeholder="每行一位: 姓名 | 专业职责 | 成员指令 | 技能ID(可选) | 工具名(可选)"
                      value={draft.memberText}
                      onChange={(event) => updateDraft("memberText", event.target.value)}
                    />
                    <span className="text-xs font-normal text-muted-foreground">
                      每位成员都会注册为独立 Mastra Agent,并按上方策略执行。
                    </span>
                  </div>
                </>
              ) : null}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={closeEditor} disabled={saving}>
              取消
            </Button>
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
              {saving ? "保存中…" : "保存并使用"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AgentCard({
  profile,
  onUse,
  onEdit,
  onDelete,
}: {
  profile: AgentProfile;
  onUse: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const Icon = profile.type === "team" ? UsersRoundIcon : BotIcon;
  const isDefault = profile.id === DEFAULT_AGENT_PROFILE.id;

  const handleCopyInfo = () => {
    void navigator.clipboard.writeText(profile.displayName);
    toast.success("已复制专家名称");
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger className="flex min-h-52 flex-col">
        <Card className="flex min-h-52 flex-col h-full">
          <CardHeader className="pb-2">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted">
                <Icon className="size-5" />
              </div>
              <div className="min-w-0">
                <CardTitle className="truncate text-base">{profile.displayName}</CardTitle>
                <CardDescription className="truncate">
                  {profile.profession || (profile.type === "team" ? "Agent 团队" : "Agent")}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1">
            <p className="line-clamp-3 text-sm text-muted-foreground">
              {profile.description || profile.instructions}
            </p>
            <div className="mt-3 flex flex-wrap gap-1">
              {profile.tags.slice(0, 4).map((tag) => (
                <Badge key={tag} variant="secondary" className="text-[10px]">
                  {tag}
                </Badge>
              ))}
              {profile.type === "team" ? (
                <Badge variant="outline" className="text-[10px]">
                  {profile.members.length} 位成员
                </Badge>
              ) : null}
            </div>
          </CardContent>
          <CardFooter className="gap-1.5">
            <Button size="sm" className="flex-1" onClick={onUse}>
              使用
            </Button>
            {!isDefault ? (
              <>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="编辑"
                  aria-label="编辑"
                  onClick={onEdit}
                >
                  <PencilIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="删除"
                  aria-label="删除"
                  onClick={onDelete}
                >
                  <Trash2Icon />
                </Button>
              </>
            ) : null}
          </CardFooter>
        </Card>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuGroup>
          <ContextMenuLabel className="truncate max-w-44">{profile.displayName}</ContextMenuLabel>
          <ContextMenuItem onClick={onUse}>
            <Icon className="text-muted-foreground" />
            <span>立即使用此专家</span>
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopyInfo}>
            <CopyIcon className="text-muted-foreground" />
            <span>复制专家名称</span>
          </ContextMenuItem>
        </ContextMenuGroup>
        {!isDefault ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem onClick={onEdit}>
                <PencilIcon className="text-muted-foreground" />
                <span>编辑配置</span>
                <ContextMenuShortcut>F2</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem variant="destructive" onClick={onDelete}>
                <Trash2Icon className="text-muted-foreground" />
                <span>删除专家</span>
                <ContextMenuShortcut>⌫</ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuGroup>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
