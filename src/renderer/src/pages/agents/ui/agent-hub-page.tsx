import {
  BotIcon,
  CopyIcon,
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
  saveAgent,
  useWorkbench,
} from "@/entities/workbench";
import { cn } from "@/shared/lib";
import { AnimatedBeam } from "@/shared/ui/animated-beam";
import { AnimatedGradientText } from "@/shared/ui/animated-gradient-text";
import { AnimatedTabs } from "@/shared/ui/animated-tabs";
import { Badge } from "@/shared/ui/badge";
import { BlurFade } from "@/shared/ui/blur-fade";
import { Button } from "@/shared/ui/button";
import { CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/shared/ui/card";
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
import { InteractiveHoverButton } from "@/shared/ui/interactive-hover-button";
import { MagicCard } from "@/shared/ui/magic-card";
import { NeonGradientCard } from "@/shared/ui/neon-gradient-card";
import { OrbitingCircles } from "@/shared/ui/orbiting-circles";
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

const STRATEGY_OPTIONS = [
  { value: "supervisor", label: "Supervisors · 智能委派" },
  { value: "handoff", label: "Handoffs · 顺序交接" },
  { value: "workflow", label: "Workflows · 显式编排" },
  { value: "council", label: "Council · 并行评议" },
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
      return [name, profession, instructions, skills].join("|");
    })
    .join("\n");
}

function membersFromText(value: string): AgentProfile["members"] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [name = "团队成员", profession = "", instructions = "", skills = ""] = line.split("|");
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
        memoryScope: "thread",
      };
    });
}

export function AgentHubPage() {
  const { agents, agentSelection, refreshAgents, setAgentSelection, setActiveView } =
    useWorkbench();
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
      toast.error("请先描述你想要的 Agent 或团队");
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
        memberText: memberTextFromDraft(generated.members),
        workflowStepsJson: JSON.stringify(
          Array.isArray(generated.workflow?.steps) ? generated.workflow.steps : [],
          null,
          2,
        ),
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
      let workflowSteps = members.map((member, index) => ({
        id: `step-${index + 1}`,
        memberId: member.id,
      }));
      if (draft.type === "team" && draft.workflowStrategy === "workflow") {
        try {
          const parsed = JSON.parse(draft.workflowStepsJson);
          if (!Array.isArray(parsed)) throw new Error("编排节点必须是数组");
          workflowSteps = parsed as typeof workflowSteps;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "编排节点 JSON 无效");
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
      await refreshAgents();
      if (savedAgent) await setAgentSelection(savedAgent);
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
    try {
      await deleteAgent(profile.id);
      await refreshAgents();
      toast.success("Agent 已删除");
    } catch {
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
        <InputGroup className="min-w-52 flex-1">
          <InputGroupAddon align="inline-start">
            <SearchIcon className="size-4 text-muted-foreground" />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 Agent、团队或职责"
          />
        </InputGroup>
        <RainbowButton variant="outline" onClick={() => openAssist("agent")}>
          <SparklesIcon />
          AI 创建 Agent
        </RainbowButton>
        <RainbowButton onClick={() => openAssist("team")}>
          <SparklesIcon />
          AI 创建团队
        </RainbowButton>
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

      <div className="flex min-h-0 flex-1 flex-col">
        <AnimatedTabs
          activeTab={tab}
          onChange={(value) => setTab(value as HubTab)}
          layoutId="agent-hub-filter"
          variant="segmented"
          aria-label="Agent 分类"
          className="mx-5 mt-3 w-fit"
          tabs={[
            { id: "all", label: "全部" },
            { id: "agent", label: "Agent" },
            { id: "team", label: "Agent 团队" },
            { id: "mine", label: "我的" },
          ]}
        />
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3 p-5">
            {filtered.length === 0 ? (
              <Empty className="col-span-full">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SearchIcon />
                  </EmptyMedia>
                  <EmptyTitle>
                    {query.trim() ? "没有匹配的 Agent" : "当前分类还没有 Agent"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {query.trim()
                      ? "换个关键词试试，或者清空搜索查看全部 Agent。"
                      : "手动创建一个 Agent，或者用 AI 根据一句话描述生成。"}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent className="flex-row justify-center gap-2">
                  {query.trim() ? (
                    <Button variant="outline" onClick={() => setQuery("")}>
                      <SearchIcon />
                      清空搜索
                    </Button>
                  ) : null}
                  <Button onClick={() => openCreate("agent")}>
                    <PlusIcon />
                    手动创建
                  </Button>
                  <Button variant="outline" onClick={() => openAssist("agent")}>
                    <SparklesIcon />
                    AI 创建
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              filtered.map((profile) => (
                <AgentCard
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
              ))
            )}
          </div>
        </ScrollArea>
      </div>

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
                  Agent
                </ToggleGroupItem>
                <ToggleGroupItem value="team">
                  <UsersRoundIcon />
                  Agent 团队
                </ToggleGroupItem>
              </ToggleGroup>
            </fieldset>
            <Field>
              <FieldLabel htmlFor="agent-assist-description">你想让它负责什么?</FieldLabel>
              <Textarea
                id="agent-assist-description"
                autoFocus
                className="min-h-36 resize-y"
                value={assistDescription}
                onChange={(event) => setAssistDescription(event.target.value)}
                placeholder="例如: 审查 React 项目的性能和安全问题,输出按优先级排序的修改建议。"
              />
            </Field>
          </div>
          <DialogFooter>
            <DialogClose
              render={
                <Button variant="outline" disabled={assisting}>
                  取消
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
                <Field>
                  <FieldLabel htmlFor="agent-display-name">名称</FieldLabel>
                  <Input
                    id="agent-display-name"
                    value={draft.displayName}
                    onChange={(event) => updateDraft("displayName", event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="agent-profession">定位</FieldLabel>
                  <Input
                    id="agent-profession"
                    value={draft.profession}
                    onChange={(event) => updateDraft("profession", event.target.value)}
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="agent-description">简介</FieldLabel>
                <Textarea
                  id="agent-description"
                  className="min-h-20 resize-y"
                  value={draft.description}
                  onChange={(event) => updateDraft("description", event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-instructions">工作指令</FieldLabel>
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
                    <legend>执行策略</legend>
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
                      {STRATEGY_OPTIONS.map((option) => (
                        <ToggleGroupItem
                          key={option.value}
                          value={option.value}
                          className="h-8 px-3 text-xs"
                        >
                          {option.label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    <span className="text-xs font-normal text-muted-foreground">
                      Workflows 策略会按配置生成显式 Mastra
                      Workflow；其中可使用分支、循环和人工审批节点。
                    </span>
                    <TeamFlowPreview
                      strategy={draft.workflowStrategy}
                      members={membersFromText(draft.memberText).map((member) => member.name)}
                    />
                  </fieldset>
                  <Field>
                    <FieldLabel htmlFor="agent-team-members">团队成员</FieldLabel>
                    <Textarea
                      id="agent-team-members"
                      className="min-h-28 resize-y"
                      placeholder="每行一位: 姓名 | 专业职责 | 成员指令 | 技能ID(可选)"
                      value={draft.memberText}
                      onChange={(event) => updateDraft("memberText", event.target.value)}
                    />
                    <FieldDescription className="text-xs text-muted-foreground">
                      每位成员都会注册为独立 Mastra Agent,并按上方策略执行。
                    </FieldDescription>
                  </Field>
                  {draft.workflowStrategy === "workflow" ? (
                    <Field>
                      <FieldLabel htmlFor="agent-workflow-steps">编排节点(JSON)</FieldLabel>
                      <Textarea
                        id="agent-workflow-steps"
                        className="min-h-40 resize-y font-mono text-xs"
                        value={draft.workflowStepsJson}
                        onChange={(event) => updateDraft("workflowStepsJson", event.target.value)}
                        placeholder={
                          '[{"id":"review","kind":"approval","approval":{"title":"确认发布","description":"请确认后继续"}}]'
                        }
                      />
                      <FieldDescription className="text-xs text-muted-foreground">
                        节点 kind 支持 agent、approval、branch、loop；branch 使用
                        branch.onTrueMemberId/onFalseMemberId，loop 使用 loop.mode/maxIterations。
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
                  取消
                </Button>
              }
            />
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? <Dotm3x3_1 size={14} dotSize={2.2} colorPreset="solid-theme" /> : null}
              {saving ? "保存中…" : "保存并使用"}
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
  const hubLabel = strategy === "supervisor" ? "调度" : strategy === "council" ? "汇总" : null;
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

function AgentCard({
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
  const Icon = profile.type === "team" ? UsersRoundIcon : BotIcon;
  const isDefault = profile.id === DEFAULT_AGENT_PROFILE.id;
  const isTeam = profile.type === "team";

  const handleCopyInfo = () => {
    void navigator.clipboard.writeText(profile.displayName);
    toast.success("已复制专家名称");
  };

  const card = (
    <MagicCard
      gradientSize={200}
      gradientFrom="var(--primary)"
      gradientTo="var(--accent)"
      className="flex h-full min-h-52 flex-col rounded-xl border bg-card shadow-xs transition-colors duration-200 hover:border-primary/40"
    >
      <CardHeader className="pb-2">
        <div className="flex items-start gap-3">
          {/* 团队卡片:成员图标沿轨道环绕,一眼区分「单 Agent」与「多成员协作」 */}
          {isTeam ? (
            <div className="relative flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted">
              <Icon className="size-5" />
              <OrbitingCircles
                className="size-2 border-none bg-transparent"
                duration={12}
                radius={17}
                iconSize={7}
                path={false}
              >
                {profile.members.slice(0, 3).map((member) => (
                  <span
                    key={member.id}
                    className="block size-1.5 rounded-full bg-primary"
                    title={member.name}
                  />
                ))}
              </OrbitingCircles>
            </div>
          ) : (
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted">
              <Icon className="size-5" />
            </div>
          )}
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{profile.displayName}</CardTitle>
            <CardDescription className="truncate">
              {isTeam ? (
                <AnimatedGradientText
                  className="text-sm"
                  colorFrom="var(--primary)"
                  colorTo="var(--accent)"
                >
                  {profile.profession || "Agent 团队"}
                </AnimatedGradientText>
              ) : (
                profile.profession || "Agent"
              )}
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
          {isTeam ? (
            <Badge variant="outline" className="text-[10px]">
              {profile.members.length} 位成员
            </Badge>
          ) : null}
        </div>
      </CardContent>
      <CardFooter className="gap-1.5">
        <InteractiveHoverButton
          className="min-w-0 flex-1 border-primary/30 px-4 py-1.5 text-sm"
          onClick={onUse}
        >
          {active ? "使用中" : "使用"}
        </InteractiveHoverButton>
        {!isDefault ? (
          <>
            <Button size="icon-sm" variant="ghost" title="编辑" aria-label="编辑" onClick={onEdit}>
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
    </MagicCard>
  );

  return (
    <BlurFade duration={0.25} blur="4px" className="h-full">
      <ContextMenu>
        <ContextMenuTrigger className="flex h-full min-h-52 flex-col">
          {/* 当前激活的 Agent 才套霓虹外框 —— 它是常驻动画 + 双色 blur,
              套满整个卡片网格既会掉帧,也让「激活」失去区分度 */}
          {active ? (
            <NeonGradientCard
              borderRadius={12}
              borderSize={1.5}
              className="h-full w-full"
              neonColors={{ firstColor: "var(--primary)", secondColor: "var(--accent)" }}
            >
              {card}
            </NeonGradientCard>
          ) : (
            card
          )}
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
    </BlurFade>
  );
}

export { AgentHubPage as AgentHub };
