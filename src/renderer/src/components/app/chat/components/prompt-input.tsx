import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { FileUIPart, LanguageModelUsage } from "ai";
import {
  FileIcon,
  GripVerticalIcon,
  ListTodoIcon,
  PaperclipIcon,
  PencilIcon,
  SparklesIcon,
  Trash2Icon,
  WaypointsIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  type PromptInputFileDescriptor,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import {
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemContent,
  QueueItemDescription,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MASTRA_SERVER_URL } from "@/lib/providers";
import { useWorkbench } from "@/lib/workbench";
import { ChatApprovalSelector } from "./approval-selector";
import { ChatContextUsage } from "./context-usage";
import { ChatModeSelector } from "./mode-selector";
import { ChatModelSelector } from "./model-selector";
import { PromptInputGlow } from "./prompt-input-glow";
import { ChatSearchSelector } from "./search-selector";
import type { CompressResult, MessageFileReference, QueuedRequest } from "../types";

// ---------------------------------------------------------------------------
// 输入区工具按钮(Paperclip 附件 / 审批模式 / 联网检索多级菜单)
// 必须位于 PromptInputProvider 内部以访问附件上下文
// ---------------------------------------------------------------------------

function PromptInputActions() {
  const attachments = usePromptInputAttachments();

  return (
    <PromptInputTools>
      {/* 附件 → 审批模式 → 联网检索,依次排在整个输入区的左侧 */}
      <Tooltip>
        <TooltipTrigger
          render={
            <PromptInputButton
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="添加附件"
              onClick={attachments.openFileDialog}
            />
          }
        >
          <PaperclipIcon className="text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent>
          <p>添加附件</p>
        </TooltipContent>
      </Tooltip>
      <ChatApprovalSelector />
      <ChatSearchSelector />
    </PromptInputTools>
  );
}

function PromptInputAttachments() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;

  return (
    <PromptInputHeader className="bg-muted/40 px-2 pt-2 pb-1">
      {/* 横向滚动胶囊(inline variant),超出输入框宽度时左右滚动 */}
      <ScrollArea className="w-full">
        <Attachments className="w-max gap-1.5 pb-1" variant="inline">
          {attachments.files.map((file) => (
            <Attachment
              className="max-w-64"
              data={file}
              key={file.id}
              onRemove={() => attachments.remove(file.id)}
            >
              <AttachmentPreview />
              <AttachmentInfo className="text-xs" />
              <AttachmentRemove label={`移除 ${file.filename ?? "附件"}`} />
            </Attachment>
          ))}
        </Attachments>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </PromptInputHeader>
  );
}

interface SkillOption {
  name: string;
  description: string;
}

interface FileReferenceOption extends MessageFileReference {
  mediaType: string;
  byteSize: number;
}

function SkillAwareTextarea({
  selectedSkills,
  onChangeSkills,
  selectedFileReferences,
  onChangeFileReferences,
  placeholder,
}: {
  selectedSkills: string[];
  onChangeSkills: (skills: string[]) => void;
  selectedFileReferences: MessageFileReference[];
  onChangeFileReferences: (files: MessageFileReference[]) => void;
  placeholder: string;
}) {
  const controller = usePromptInputController();
  const { user } = useWorkbench();
  const [skills, setSkills] = React.useState<SkillOption[]>([]);
  const [files, setFiles] = React.useState<FileReferenceOption[]>([]);
  const [query, setQuery] = React.useState("");
  const [command, setCommand] = React.useState<"skill" | "file" | null>(null);

  React.useEffect(() => {
    void Promise.all([
      fetch(`${MASTRA_SERVER_URL}/work/skills`).then(async (response) => {
        if (!response.ok) return [];
        const payload = (await response.json()) as { skills?: SkillOption[] };
        return payload.skills ?? [];
      }),
      fetch(
        `${MASTRA_SERVER_URL}/work/library/assets?resourceId=${encodeURIComponent(user.id)}`,
      ).then(async (response) => {
        if (!response.ok) return [];
        const payload = (await response.json()) as {
          assets?: Array<{
            id: string;
            filename: string;
            mediaType: string;
            byteSize: number;
          }>;
        };
        return (payload.assets ?? []).map((asset) => ({
          ...asset,
          url: `${MASTRA_SERVER_URL}/work/library/assets/${encodeURIComponent(asset.id)}/content?resourceId=${encodeURIComponent(user.id)}`,
        }));
      }),
    ])
      .then(([nextSkills, nextFiles]) => {
        setSkills(nextSkills);
        setFiles(nextFiles);
      })
      .catch(() => undefined);
  }, [user.id]);

  const handleTextChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.currentTarget.value;
    const skillMatch = /(?:^|\s)\/([a-zA-Z0-9_-]*)$/.exec(value);
    const fileMatch = /(?:^|\s)@([^\s@]*)$/.exec(value);
    if (skillMatch) {
      setCommand("skill");
      setQuery(skillMatch[1]);
    } else if (fileMatch) {
      setCommand("file");
      setQuery(fileMatch[1]);
    } else {
      setCommand(null);
      setQuery("");
    }
  };

  const visibleSkills = skills.filter((skill) => {
    const needle = query.toLocaleLowerCase();
    return (
      !needle ||
      skill.name.toLocaleLowerCase().includes(needle) ||
      skill.description.toLocaleLowerCase().includes(needle)
    );
  });

  const visibleFiles = files.filter((file) => {
    const needle = query.toLocaleLowerCase();
    return !needle || file.filename.toLocaleLowerCase().includes(needle);
  });

  const removeCommandToken = (token: string) =>
    controller.textInput.value.replace(new RegExp(`(?:^|\\s)${token}[^\\s]*$`), "").trimEnd();

  const selectSkill = (skill: SkillOption) => {
    controller.textInput.setInput(removeCommandToken("/"));
    onChangeSkills(
      selectedSkills.includes(skill.name) ? selectedSkills : [...selectedSkills, skill.name],
    );
    setCommand(null);
    setQuery("");
  };

  const selectFile = (file: FileReferenceOption) => {
    controller.textInput.setInput(removeCommandToken("@"));
    if (!selectedFileReferences.some((item) => item.url === file.url)) {
      controller.attachments.restore([
        {
          type: "file",
          url: file.url,
          filename: file.filename,
          mediaType: file.mediaType,
        },
      ]);
      onChangeFileReferences([...selectedFileReferences, file]);
    }
    setCommand(null);
    setQuery("");
  };

  return (
    <>
      <PromptInputTextarea onChange={handleTextChange} placeholder={placeholder} />
      {command ? (
        <div className="absolute bottom-full left-2 z-30 mb-2 w-[min(24rem,calc(100%-1rem))] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg">
          <Command shouldFilter={false}>
            <CommandList className="max-h-64">
              {command === "skill" ? (
                <CommandGroup heading="技能与指令">
                  {visibleSkills.length === 0 ? (
                    <CommandEmpty>暂无技能</CommandEmpty>
                  ) : (
                    visibleSkills.map((skill) => (
                      <CommandItem
                        key={skill.name}
                        onSelect={() => selectSkill(skill)}
                        value={skill.name}
                      >
                        <SparklesIcon className="size-4 shrink-0 text-primary" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">/{skill.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {skill.description}
                          </span>
                        </span>
                      </CommandItem>
                    ))
                  )}
                </CommandGroup>
              ) : (
                <CommandGroup heading="对话文件">
                  {visibleFiles.length === 0 ? (
                    <CommandEmpty>暂无资料</CommandEmpty>
                  ) : (
                    visibleFiles.map((file) => (
                      <CommandItem
                        key={file.id}
                        onSelect={() => selectFile(file)}
                        value={file.filename}
                      >
                        <FileIcon className="size-4 shrink-0 text-primary" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">@{file.filename}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {file.mediaType || "文件"}
                          </span>
                        </span>
                      </CommandItem>
                    ))
                  )}
                </CommandGroup>
              )}
              <CommandSeparator />
            </CommandList>
          </Command>
        </div>
      ) : null}
    </>
  );
}

function SelectedSkillBadges({
  skills,
  onChange,
}: {
  skills: string[];
  onChange: (skills: string[]) => void;
}) {
  if (skills.length === 0) return null;
  return (
    <PromptInputHeader className="gap-1.5 bg-muted/40 px-2 pt-2 pb-1">
      {skills.map((skill) => (
        <Badge
          className="gap-1 border-primary/30 bg-primary/10 text-primary"
          key={skill}
          variant="outline"
        >
          <SparklesIcon className="size-3" />/{skill}
          <button
            aria-label={`移除技能 ${skill}`}
            className="rounded-sm hover:bg-primary/15"
            onClick={() => onChange(skills.filter((item) => item !== skill))}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
    </PromptInputHeader>
  );
}

function SelectedFileReferenceBadges({
  files,
  onRemove,
}: {
  files: MessageFileReference[];
  onRemove: (file: MessageFileReference) => void;
}) {
  if (files.length === 0) return null;
  return (
    <PromptInputHeader className="gap-1.5 bg-muted/40 px-2 pt-2 pb-1">
      {files.map((file) => (
        <Badge
          className="max-w-full gap-1 border-primary/30 bg-primary/10 text-primary"
          key={file.url}
          variant="outline"
        >
          <FileIcon className="size-3 shrink-0" />
          <span className="max-w-52 truncate">@{file.filename}</span>
          <button
            aria-label={`移除文件引用 ${file.filename}`}
            className="rounded-sm hover:bg-primary/15"
            onClick={() => onRemove(file)}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
    </PromptInputHeader>
  );
}

function SortableRequestItem({
  request,
  onEdit,
  onRemove,
  onSteerNow,
}: {
  request: QueuedRequest;
  onEdit: (request: QueuedRequest) => void;
  onRemove: (id: string) => void;
  onSteerNow?: (request: QueuedRequest) => void;
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: request.id });

  return (
    <QueueItem
      className={isDragging ? "relative z-10 bg-muted shadow-sm" : undefined}
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div className="flex min-w-0 items-start gap-1">
        {!request.followUpId ? (
          <Button
            aria-label="拖动请求调整顺序"
            className="mt-0.5 shrink-0 text-muted-foreground"
            ref={setActivatorNodeRef}
            size="icon-xs"
            type="button"
            variant="ghost"
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <QueueItemContent className="line-clamp-2 whitespace-pre-wrap">
            {request.text || "附件请求"}
          </QueueItemContent>
          {request.files.length > 0 ? (
            <QueueItemDescription>{request.files.length} 个附件</QueueItemDescription>
          ) : null}
        </div>
        <QueueItemActions className="shrink-0">
          {/* 立即转向排在编辑左侧:它是这条请求的主动作(打断当前回合、越过
              队列顺序直接发出),编辑/移除是它的辅助动作。native follow-up
              (已被服务端 queueMessage 接受)不能改文本也不能单独撤回,但可以
              被转向——steer 会 abort 当前 run 并作废服务端整个 follow-up 队列 */}
          {onSteerNow ? (
            <QueueItemAction
              aria-label="立即转向到这条请求"
              className="opacity-100"
              onClick={() => onSteerNow(request)}
              title="立即转向:打断当前回合,直接发送这条请求"
            >
              <WaypointsIcon />
            </QueueItemAction>
          ) : null}
          {!request.followUpId ? (
            <QueueItemAction
              aria-label="编辑排队请求"
              className="opacity-100"
              onClick={() => onEdit(request)}
            >
              <PencilIcon />
            </QueueItemAction>
          ) : null}
          {!request.followUpId ? (
            <QueueItemAction
              aria-label="移除排队请求"
              className="opacity-100"
              onClick={() => onRemove(request.id)}
            >
              <Trash2Icon />
            </QueueItemAction>
          ) : null}
        </QueueItemActions>
      </div>
    </QueueItem>
  );
}

export function UserRequestQueuePanel({
  requests,
  onRemove,
  onReorder,
  onSteerNow,
}: {
  requests: QueuedRequest[];
  onRemove: (id: string) => void;
  onReorder: (activeId: string, overId: string) => void;
  onSteerNow?: (request: QueuedRequest) => void;
}) {
  const controller = usePromptInputController();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (requests.length === 0) return null;

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) {
      onReorder(String(active.id), String(over.id));
    }
  };

  const handleEdit = (request: QueuedRequest) => {
    controller.textInput.setInput(request.text);
    controller.attachments.restore(request.files);
    onRemove(request.id);
  };

  return (
    // 只渲染 QueueSection,与 AgentQueuePanel 的任务 section 同住一张 Queue 卡片
    // (由 chat/panel.tsx 统一包裹)——两个队列本是同一份「进行中的工作」,
    // 不各自成卡,避免上下两张卡片叠出的割裂感。
    <QueueSection defaultOpen>
      <QueueSectionTrigger className="px-2 py-1">
        <QueueSectionLabel
          count={requests.length}
          label="排队请求"
          icon={<ListTodoIcon className="size-4" />}
        />
      </QueueSectionTrigger>
      <QueueSectionContent>
        <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd} sensors={sensors}>
          <SortableContext
            items={requests.map((request) => request.id)}
            strategy={verticalListSortingStrategy}
          >
            <QueueList className="mt-1">
              {requests.map((request) => (
                <SortableRequestItem
                  key={request.id}
                  onEdit={handleEdit}
                  onRemove={onRemove}
                  onSteerNow={onSteerNow}
                  request={request}
                />
              ))}
            </QueueList>
          </SortableContext>
        </DndContext>
      </QueueSectionContent>
    </QueueSection>
  );
}

export function ChatPromptInput({
  activeThread,
  usage,
  estimatedUsedTokens,
  onSubmit,
  status,
  onStop,
  compacting,
  onCompress,
  compressResult,
  onCompressResultClose,
  attachmentTokenBudget,
  attachmentCapabilities,
}: {
  activeThread: boolean;
  usage: LanguageModelUsage | undefined;
  estimatedUsedTokens?: number;
  onSubmit: (
    message: {
      text: string;
      files?: Array<FileUIPart & { byteSize?: number; file?: File }>;
      skills?: string[];
      fileReferences?: MessageFileReference[];
    },
    clearPrompt: () => void,
  ) => Promise<void>;
  status: "submitted" | "streaming" | "ready" | "error";
  /**
   * 停止生成。传了它之后按钮在流式期间变成停止态(type="button"),
   * 而 textarea 的 Enter 仍然会 requestSubmit —— 于是「回车追加排队消息」与
   * 「点按钮停止」两个动作互不干扰。
   */
  onStop: () => void | Promise<void>;
  compacting: boolean;
  onCompress: () => void;
  compressResult: CompressResult | null;
  onCompressResultClose: () => void;
  /** 当前模型在预留输出空间后可用于附件的 token 预算。 */
  attachmentTokenBudget?: number;
  attachmentCapabilities?: { vision: boolean; audio: boolean };
}) {
  const controller = usePromptInputController();
  const { pendingLibraryFiles, clearPendingLibraryFiles } = useWorkbench();
  const [selectedSkills, setSelectedSkills] = React.useState<string[]>([]);
  const [selectedFileReferences, setSelectedFileReferences] = React.useState<
    MessageFileReference[]
  >([]);
  const estimateAttachmentTokens = React.useCallback((file: PromptInputFileDescriptor) => {
    const mediaType = file.type.toLowerCase();
    if (mediaType.startsWith("image/")) return Math.max(1_024, Math.ceil(file.size / 1_024));
    if (mediaType.startsWith("audio/")) return Math.max(1_024, Math.ceil(file.size / 512));
    return Math.max(1, Math.ceil(file.size / 3));
  }, []);
  React.useEffect(() => {
    if (pendingLibraryFiles.length === 0) return;
    const currentFiles = controller.attachments.files;
    let tokenTotal = currentFiles.reduce(
      (sum, file) =>
        sum +
        estimateAttachmentTokens({
          name: file.filename ?? "未命名附件",
          size: file.byteSize ?? 0,
          type: file.mediaType ?? "",
          lastModified: 0,
        }),
      0,
    );
    const capacity = Math.max(0, 10 - currentFiles.length);
    let acceptedCount = 0;
    const accepted = pendingLibraryFiles.filter((file) => {
      if (acceptedCount >= capacity) return false;
      const fileTokens = estimateAttachmentTokens({
        name: file.filename ?? "未命名附件",
        size: file.byteSize ?? 0,
        type: file.mediaType ?? "",
        lastModified: 0,
      });
      if (tokenTotal + fileTokens > (attachmentTokenBudget ?? Number.POSITIVE_INFINITY))
        return false;
      tokenTotal += fileTokens;
      acceptedCount += 1;
      return true;
    });
    if (accepted.length > 0) controller.attachments.restore(accepted);
    if (accepted.length < pendingLibraryFiles.length) {
      toast.error("部分资料未添加: 已达到附件数量或上下文预算");
    }
    clearPendingLibraryFiles();
  }, [
    attachmentTokenBudget,
    clearPendingLibraryFiles,
    controller.attachments,
    estimateAttachmentTokens,
    pendingLibraryFiles,
  ]);
  const acceptedFileTypes = [
    ".txt",
    ".md",
    ".markdown",
    ".json",
    ".csv",
    ".tsv",
    ".xml",
    ".yaml",
    ".yml",
    ".html",
    ".pdf",
    ".docx",
    ".xlsx",
    ".xls",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".css",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".sql",
    ...(attachmentCapabilities?.vision ? ["image/*"] : []),
    ...(attachmentCapabilities?.audio ? ["audio/*"] : []),
  ].join(",");
  return (
    // PromptInputGlow(BorderBeam)常驻包裹输入框:生成期间边缘随机流光,
    // 结束后内建淡出;常驻挂载避免输入框 remount 丢焦点,空闲零视觉残留
    <PromptInputGlow status={status}>
      <PromptInput
        multiple
        accept={acceptedFileTypes}
        maxFiles={10}
        maxFileSize={50 * 1024 * 1024}
        maxTotalFileSize={100 * 1024 * 1024}
        maxTotalFileTokens={attachmentTokenBudget}
        estimateFileTokens={estimateAttachmentTokens}
        onError={(error) => toast.error(error.message)}
        onSubmit={(message) =>
          onSubmit(
            { ...message, skills: selectedSkills, fileReferences: selectedFileReferences },
            () => {
              controller.textInput.clear();
              controller.attachments.clear();
              setSelectedSkills([]);
              setSelectedFileReferences([]);
            },
          )
        }
      >
        <PromptInputAttachments />
        <SelectedSkillBadges skills={selectedSkills} onChange={setSelectedSkills} />
        <SelectedFileReferenceBadges
          files={selectedFileReferences}
          onRemove={(file) => {
            const attachment = controller.attachments.files.find((item) => item.url === file.url);
            if (attachment) controller.attachments.remove(attachment.id);
            setSelectedFileReferences((current) => current.filter((item) => item.url !== file.url));
          }}
        />
        <PromptInputBody>
          <SkillAwareTextarea
            onChangeFileReferences={setSelectedFileReferences}
            onChangeSkills={setSelectedSkills}
            placeholder={
              activeThread
                ? "继续对话…  @ 引用对话文件，/ 调用技能与指令"
                : "今天帮你做些什么？  @ 引用对话文件，/ 调用技能与指令"
            }
            selectedFileReferences={selectedFileReferences}
            selectedSkills={selectedSkills}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputActions />
          <div className="flex items-center gap-2">
            <ChatContextUsage
              usage={usage}
              estimatedUsedTokens={estimatedUsedTokens}
              compacting={compacting}
              onCompress={onCompress}
              compressResult={compressResult}
              onCompressResultClose={onCompressResultClose}
            />
            <ChatModeSelector />
            <ChatModelSelector />
            <PromptInputSubmit onStop={() => void onStop()} status={status} />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </PromptInputGlow>
  );
}
