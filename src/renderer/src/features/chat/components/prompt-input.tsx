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
import { useWorkbench } from "@/features/workbench";
import { fetchChatLibraryAssets, fetchChatSkills } from "../api";
import {
  type CompressResult,
  type MessageFileReference,
  type QueuedRequest,
  referenceBadgeClass,
} from "../types";
import { ChatAgentSelector } from "./agent-selector";
import { ChatContextUsage } from "./context-usage";
import { ChatModeSelector } from "./mode-selector";
import { ChatModelSelector } from "./model-selector";
import { PromptInputGlow } from "./prompt-input-glow";
import { ChatSearchSelector } from "./search-selector";

// ---------------------------------------------------------------------------
// 输入区工具按钮(Paperclip 附件 / Agent 选择 / 联网检索多级菜单)
// 必须位于 PromptInputProvider 内部以访问附件上下文
// ---------------------------------------------------------------------------

function PromptInputActions() {
  const attachments = usePromptInputAttachments();

  return (
    // 基类自带 min-w-0,整组可随容器收缩;收缩只发生在各按钮的文字标签上
    // (审批/检索的按钮标签可能 truncate),按钮尺寸与图标不受影响。
    <PromptInputTools>
      {/* 附件 → Agent / Agent 团队 → 联网检索,依次排在整个输入区的左侧 */}
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
      <ChatAgentSelector />
      <ChatSearchSelector />
    </PromptInputTools>
  );
}

function PromptInputAttachments() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;

  return (
    <PromptInputHeader className="bg-muted/40 px-2 pt-2 pb-1 border-b border-border">
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

const skillTokenAttribute = "data-skill-token";

function serializeEditableNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";
  const skillToken = node.getAttribute(skillTokenAttribute);
  if (skillToken) return skillToken;
  if (node.tagName === "BR") return "\n";
  const content = Array.from(node.childNodes).map(serializeEditableNode).join("");
  return ["DIV", "P"].includes(node.tagName) && node.nextSibling ? `${content}\n` : content;
}

function serializeEditable(editor: HTMLElement): string {
  return Array.from(editor.childNodes).map(serializeEditableNode).join("");
}

function selectedSkillNames(editor: HTMLElement): string[] {
  return Array.from(editor.querySelectorAll<HTMLElement>(`[${skillTokenAttribute}]`))
    .map((node) => node.getAttribute(skillTokenAttribute)?.slice(1) ?? "")
    .filter(Boolean)
    .filter((name, index, names) => names.indexOf(name) === index);
}

function renderEditableContent(editor: HTMLElement, value: string, skills: string[]) {
  editor.replaceChildren();
  const skillSet = new Set(skills);
  const tokenPattern = /\/[a-zA-Z0-9_-]+/g;
  let cursor = 0;
  for (const match of value.matchAll(tokenPattern)) {
    const token = match[0];
    const name = token.slice(1);
    if (!skillSet.has(name)) continue;
    const start = match.index ?? cursor;
    if (start > cursor) {
      editor.append(document.createTextNode(value.slice(cursor, start)));
    }
    const badge = document.createElement("span");
    badge.setAttribute(skillTokenAttribute, token);
    badge.setAttribute("contenteditable", "false");
    badge.className = `mx-0.5 inline-flex select-none items-center rounded-md border px-1.5 py-0.5 align-baseline text-xs font-medium leading-4 ${referenceBadgeClass("skill", name)}`;
    badge.setAttribute("aria-label", `技能引用 ${name}`);
    badge.textContent = name;
    editor.append(badge);
    cursor = start + token.length;
  }
  if (cursor < value.length) editor.append(document.createTextNode(value.slice(cursor)));
}

function focusEditableEnd(editor: HTMLElement) {
  editor.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function removeTrailingCommandToken(value: string, token: "/" | "@") {
  return value.replace(new RegExp(`\\${token}[a-zA-Z0-9_.-]*$`), "");
}

function removeSkillTokens(value: string, skills: string[]) {
  let result = value;
  for (const skill of skills) {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`\\/${escaped}`, "g"), "");
  }
  return result.replace(/[ \t]{2,}/g, " ").trim();
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
  const attachments = usePromptInputAttachments();
  const { user } = useWorkbench();
  const editorRef = React.useRef<HTMLDivElement>(null);
  const [isComposing, setIsComposing] = React.useState(false);
  const [skills, setSkills] = React.useState<SkillOption[]>([]);
  const [files, setFiles] = React.useState<FileReferenceOption[]>([]);
  const [query, setQuery] = React.useState("");
  const [command, setCommand] = React.useState<"skill" | "file" | null>(null);

  React.useEffect(() => {
    void Promise.all([fetchChatSkills<SkillOption>(), fetchChatLibraryAssets(user.id)])
      .then(([nextSkills, nextFiles]) => {
        setSkills(nextSkills);
        setFiles(nextFiles);
      })
      .catch(() => undefined);
  }, [user.id]);

  React.useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (serializeEditable(editor) !== controller.textInput.value) {
      renderEditableContent(editor, controller.textInput.value, selectedSkills);
    }
  }, [controller.textInput.value, selectedSkills]);

  const handleTextChange = (event: React.FormEvent<HTMLDivElement>) => {
    const value = serializeEditable(event.currentTarget);
    const nextSkills = selectedSkillNames(event.currentTarget);
    controller.textInput.setInput(value);
    if (nextSkills.join("\u0000") !== selectedSkills.join("\u0000")) {
      onChangeSkills(nextSkills);
    }
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

  const removeCommandToken = (token: "/" | "@") =>
    removeTrailingCommandToken(controller.textInput.value, token);

  const selectSkill = (skill: SkillOption) => {
    const prefix = removeCommandToken("/");
    const nextSkills = selectedSkills.includes(skill.name)
      ? selectedSkills
      : [...selectedSkills, skill.name];
    const nextValue = `${prefix}${prefix && !/\s$/.test(prefix) ? " " : ""}/${skill.name} `;
    controller.textInput.setInput(nextValue);
    onChangeSkills(nextSkills);
    if (editorRef.current) {
      renderEditableContent(editorRef.current, nextValue, nextSkills);
      focusEditableEnd(editorRef.current);
    }
    setCommand(null);
    setQuery("");
  };

  const selectFile = (file: FileReferenceOption) => {
    const nextValue = removeCommandToken("@");
    controller.textInput.setInput(nextValue);
    if (editorRef.current) {
      renderEditableContent(editorRef.current, nextValue, selectedSkills);
      focusEditableEnd(editorRef.current);
    }
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

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Backspace" && serializeEditable(event.currentTarget) === "") {
      const lastAttachment = attachments.files.at(-1);
      if (lastAttachment) {
        event.preventDefault();
        attachments.remove(lastAttachment.id);
        return;
      }
    }
    if (event.key !== "Enter" || isComposing || event.nativeEvent.isComposing || event.shiftKey) {
      return;
    }
    event.preventDefault();
    const form = event.currentTarget.closest("form") as HTMLFormElement | null;
    const submitButton = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!submitButton?.disabled) form?.requestSubmit();
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (files.length === 0) return;
    event.preventDefault();
    attachments.add(files);
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: The inline contenteditable editor needs textbox semantics. */}
      <div
        aria-label="消息输入"
        aria-multiline="true"
        className="field-sizing-content max-h-48 min-h-16 w-full min-w-0 flex-1 resize-none overflow-y-auto whitespace-pre-wrap break-words rounded-none bg-transparent px-3 py-2 text-sm leading-6 outline-none before:pointer-events-none before:text-muted-foreground empty:before:content-[attr(data-placeholder)]"
        contentEditable
        data-placeholder={placeholder}
        data-slot="input-group-control"
        onCompositionEnd={() => setIsComposing(false)}
        onCompositionStart={() => setIsComposing(true)}
        onInput={handleTextChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        ref={editorRef}
        tabIndex={0}
        role="textbox"
        suppressContentEditableWarning
      />
      {command ? (
        <div className="absolute bottom-full left-2 z-30 mb-2 w-[min(24rem,calc(100%-1rem))] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg">
          <Command shouldFilter={false}>
            <CommandList className="max-h-64">
              {command === "skill" ? (
                visibleSkills.length === 0 ? (
                  <CommandEmpty>暂无匹配的技能</CommandEmpty>
                ) : (
                  <CommandGroup heading="技能与指令">
                    {visibleSkills.map((skill) => (
                      <CommandItem
                        key={skill.name}
                        onSelect={() => selectSkill(skill)}
                        value={skill.name}
                      >
                        <SparklesIcon className="size-4 shrink-0 text-primary" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">/{skill.name}</span>
                          <span className="block whitespace-normal break-words text-xs text-muted-foreground">
                            {skill.description}
                          </span>
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )
              ) : visibleFiles.length === 0 ? (
                <CommandEmpty>暂无匹配的资料</CommandEmpty>
              ) : (
                <CommandGroup heading="对话文件">
                  {visibleFiles.map((file) => (
                    <CommandItem
                      key={file.id}
                      onSelect={() => selectFile(file)}
                      value={file.filename}
                    >
                      <FileIcon className="size-4 shrink-0 text-primary" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">@{file.filename}</span>
                        <span className="block whitespace-normal break-words text-xs text-muted-foreground">
                          {file.mediaType || "文件"}
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {(command === "skill" ? visibleSkills.length : visibleFiles.length) > 0 ? (
                <CommandSeparator />
              ) : null}
            </CommandList>
          </Command>
        </div>
      ) : null}
    </>
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
    <div className="flex w-full min-w-0 flex-wrap gap-1.5 px-2 pt-2 pb-1">
      {files.map((file) => (
        <Badge
          className={`max-w-full gap-1 ${referenceBadgeClass("file", `${file.id}:${file.url}`)}`}
          key={file.url}
          variant="outline"
        >
          <FileIcon className="size-3 shrink-0" />
          <span className="max-w-52 truncate">{file.filename}</span>
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
    </div>
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
            {request.text ||
              (request.skills?.length ? `技能引用: ${request.skills.join(", ")}` : "附件请求")}
          </QueueItemContent>
          {request.files.length > 0 ? (
            <QueueItemDescription>{request.files.length} 个附件</QueueItemDescription>
          ) : null}
        </div>
        <QueueItemActions className="shrink-0">
          {/* 立即转向排在编辑左侧:它是这条请求的主动作(打断当前回合、越过
              队列顺序直接发出),编辑/移除是它的辅助动作。native follow-up
              (已被服务端会话接受并排入 follow-up 队列)不能改文本也不能单独
              撤回,但可以被转向——steer 会 abort 当前 run 并作废服务端整个
              follow-up 队列 */}
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
  const {
    pendingLibraryFiles,
    clearPendingLibraryFiles,
    pendingPrompt,
    setPendingPrompt,
    reportPromptMinWidth,
  } = useWorkbench();
  /**
   * 实测输入区的最小边界并上报,由 AppShell 用来限制面板拖拽幅度与窗口最小宽度。
   *
   * 量的是「左组自然宽 + 右组自然宽 + footer 自身的左右内距与列间距」—— 也就是
   * 两组控件都完整显示、中间弹性空白刚好为 0 时的宽度。这个数只有内容自己知道
   * (控件增删、标签改名、换更长的模型名都会变),所以必须实测,不能写成常量。
   *
   * 要紧的是这个数必须只反映**内容**、绝不反映**当前容器有多宽**:一旦压缩值能
   * 被报上去,下限就会随容器一起缩,约束越放越松,挤压于是被固化而不是被纠正。
   */
  const footerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const footer = footerRef.current;
    const left = footer?.firstElementChild;
    const right = footer?.lastElementChild;
    if (!footer || !(left instanceof HTMLElement) || !(right instanceof HTMLElement)) return;
    if (left === right) return;
    /**
     * 读一组在「不被 flex 压缩」时的宽度。
     *
     * 两组都带 min-w-0,容器一紧就是它们先让步,所以直接量 offsetWidth 量到的是
     * 压缩后的值 —— 正是上面那条不变量禁止上报的东西。这里临时用 max-content
     * 顶开压缩再读:写-读-还原在同一个同步块内,浏览器只多算一次布局、不会绘制
     * 中间态;回调结束时尺寸已复原,也不会引起 ResizeObserver 自激。内部 label 的
     * max-w 上限依然生效,量到的正是「标签完整显示」时的宽度,而不是无限伸展。
     */
    const naturalWidth = (element: HTMLElement) => {
      const previous = element.style.minWidth;
      element.style.minWidth = "max-content";
      const width = element.offsetWidth;
      element.style.minWidth = previous;
      return width;
    };
    const measure = () => {
      const styles = getComputedStyle(footer);
      // 列间距和内距一样是 footer 自己吃掉的固定宽度,少算它下限就偏小。
      // 未设置 gap 时 computed 值是 "normal",parseFloat 得 NaN —— 归零。
      const gap = Number.parseFloat(styles.columnGap);
      const fixed =
        Number.parseFloat(styles.paddingLeft) +
        Number.parseFloat(styles.paddingRight) +
        (Number.isFinite(gap) ? gap : 0);
      /**
       * 无条件顶开测量,不再先看中间还剩多少空白。
       *
       * 「有空白就说明没被压缩,可以直接量」只在 footer 的 gap 为 0 时成立:
       * 一旦两组之间有固定 gap,压缩态下剩的那段空白恰好等于 gap 而不是 0,
       * 判断于是永远走「直接量」—— 压缩值被报上去,下限随容器一起缩。
       * 那次判断省下的是一次固有尺寸计算(浏览器本身有缓存),换来的却是
       * 整条不变量失效,不值得。
       */
      reportPromptMinWidth(naturalWidth(left) + naturalWidth(right) + fixed);
    };
    measure();
    // 同时观察两组自身:换模型、开关检索都会改变它们的宽度,而 footer 尺寸未必变
    const observer = new ResizeObserver(measure);
    observer.observe(footer);
    observer.observe(left);
    observer.observe(right);
    return () => observer.disconnect();
  }, [reportPromptMinWidth]);
  const [selectedSkills, setSelectedSkills] = React.useState<string[]>([]);
  const [selectedFileReferences, setSelectedFileReferences] = React.useState<
    MessageFileReference[]
  >([]);
  React.useEffect(() => {
    if (!pendingPrompt || !controller.ready) return;
    controller.textInput.setInput(pendingPrompt);
    setPendingPrompt(null);
  }, [controller.ready, controller.textInput, pendingPrompt, setPendingPrompt]);
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
            {
              ...message,
              text: removeSkillTokens(message.text, selectedSkills),
              skills: selectedSkills,
              fileReferences: selectedFileReferences,
            },
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
        <PromptInputBody>
          <SelectedFileReferenceBadges
            files={selectedFileReferences}
            onRemove={(file) => {
              const attachment = controller.attachments.files.find((item) => item.url === file.url);
              if (attachment) controller.attachments.remove(attachment.id);
              setSelectedFileReferences((current) =>
                current.filter((item) => item.url !== file.url),
              );
            }}
          />
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
        {/* 会被消费的只有中间那段弹性空白(右组 ml-auto 提供);Footer 的 gap 与内距
            是固定占用,已一并计入下面实测的最小边界。两组都完整显示、弹性空白刚好
            为 0 时的宽度就是输入区真正的最小边界,由上面的 ResizeObserver 实测上报,
            AppShell 用它去限制面板能拖多宽、以及窗口能缩多窄 —— 所以正常情况下根本
            走不到「空白见底」这一步,两组控件既不换行也不溢出,更不需要滚动条,
            而这个边界没有任何魔数。
            万一约束还没到位(首帧、内容刚变长),两组的 min-w-0 会让模式/模型的标签
            先截短兜底,而不是把发送按钮顶到容器外面去。 */}
        <PromptInputFooter
          className="flex-nowrap border-t border-border/40 px-2.5 pt-2 pb-2"
          ref={footerRef}
        >
          <PromptInputActions />
          <div className="ml-auto flex min-w-0 items-center gap-1">
            {/* 「0% + 进度环」没有可截断的文字,压窄只会变形 */}
            <div className="shrink-0">
              <ChatContextUsage
                usage={usage}
                estimatedUsedTokens={estimatedUsedTokens}
                compacting={compacting}
                onCompress={onCompress}
                compressResult={compressResult}
                onCompressResultClose={onCompressResultClose}
              />
            </div>
            <ChatModeSelector />
            <ChatModelSelector />
            <PromptInputSubmit className="shrink-0" onStop={() => void onStop()} status={status} />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </PromptInputGlow>
  );
}
