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
import { useQuery } from "@tanstack/react-query";
import type { FileUIPart, LanguageModelUsage } from "ai";
import {
  FileIcon,
  GripVerticalIcon,
  ListTodoIcon,
  PencilIcon,
  SparklesIcon,
  Trash2Icon,
  WaypointsIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useWorkbenchStore } from "@/entities/workbench/model/workbench-store";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/shared/ui/ai-elements/attachments";
import {
  PromptInput,
  PromptInputBody,
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandInput,
  PromptInputCommandItem,
  PromptInputCommandList,
  type PromptInputFileDescriptor,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputHoverCard,
  PromptInputHoverCardContent,
  PromptInputHoverCardTrigger,
  PromptInputSubmit,
  PromptInputTabsList,
  PromptInputTextarea,
  usePromptInputAttachments,
  usePromptInputController,
  usePromptInputReferencedSources,
} from "@/shared/ui/ai-elements/prompt-input";
import {
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemAttachment,
  QueueItemContent,
  QueueItemDescription,
  QueueItemFile,
  QueueItemImage,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/shared/ui/ai-elements/queue";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ScrollArea, ScrollBar } from "@/shared/ui/scroll-area";
import { fetchChatAssetBlob, fetchChatLibraryAssets, fetchChatSkills } from "../api/chat-api";
import { type MessageFileReference, type QueuedRequest, referenceBadgeClass } from "../model/types";
import { ComposerMenu } from "./composer-menu";
import { ChatContextUsage } from "./context-usage";
import { ChatModelSelector } from "./model-selector";
import { PromptInputGlow } from "./prompt-input-glow";

function PromptInputAttachments() {
  const { t } = useTranslation();
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
              <AttachmentRemove
                label={t("chat:prompt.removeAttachment", {
                  filename: file.filename ?? t("chat:file"),
                })}
              />
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

function removeTrailingCommandToken(value: string, token: "/" | "@") {
  return token === "/" ? value.replace(/\/[a-zA-Z0-9_-]*$/, "") : value.replace(/@[^\s@]*$/, "");
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
  const { t } = useTranslation();
  const controller = usePromptInputController();
  const referencedSources = usePromptInputReferencedSources();
  const { user } = useAuth();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const userId = user?.id ?? "anonymous";
  const skills =
    useQuery({
      queryKey: ["composer-skills", userId],
      queryFn: () => fetchChatSkills<SkillOption>(),
    }).data ?? [];
  const files =
    useQuery({
      queryKey: ["composer-library", userId],
      queryFn: () => fetchChatLibraryAssets(userId),
    }).data ?? [];
  const queueFiles = useWorkbenchStore((state) => state.queueLibraryFiles);
  const [query, setQuery] = React.useState("");
  const [command, setCommand] = React.useState<"skill" | "file" | null>(null);
  const deferredQuery = React.useDeferredValue(query.toLocaleLowerCase());

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
    return (
      !deferredQuery ||
      skill.name.toLocaleLowerCase().includes(deferredQuery) ||
      skill.description.toLocaleLowerCase().includes(deferredQuery)
    );
  });

  const visibleFiles = files.filter((file) => {
    return !deferredQuery || file.filename.toLocaleLowerCase().includes(deferredQuery);
  });

  const removeCommandToken = (token: "/" | "@") =>
    removeTrailingCommandToken(controller.textInput.value, token);

  const switchCommand = (nextCommand: "skill" | "file") => {
    const prefix = removeCommandToken(command === "skill" ? "/" : "@").trimEnd();
    const token = nextCommand === "skill" ? "/" : "@";
    controller.textInput.setInput(prefix ? `${prefix} ${token}` : token);
    setCommand(nextCommand);
    setQuery("");
  };

  const selectSkill = (skill: SkillOption) => {
    if (!selectedSkills.includes(skill.name) && selectedSkills.length >= 4) {
      toast.error(t("chat:composer.skillLimit"));
      return;
    }
    const prefix = removeCommandToken("/").trimEnd();
    const nextSkills = selectedSkills.includes(skill.name)
      ? selectedSkills
      : [...selectedSkills, skill.name];
    controller.textInput.setInput(prefix ? `${prefix} ` : "");
    onChangeSkills(nextSkills);
    setCommand(null);
    setQuery("");
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const selectFile = (file: FileReferenceOption) => {
    const nextValue = removeCommandToken("@").trimEnd();
    controller.textInput.setInput(nextValue ? `${nextValue} ` : "");
    if (!selectedFileReferences.some((item) => item.url === file.url)) {
      queueFiles([{ type: "file", ...file }]);
      onChangeFileReferences([...selectedFileReferences, file]);
      referencedSources.add({
        type: "source-document",
        sourceId: file.id,
        mediaType: file.mediaType,
        title: file.filename,
        filename: file.filename,
      });
    }
    setCommand(null);
    setQuery("");
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return (
    <>
      {selectedSkills.length > 0 ? (
        <div className="flex w-full min-w-0 flex-wrap gap-1.5 px-2 pt-2 pb-1">
          {selectedSkills.map((name) => {
            const skill = skills.find((item) => item.name === name);
            return (
              <PromptInputHoverCard key={name}>
                <PromptInputHoverCardTrigger
                  render={
                    <Badge
                      className={`max-w-full gap-1 ${referenceBadgeClass("skill", name)}`}
                      variant="outline"
                    />
                  }
                >
                  <SparklesIcon className="size-3 shrink-0" />
                  <span className="max-w-52 truncate">{name}</span>
                  <button
                    aria-label={t("chat:prompt.removeSkill", { name })}
                    className="rounded-sm hover:bg-primary/15"
                    onClick={() => onChangeSkills(selectedSkills.filter((item) => item !== name))}
                    type="button"
                  >
                    <XIcon className="size-3" />
                  </button>
                </PromptInputHoverCardTrigger>
                <PromptInputHoverCardContent className="space-y-1">
                  <p className="font-medium">/{name}</p>
                  <p className="text-xs text-muted-foreground">
                    {skill?.description || t("chat:prompt.noSkillDescription")}
                  </p>
                </PromptInputHoverCardContent>
              </PromptInputHoverCard>
            );
          })}
        </div>
      ) : null}
      <PromptInputTextarea
        aria-label={t("chat:inputAriaLabel")}
        className="w-full min-w-0 leading-6"
        onChange={handleTextChange}
        onKeyDown={(event) => {
          if (!command || event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            setCommand(null);
            setQuery("");
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            const first = command === "skill" ? visibleSkills[0] : visibleFiles[0];
            if (!first) return;
            event.preventDefault();
            if (command === "skill") selectSkill(first as SkillOption);
            else selectFile(first as FileReferenceOption);
          }
        }}
        placeholder={placeholder}
        ref={textareaRef}
      />
      {command ? (
        <div className="absolute bottom-full left-2 z-30 mb-2 w-[min(24rem,calc(100%-1rem))] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg">
          <PromptInputTabsList className="grid grid-cols-2 border-b bg-muted/30 p-1">
            <Button
              aria-pressed={command === "skill"}
              className="h-7 text-xs"
              onClick={() => switchCommand("skill")}
              size="sm"
              type="button"
              variant={command === "skill" ? "secondary" : "ghost"}
            >
              / {t("chat:skillsAndCommands")}
            </Button>
            <Button
              aria-pressed={command === "file"}
              className="h-7 text-xs"
              onClick={() => switchCommand("file")}
              size="sm"
              type="button"
              variant={command === "file" ? "secondary" : "ghost"}
            >
              @ {t("chat:conversationFiles")}
            </Button>
          </PromptInputTabsList>
          <PromptInputCommand shouldFilter={false}>
            <PromptInputCommandInput
              autoFocus
              onValueChange={setQuery}
              placeholder={
                command === "skill" ? t("chat:prompt.searchSkills") : t("chat:prompt.searchFiles")
              }
              value={query}
            />
            <PromptInputCommandList className="max-h-64">
              {command === "skill" ? (
                visibleSkills.length === 0 ? (
                  <PromptInputCommandEmpty>{t("chat:noMatchingSkills")}</PromptInputCommandEmpty>
                ) : (
                  <PromptInputCommandGroup heading={t("chat:skillsAndCommands")}>
                    {visibleSkills.map((skill) => (
                      <PromptInputCommandItem
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
                      </PromptInputCommandItem>
                    ))}
                  </PromptInputCommandGroup>
                )
              ) : visibleFiles.length === 0 ? (
                <PromptInputCommandEmpty>{t("chat:noMatchingFiles")}</PromptInputCommandEmpty>
              ) : (
                <PromptInputCommandGroup heading={t("chat:conversationFiles")}>
                  {visibleFiles.map((file) => (
                    <PromptInputCommandItem
                      key={file.id}
                      onSelect={() => selectFile(file)}
                      value={file.filename}
                    >
                      <FileIcon className="size-4 shrink-0 text-primary" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">@{file.filename}</span>
                        <span className="block whitespace-normal break-words text-xs text-muted-foreground">
                          {file.mediaType || t("chat:file")}
                        </span>
                      </span>
                    </PromptInputCommandItem>
                  ))}
                </PromptInputCommandGroup>
              )}
            </PromptInputCommandList>
          </PromptInputCommand>
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
  const { t } = useTranslation();
  const referencedSources = usePromptInputReferencedSources();
  if (files.length === 0) return null;
  return (
    <div className="flex w-full min-w-0 flex-wrap gap-1.5 px-2 pt-2 pb-1">
      {files.map((file) => (
        <PromptInputHoverCard key={file.url}>
          <PromptInputHoverCardTrigger
            render={
              <Badge
                className={`max-w-full gap-1 ${referenceBadgeClass("file", `${file.id}:${file.url}`)}`}
                variant="outline"
              />
            }
          >
            <FileIcon className="size-3 shrink-0" />
            <span className="max-w-52 truncate">{file.filename}</span>
            <button
              aria-label={t("chat:removeFileRef", { name: file.filename })}
              className="rounded-sm hover:bg-primary/15"
              onClick={(event) => {
                event.stopPropagation();
                const source = referencedSources.sources.find((item) => item.sourceId === file.id);
                if (source) referencedSources.remove(source.id);
                onRemove(file);
              }}
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          </PromptInputHoverCardTrigger>
          <PromptInputHoverCardContent className="min-w-0 space-y-1">
            <p className="truncate font-medium" title={file.filename}>
              {file.filename}
            </p>
            <p className="text-xs text-muted-foreground">{file.mediaType || t("chat:file")}</p>
            <p className="line-clamp-2 break-all text-xs text-muted-foreground">{file.url}</p>
          </PromptInputHoverCardContent>
        </PromptInputHoverCard>
      ))}
    </div>
  );
}

function QueuedFilePreview({ file }: { file: QueuedRequest["files"][number] }) {
  const { t } = useTranslation();
  const title = file.filename ?? t("chat:file");
  const isImage = file.mediaType?.startsWith("image/") ?? false;
  const [imageUrl, setImageUrl] = React.useState<string>();

  React.useEffect(() => {
    if (!isImage) return;
    let disposed = false;
    let objectUrl: string | undefined;
    void fetchChatAssetBlob(file.url)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (disposed) URL.revokeObjectURL(objectUrl);
        else setImageUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.url, isImage]);

  return imageUrl ? (
    <QueueItemImage alt={title} src={imageUrl} title={title} />
  ) : (
    <QueueItemFile title={title}>{title}</QueueItemFile>
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
  const { t } = useTranslation();
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
        <Button
          aria-label={t("chat:dragToReorder")}
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
        <div className="min-w-0 flex-1">
          <QueueItemContent className="line-clamp-2 whitespace-pre-wrap">
            {request.text ||
              (request.skills?.length
                ? t("chat:prompt.skillRef", { skills: request.skills.join(", ") })
                : t("chat:prompt.attachmentRequest"))}
          </QueueItemContent>
          {request.files.length > 0 ? (
            <QueueItemDescription>
              {t("chat:prompt.filesCount", { count: request.files.length })}
            </QueueItemDescription>
          ) : null}
        </div>
        <QueueItemActions className="shrink-0">
          {onSteerNow ? (
            <QueueItemAction
              aria-label={t("chat:prompt.steerNow")}
              className="opacity-100"
              onClick={() => onSteerNow(request)}
              title={t("chat:prompt.steerNowTitle")}
            >
              <WaypointsIcon />
            </QueueItemAction>
          ) : null}
          <QueueItemAction
            aria-label={t("chat:prompt.editQueued")}
            className="opacity-100"
            onClick={() => onEdit(request)}
          >
            <PencilIcon />
          </QueueItemAction>
          <QueueItemAction
            aria-label={t("chat:prompt.removeQueued")}
            className="opacity-100"
            onClick={() => onRemove(request.id)}
          >
            <Trash2Icon />
          </QueueItemAction>
        </QueueItemActions>
      </div>
      {request.files.length > 0 ? (
        <QueueItemAttachment className="ml-8">
          {request.files.map((file) => (
            <QueuedFilePreview
              file={file}
              key={`${file.url}:${file.filename ?? file.mediaType ?? "file"}`}
            />
          ))}
        </QueueItemAttachment>
      ) : null}
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
  const { t } = useTranslation();
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
    <QueueSection defaultOpen>
      <QueueSectionTrigger className="px-2 py-1">
        <QueueSectionLabel
          count={requests.length}
          label={t("chat:prompt.queuedRequests")}
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
  billingUsage,
  onSubmit,
  status,
  onStop,
  attachmentTokenBudget,
  attachmentCapabilities,
  goalAvailable,
}: {
  activeThread: boolean;
  goalAvailable: boolean;
  usage: LanguageModelUsage | undefined;
  billingUsage?: LanguageModelUsage;
  onSubmit: (
    message: {
      text: string;
      files?: Array<FileUIPart & { byteSize?: number; file?: File }>;
      skills?: string[];
      goal?: boolean;
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
  /** 当前模型在预留输出空间后可用于附件的 token 预算。 */
  attachmentTokenBudget?: number;
  attachmentCapabilities?: { vision: boolean; audio: boolean };
}) {
  const { t } = useTranslation();
  const controller = usePromptInputController();
  const pendingLibraryFiles = useWorkbenchStore((state) => state.pendingLibraryFiles);
  const clearPendingLibraryFiles = useWorkbenchStore((state) => state.clearPendingLibraryFiles);
  const pendingPrompt = useWorkbenchStore((state) => state.pendingPrompt);
  const setPendingPrompt = useWorkbenchStore((state) => state.setPendingPrompt);
  const reportPromptMinWidth = useWorkbenchStore((state) => state.reportPromptMinWidth);
  // 工具组可以换行；面板最小宽度取较宽一组的自然宽度与内距。
  const footerRef = React.useRef<HTMLDivElement>(null);
  const lastReportedPromptWidthRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    const footer = footerRef.current;
    const left = footer?.firstElementChild;
    const right = footer?.lastElementChild;
    if (!footer || !(left instanceof HTMLElement) || !(right instanceof HTMLElement)) return;
    if (left === right) return;
    // 测量脱离布局流的克隆，避免修改观察节点导致 ResizeObserver 反馈循环。
    const naturalWidth = (element: HTMLElement) => {
      const clone = element.cloneNode(true) as HTMLElement;
      Object.assign(clone.style, {
        position: "absolute",
        left: "-100000px",
        top: "0",
        visibility: "hidden",
        pointerEvents: "none",
        width: "max-content",
        minWidth: "max-content",
        maxWidth: "none",
        flex: "none",
      });
      footer.appendChild(clone);
      const width = clone.getBoundingClientRect().width;
      clone.remove();
      return width;
    };
    let frame: number | null = null;
    const measure = () => {
      const styles = getComputedStyle(footer);
      const fixed = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
      const width = Math.max(naturalWidth(left), naturalWidth(right)) + fixed;
      if (lastReportedPromptWidthRef.current === Math.ceil(width)) return;
      lastReportedPromptWidthRef.current = Math.ceil(width);
      reportPromptMinWidth(width);
    };
    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    scheduleMeasure();
    // 同时观察两组自身:换模型、开关检索都会改变它们的宽度,而 footer 尺寸未必变
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(footer);
    observer.observe(left);
    observer.observe(right);
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [reportPromptMinWidth]);
  const [goalMode, setGoalMode] = React.useState(false);
  React.useEffect(() => {
    if (!goalAvailable) setGoalMode(false);
  }, [goalAvailable]);
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
          name: file.filename ?? t("chat:messages.untitledAttachment"),
          size: file.byteSize ?? 0,
          type: file.mediaType ?? "",
          lastModified: 0,
        }),
      0,
    );
    let byteTotal = currentFiles.reduce((sum, file) => sum + (file.byteSize ?? 0), 0);
    const capacity = Math.max(0, 10 - currentFiles.length);
    let acceptedCount = 0;
    const accepted = pendingLibraryFiles.filter((file) => {
      if (acceptedCount >= capacity || currentFiles.some((item) => item.url === file.url))
        return false;
      const bytes = file.byteSize ?? 0;
      if (bytes > 50 * 1024 * 1024 || byteTotal + bytes > 100 * 1024 * 1024) return false;
      if (file.mediaType.startsWith("image/") && !attachmentCapabilities?.vision) return false;
      if (file.mediaType.startsWith("audio/") && !attachmentCapabilities?.audio) return false;
      const fileTokens = estimateAttachmentTokens({
        name: file.filename ?? t("chat:messages.untitledAttachment"),
        size: file.byteSize ?? 0,
        type: file.mediaType ?? "",
        lastModified: 0,
      });
      if (tokenTotal + fileTokens > (attachmentTokenBudget ?? Number.POSITIVE_INFINITY))
        return false;
      tokenTotal += fileTokens;
      byteTotal += bytes;
      acceptedCount += 1;
      return true;
    });
    if (accepted.length > 0) controller.attachments.restore(accepted);
    if (accepted.length < pendingLibraryFiles.length) {
      toast.error(t("chat:prompt.partialFilesAdded"));
    }
    clearPendingLibraryFiles();
  }, [
    attachmentTokenBudget,
    attachmentCapabilities?.vision,
    attachmentCapabilities?.audio,
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
    ".htm",
    ".pdf",
    ".docx",
    ".xlsx",
    ".xls",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".css",
    ".scss",
    ".less",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".sql",
    ".sh",
    ".ps1",
    ".log",
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
              text: message.text,
              skills: selectedSkills,
              goal: goalMode,
              fileReferences: selectedFileReferences
                .filter((reference) => message.files?.some((file) => file.url === reference.url))
                .map(({ id, filename, url }) => ({ id, filename, url })),
            },
            () => {
              controller.textInput.clear();
              controller.attachments.clear();
              setSelectedSkills([]);
              setGoalMode(false);
              setSelectedFileReferences([]);
            },
          )
        }
      >
        <PromptInputAttachments />
        <PromptInputBody>
          <SelectedFileReferenceBadges
            files={selectedFileReferences.filter((reference) =>
              controller.attachments.files.some((file) => file.url === reference.url),
            )}
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
            placeholder={activeThread ? t("chat:continuePrompt") : t("chat:welcomePrompt")}
            selectedFileReferences={selectedFileReferences}
            selectedSkills={selectedSkills}
          />
        </PromptInputBody>
        {/* 两组控件各自保持完整，窄面板时换行；模式与功能标签紧跟 +。 */}
        <PromptInputFooter
          className="flex-wrap gap-2 border-t border-border/40 px-2.5 pt-2 pb-2"
          ref={footerRef}
        >
          <ComposerMenu
            screenshotEnabled={attachmentCapabilities?.vision === true}
            skills={selectedSkills}
            onSkillsChange={setSelectedSkills}
            onFileReference={(file) =>
              setSelectedFileReferences((current) =>
                current.some((item) => item.url === file.url) ? current : [...current, file],
              )
            }
            goal={goalMode}
            onGoalChange={setGoalMode}
            goalAvailable={goalAvailable}
            busy={status === "submitted" || status === "streaming"}
          />
          <div className="ml-auto flex min-w-0 items-center gap-1">
            {/* 「0% + 进度环」没有可截断的文字,压窄只会变形 */}
            <div className="shrink-0">
              <ChatContextUsage usage={usage} billingUsage={billingUsage} />
            </div>
            <ChatModelSelector />
            <PromptInputSubmit className="shrink-0" onStop={() => void onStop()} status={status} />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </PromptInputGlow>
  );
}
