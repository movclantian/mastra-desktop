import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai";
import {
  CheckIcon,
  GlobeIcon,
  MessageCircleDashedIcon,
  PaperclipIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  buildModelRouterObject,
  buildReasoningProviderOptions,
  getModelCapabilities,
  MASTRA_SERVER_URL,
  PROVIDER_PRESETS,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "@/lib/providers";
import { useWorkbench } from "@/lib/workbench";

// ---------------------------------------------------------------------------
// 消息渲染:ai-elements Message + Streamdown markdown
// ---------------------------------------------------------------------------

function MessageItem({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  return (
    <MessageScrollerItem scrollAnchor={isUser}>
      <Message from={message.role === "assistant" ? "assistant" : "user"}>
        <MessageContent>
          {message.parts.map((part, index) => {
            if (part.type !== "text") {
              return null;
            }
            const partKey = `${message.id}-${index}`;
            return isUser ? (
              <p key={partKey} className="whitespace-pre-wrap text-sm">
                {part.text}
              </p>
            ) : (
              <MessageResponse key={partKey}>{part.text}</MessageResponse>
            );
          })}
        </MessageContent>
      </Message>
    </MessageScrollerItem>
  );
}

// ---------------------------------------------------------------------------
// 模型选择器(含搜索、自定义模型、能力徽章、思考等级)
// ---------------------------------------------------------------------------

function ChatModelSelector() {
  const { providers, catalog, modelSelection, setModelSelection, setProviders, setSettingsOpen } =
    useWorkbench();
  const [open, setOpen] = React.useState(false);

  const selectedProvider = providers.find((p) => p.id === modelSelection?.providerId);
  const selectedCapabilities =
    selectedProvider && modelSelection
      ? getModelCapabilities(selectedProvider.type, modelSelection.modelId, catalog)
      : null;
  const effortOptions = selectedProvider ? (REASONING_EFFORTS[selectedProvider.type] ?? []) : [];
  const supportsReasoning = Boolean(selectedCapabilities?.reasoning) && effortOptions.length > 0;

  const handleSelect = (providerId: string, modelId: string, modelName: string) => {
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return;
    const caps = getModelCapabilities(provider.type, modelId, catalog);
    const defaultEffort = caps.reasoning
      ? ((REASONING_EFFORTS[provider.type] ?? [])[0] ?? "low")
      : "off";
    setModelSelection({ providerId, modelId, modelName, reasoningEffort: defaultEffort });
    setOpen(false);
  };

  const handleAddCustomModel = (query: string) => {
    const provider = providers[0];
    if (!provider) {
      toast.error("请先在设置中添加模型供应商");
      return;
    }
    const exists = provider.enabledModels.some((m) => m.id === query);
    if (!exists) {
      setProviders(
        providers.map((p) =>
          p.id === provider.id
            ? {
                ...p,
                enabledModels: [...p.enabledModels, { id: query, name: query }],
              }
            : p,
        ),
      );
      toast.success(`自定义模型 ${query} 已添加到 ${provider.name}`);
    }
    handleSelect(provider.id, query, query);
  };

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger render={<PromptInputButton aria-label="选择模型" />}>
        {selectedProvider && modelSelection ? (
          <>
            <ModelSelectorLogo
              provider={
                PROVIDER_PRESETS.find((p) => p.type === selectedProvider.type)?.providerId ??
                "custom"
              }
            />
            <ModelSelectorName>{modelSelection.modelName}</ModelSelectorName>
          </>
        ) : (
          <>
            <SearchIcon />
            <span>选择模型</span>
          </>
        )}
      </ModelSelectorTrigger>
      <ModelSelectorContent title="模型选择器" className="sm:max-w-md">
        <ModelSelectorInput placeholder="搜索模型..." />
        <ModelSelectorList>
          <ModelSelectorEmpty>
            {providers.length === 0
              ? "暂无供应商,请在设置中添加。"
              : "未找到模型,尝试添加自定义模型 ID。"}
          </ModelSelectorEmpty>
          {providers
            .filter((p) => p.enabledModels.length > 0)
            .map((provider) => (
              <ModelSelectorGroup heading={provider.name} key={provider.id}>
                {provider.enabledModels.map((model) => {
                  const caps = getModelCapabilities(provider.type, model.id, catalog);
                  const selected =
                    modelSelection?.providerId === provider.id &&
                    modelSelection?.modelId === model.id;
                  return (
                    <ModelSelectorItem
                      key={model.id}
                      value={`${provider.id}/${model.id}`}
                      onSelect={() => handleSelect(provider.id, model.id, model.name)}
                    >
                      <ModelSelectorLogo
                        provider={
                          PROVIDER_PRESETS.find((p) => p.type === provider.type)?.providerId ??
                          "custom"
                        }
                      />
                      <ModelSelectorName>{model.name}</ModelSelectorName>
                      <div className="flex items-center gap-1">
                        {caps.reasoning ? (
                          <Badge variant="secondary" className="text-[10px]">
                            推理
                          </Badge>
                        ) : null}
                        {caps.vision ? (
                          <Badge variant="secondary" className="text-[10px]">
                            视觉
                          </Badge>
                        ) : null}
                        {caps.audio ? (
                          <Badge variant="secondary" className="text-[10px]">
                            音频
                          </Badge>
                        ) : null}
                      </div>
                      {selected ? (
                        <CheckIcon className="ml-auto size-4" />
                      ) : (
                        <div className="ml-auto size-4" />
                      )}
                    </ModelSelectorItem>
                  );
                })}
              </ModelSelectorGroup>
            ))}
          {providers.length > 0 ? (
            <ModelSelectorGroup heading="自定义" key="custom">
              <ModelSelectorItem
                value="__add_custom__"
                onSelect={() => {
                  const input = document.querySelector<HTMLInputElement>(
                    '[data-slot="command-input"]',
                  );
                  const query = input?.value?.trim();
                  if (query) handleAddCustomModel(query);
                }}
              >
                <PlusIcon />
                <ModelSelectorName>添加自定义模型 ID</ModelSelectorName>
              </ModelSelectorItem>
            </ModelSelectorGroup>
          ) : null}
        </ModelSelectorList>

        {/* 思考等级:仅当所选模型支持 reasoning 时展示(档位按供应商动态调整) */}
        {supportsReasoning && modelSelection ? (
          <div className="flex items-center gap-2 border-t px-3 py-2.5">
            <span className="text-xs text-muted-foreground">思考等级</span>
            <NativeSelect
              className="ml-auto"
              value={
                modelSelection.reasoningEffort === "off" ? "low" : modelSelection.reasoningEffort
              }
              onChange={(e) =>
                setModelSelection({
                  ...modelSelection,
                  reasoningEffort: e.target.value as ReasoningEffort,
                })
              }
            >
              {effortOptions.map((effort) => (
                <NativeSelectOption key={effort} value={effort}>
                  {effort}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}

        {providers.length === 0 ? (
          <div className="border-t p-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                setOpen(false);
                setSettingsOpen(true);
              }}
            >
              去设置添加供应商
            </Button>
          </div>
        ) : null}
      </ModelSelectorContent>
    </ModelSelector>
  );
}

// ---------------------------------------------------------------------------
// 输入区工具按钮(Globe 联网开关 / Paperclip 附件)
// 必须位于 PromptInputProvider 内部以访问附件上下文
// ---------------------------------------------------------------------------

function PromptInputActions({
  webSearchEnabled,
  onToggleWebSearch,
}: {
  webSearchEnabled: boolean;
  onToggleWebSearch: () => void;
}) {
  const attachments = usePromptInputAttachments();

  return (
    <PromptInputTools>
      {/* Globe / Paperclip 按钮位于整个输入区的左侧 */}
      <Tooltip>
        <TooltipTrigger
          render={
            <PromptInputButton
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="切换联网搜索"
              onClick={onToggleWebSearch}
            />
          }
        >
          <GlobeIcon className={webSearchEnabled ? "text-primary" : "text-muted-foreground"} />
        </TooltipTrigger>
        <TooltipContent>
          <p>{webSearchEnabled ? "关闭联网搜索" : "开启联网搜索"}</p>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <PromptInputButton
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="添加附件"
              onClick={() => document.getElementById("chat-file-input")?.click()}
            />
          }
        >
          <PaperclipIcon className="text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent>
          <p>添加附件</p>
        </TooltipContent>
      </Tooltip>
      <input
        id="chat-file-input"
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const selected = Array.from(e.target.files ?? []);
          if (selected.length > 0) attachments.add(selected);
          e.target.value = "";
        }}
      />
    </PromptInputTools>
  );
}

// ---------------------------------------------------------------------------
// 会话面板
// ---------------------------------------------------------------------------

export function ChatPanel() {
  const { user, threads, activeThreadId, createThread, renameThread, providers, modelSelection } =
    useWorkbench();

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const [webSearchEnabled, setWebSearchEnabled] = React.useState(false);

  const selectedProvider = providers.find((p) => p.id === modelSelection?.providerId);

  // BYOK:每次请求携带模型路由对象 + 多用户隔离的 memory 标识 + 思考等级
  const transport = React.useMemo(
    () =>
      new DefaultChatTransport({
        api: `${MASTRA_SERVER_URL}/chat/mastra-work-agent`,
        body: {
          ...(selectedProvider && modelSelection
            ? { model: buildModelRouterObject(selectedProvider, modelSelection.modelId) }
            : {}),
          ...(selectedProvider && modelSelection && modelSelection.reasoningEffort !== "off"
            ? {
                providerOptions: buildReasoningProviderOptions(
                  selectedProvider.type,
                  modelSelection.reasoningEffort,
                ),
              }
            : {}),
          memory: {
            resource: user.id,
            thread: activeThreadId ? { id: activeThreadId, title: activeThread?.title } : undefined,
          },
        },
      }),
    [selectedProvider, modelSelection, user.id, activeThreadId, activeThread?.title],
  );

  const { messages, sendMessage, setMessages, status } = useChat({
    transport,
  });

  const isBusy = status === "submitted" || status === "streaming";

  // 切换线程时拉取历史消息
  React.useEffect(() => {
    if (!activeThreadId) {
      setMessages([]);
      return;
    }
    fetch(`${MASTRA_SERVER_URL}/api/work/threads/${activeThreadId}/messages`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((data: { messages: UIMessage[] }) => setMessages(data.messages ?? []))
      .catch(() => setMessages([]));
  }, [activeThreadId, setMessages]);

  const handleSubmit = async (message: { text: string; files?: FileUIPart[] }) => {
    const text = message.text.trim();
    const files = message.files ?? [];
    if (!(text || files.length > 0)) return;

    // 无激活线程时,先创建线程再发送
    if (!activeThreadId) {
      const thread = await createThread(null, text.slice(0, 30) || "New Chat");
      if (!thread) {
        toast.error("创建会话失败,请确认 Mastra 服务已启动");
        return;
      }
      // 首条消息用线程标题
      if (text) void renameThread(thread.id, text.slice(0, 30));
    }

    await sendMessage(text ? { text, files } : { files });
  };

  return (
    <MessageScrollerProvider autoScroll>
      <div className="flex size-full min-h-0 flex-col">
        {messages.length === 0 && !isBusy ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageCircleDashedIcon />
              </EmptyMedia>
              <EmptyTitle>开始新对话</EmptyTitle>
              <EmptyDescription>
                {activeThread ? `继续「${activeThread.title}」` : "发送消息开始与 MastraWork 对话"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent
                aria-busy={isBusy}
                className="mx-auto w-full max-w-3xl px-4 py-6"
              >
                {messages.map((message) => (
                  <MessageItem key={message.id} message={message} />
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        )}

        <div className="shrink-0 px-4 pb-4">
          <PromptInputProvider>
            <div className="mx-auto w-full max-w-3xl">
              <PromptInput onSubmit={handleSubmit}>
                <PromptInputBody>
                  <PromptInputTextarea
                    placeholder={activeThread ? "继续对话..." : "输入消息,Enter 发送"}
                  />
                </PromptInputBody>
                <PromptInputFooter>
                  <PromptInputActions
                    webSearchEnabled={webSearchEnabled}
                    onToggleWebSearch={() => setWebSearchEnabled(!webSearchEnabled)}
                  />
                  {/* 模型选择器按钮位于 Send 按钮左侧 */}
                  <div className="flex items-center gap-2">
                    <ChatModelSelector />
                    <PromptInputSubmit status={status} />
                  </div>
                </PromptInputFooter>
              </PromptInput>
            </div>
          </PromptInputProvider>
        </div>
      </div>
    </MessageScrollerProvider>
  );
}
