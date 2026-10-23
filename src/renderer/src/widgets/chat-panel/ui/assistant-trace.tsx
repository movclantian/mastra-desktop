import { useQuery } from "@tanstack/react-query";
import { BrainIcon, CheckIcon, FileIcon, PauseIcon, XIcon } from "lucide-react";
import * as React from "react";
import { fetchMcpServers, usePluginSkills } from "@/entities/skill";
import { useDesktopSettingsQuery } from "@/entities/workbench/model/queries/config";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from "@/shared/ui/ai-elements/chain-of-thought";
import {
  Reasoning,
  ReasoningContent,
  ReasoningStreamingPreview,
  ReasoningTrigger,
} from "@/shared/ui/ai-elements/reasoning";
import {
  Sandbox,
  SandboxContent,
  SandboxHeader,
  SandboxTabContent,
  SandboxTabs,
  SandboxTabsBar,
  SandboxTabsList,
  SandboxTabsTrigger,
} from "@/shared/ui/ai-elements/sandbox";
import {
  StackTrace,
  StackTraceContent,
  StackTraceCopyButton,
  StackTraceError,
  StackTraceErrorMessage,
  StackTraceErrorType,
  StackTraceFrames,
  StackTraceHeader,
} from "@/shared/ui/ai-elements/stack-trace";
import { Task, TaskContent, TaskItemFile, TaskTrigger } from "@/shared/ui/ai-elements/task";
import { ToolInput, ToolOutput, type ToolPart } from "@/shared/ui/ai-elements/tool";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
} from "@/shared/ui/code-block";
import { CodeFile } from "@/shared/ui/code-file";
import { Dotm3x3_6 } from "@/shared/ui/dotm-3x3-6";
import { DotmCircular4 } from "@/shared/ui/dotm-circular-4";
import { DotmHex1 } from "@/shared/ui/dotm-hex-1";
import { DotmSquare10 } from "@/shared/ui/dotm-square-10";
import { DotmTriangle2 } from "@/shared/ui/dotm-triangle-2";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/shared/ui/trace";
import { asRecord, getToolTraceState, getTraceStepStatus, type TracePart } from "../model/types";
import { getToolUI } from "./tool-registry-ui";

const MediaGeneration = React.lazy(() => import("./media-generation"));

export function useTraceDisclosure(showDetails: boolean, isStreaming: boolean) {
  const [state, setState] = React.useState({ showDetails, isStreaming, open: showDetails });
  // Reset every disclosure for a new run or preference change, not for each token.
  if (state.showDetails !== showDetails || state.isStreaming !== isStreaming) {
    setState({
      showDetails,
      isStreaming,
      open: state.showDetails !== showDetails || isStreaming ? showDetails : state.open,
    });
  }
  const setOpen = React.useCallback((open: boolean) => {
    setState((current) => ({ ...current, open }));
  }, []);
  return [state.open, setOpen] as const;
}

// Trace provides shared disclosure, status and nested step layout.

/**
 * 运行中指示器按工具类别分派点阵动效 —— 同一个转圈无法区分"在跑代码"
 * 和"在联网检索",不同点阵各自对应一种真实工作形态:
 * CRT 电子束扫描 = 沙箱执行、雷达 = 联网检索、蜂巢 = 知识库/RAG 检索、
 * 核心涟漪 = 其余通用工具调用。
 */
function ToolRunningMatrix({ name }: { name: string }) {
  if (name.includes("bash") || name.includes("command") || name.includes("typescript")) {
    return <DotmSquare10 size={14} dotSize={1.6} colorPreset="solid-theme" />;
  }
  if (name.includes("search") || name.includes("browser") || name.includes("fetch")) {
    return <DotmCircular4 size={14} dotSize={1.6} colorPreset="solid-theme" />;
  }
  if (name.includes("rag") || name.includes("knowledge") || name.includes("retriev")) {
    return <DotmHex1 size={14} dotSize={1.6} colorPreset="solid-theme" />;
  }
  return <Dotm3x3_6 size={14} dotSize={1.8} colorPreset="solid-theme" />;
}

function toolDurationMs(part: ToolPart): number | undefined {
  const providerMetadata = "callProviderMetadata" in part ? part.callProviderMetadata : undefined;
  const mastra =
    typeof providerMetadata === "object" && providerMetadata
      ? (providerMetadata as Record<string, unknown>).mastra
      : undefined;
  const createdAt =
    typeof mastra === "object" && mastra
      ? (mastra as Record<string, unknown>).createdAt
      : undefined;
  const started =
    typeof part.createdAt === "number"
      ? part.createdAt
      : typeof createdAt === "number"
        ? createdAt
        : undefined;
  const updated =
    "updatedAt" in part && typeof part.updatedAt === "number" ? part.updatedAt : undefined;
  if (
    started === undefined ||
    updated === undefined ||
    !Number.isFinite(started) ||
    !Number.isFinite(updated) ||
    updated < started
  )
    return undefined;
  return updated - started;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * 推理步骤由 Trace 展开,正文使用 Streamdown。
 * ReasoningContent 内部由 Streamdown 增量渲染 Markdown,避免纯文本与富文本切换时的闪变。
 */
const ReasoningStepItem = React.memo(function ReasoningStepItem({
  part,
  isStreaming,
  showDetails,
}: {
  part: Extract<TracePart, { type: "reasoning" }>;
  isStreaming: boolean;
  showDetails: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useTraceDisclosure(showDetails, isStreaming);
  const active = getTraceStepStatus(part) === "active";
  const partStreaming = isStreaming && active;

  if (!part.text)
    return (
      <TraceLine status={partStreaming ? "running" : undefined}>
        <TraceIcon>
          <BrainIcon />
        </TraceIcon>
        <TraceTitle>{t(partStreaming ? "common:thinking" : "chat:trace.thought")}</TraceTitle>
      </TraceLine>
    );

  return (
    <Reasoning className="mb-0" isStreaming={partStreaming} open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 items-center gap-2">
        {/* 折叠态也把最新一行推理流式滚进触发行(仅一行,不展开正文) */}
        <ReasoningTrigger className="min-w-0" streamingText={part.text} />
        {/* 三角波点阵 = 模型正在思考,与工具执行态的点阵形态明确区分 */}
        {partStreaming ? <DotmTriangle2 size={14} dotSize={1.8} colorPreset="solid-theme" /> : null}
      </div>
      {/*
       * 流式与完成态统一走 ReasoningContent(Streamdown):Streamdown 为流式
       * 增量解析设计,块级 memo,每 token 只重解析尾部未完成块 —— 与主回答
       * (MessageResponse)同一条渲染路径,不存在"每 token 全量重跑"。
       * 之前流式态用纯文本、结束后切 Markdown,会造成完成瞬间的排版闪变。
       */}
      <ReasoningContent>{part.text || t("chat:trace.noReasoningSummary")}</ReasoningContent>
    </Reasoning>
  );
});

/**
 * 工具摘要和输出采用 Trace;详情开关允许在输出到达前查看输入。
 */
const ToolStepItem = React.memo(function ToolStepItem({
  part,
  showDetails,
  isStreaming,
}: {
  part: ToolPart;
  showDetails: boolean;
  isStreaming: boolean;
}) {
  const { t } = useTranslation();
  const name = part.type === "dynamic-tool" ? part.toolName : part.type.replace("tool-", "");
  const typescriptSandbox = name === "execute_typescript";
  const commandSandbox = name === "mastra_workspace_execute_command";
  const { active, failed, denied, unfinished, exitCode } = getToolTraceState(part, isStreaming);
  const [open, setOpen] = useTraceDisclosure(showDetails, isStreaming);
  const [sandboxOpen, setSandboxOpen] = useTraceDisclosure(showDetails, isStreaming);
  const [stackOpen, setStackOpen] = useTraceDisclosure(showDetails, isStreaming);
  const transportFailed = part.state === "output-error";
  const hasInput = part.input !== undefined;
  const output = "output" in part ? part.output : undefined;
  const terminalOutput = typeof output === "string" ? output : part.terminal?.output;
  const codeResult =
    typescriptSandbox && output && typeof output === "object"
      ? (output as { success?: boolean; error?: { message?: string } })
      : undefined;
  const errorText =
    ("errorText" in part ? part.errorText : undefined) ??
    codeResult?.error?.message ??
    (unfinished ? t("chat:trace.noRecordedResult") : undefined);
  const input = asRecord(part.input) ?? {};
  const { user } = useAuth();
  const pluginSkills = usePluginSkills(
    name === "skill" || name === "skill_read" ? user?.id : undefined,
  );
  const mcp = useQuery({
    queryKey: ["plugin-mcp", user?.id],
    queryFn: fetchMcpServers,
    enabled: !!user && name.startsWith("mcp_"),
  });
  const skill = pluginSkills.data?.find(
    (skill) => skill.name === (name === "skill" ? input.name : input.skillName),
  );
  const server = mcp.data?.find((server) => name.startsWith(`mcp_${server.id}_`));
  const filePaths = [
    ...new Set(
      Object.entries(input).flatMap(([key, value]) =>
        /(?:path|file)/i.test(key) && typeof value === "string" && value.trim()
          ? [value.trim()]
          : [],
      ),
    ),
  ].slice(0, 3);
  // 文件参数单独用 TaskItemFile 展示；摘要取第一个其余短字符串。
  const hintValue = Object.entries(input).find(
    ([key, value]) =>
      !/(?:path|file)/i.test(key) && typeof value === "string" && value.trim().length > 0,
  )?.[1];
  const hint = typeof hintValue === "string" ? hintValue : undefined;
  const hintLabel = hint ? (hint.length > 64 ? `${hint.slice(0, 64)}…` : hint) : null;
  const hasDetails =
    output !== undefined ||
    Boolean(terminalOutput) ||
    Boolean(errorText) ||
    (showDetails && hasInput);

  // 专属 UI 注册表:命中则用本地化标签 + 精选参数摘要,详情可整体替换;
  // 未命中的工具保持通用展示(原始名 + 自动参数提示 + JSON 详情)。
  const ui = getToolUI(name);
  const customSummary = ui?.summarize?.(input, output, name);
  const chips = skill
    ? [
        skill.displayName,
        `${t("common:current")}: ${t(skill.enabled ? "plugins:enabled" : "plugins:disabled")}`,
      ]
    : server
      ? [
          server.name,
          name.slice(`mcp_${server.id}_`.length),
          `${t("common:current")}: ${t(server.configurationError ? "plugins:missingConfig" : server.enabled ? "plugins:enabled" : "plugins:disabled")}`,
        ]
      : customSummary
        ? (customSummary.chips ?? [])
        : hintLabel
          ? [hintLabel]
          : [];
  const files = customSummary ? (customSummary.files ?? []) : filePaths;
  const customDetail = failed ? undefined : ui?.detail?.({ input, output });

  const sandboxOutput = React.useMemo(() => {
    if (!typescriptSandbox) return "";
    if (transportFailed) return errorText ?? t("chat:trace.executionFailed");
    if (output === undefined) return active ? t("chat:trace.executing") : "";
    if (typeof output === "string") return output;
    const record = output && typeof output === "object" ? (output as Record<string, unknown>) : {};
    const lines = Array.isArray(record.logs)
      ? record.logs.filter((line): line is string => typeof line === "string")
      : [];
    if (record.result !== undefined) {
      lines.push(
        typeof record.result === "string" ? record.result : JSON.stringify(record.result, null, 2),
      );
    }
    if (record.error !== undefined) {
      lines.push(
        typeof record.error === "string" ? record.error : JSON.stringify(record.error, null, 2),
      );
    }
    return lines.join("\n");
  }, [active, errorText, transportFailed, output, typescriptSandbox, t]);

  const summary = (
    <span className="block min-w-0 space-y-1">
      {/* 标签、文件徽章、参数 chips 同处一个可换行 flex 行:放得下就同行,
          放不下才折行 —— 之前徽章单独一行,工具只有一个路径参数时必然换行 */}
      <span
        className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 break-words"
        title={ui ? name : undefined}
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {ui ? (
            <ui.icon className="mr-1 inline size-3.5 text-muted-foreground align-[-2px]" />
          ) : null}
          {t(
            `chat:trace.toolAction.${denied ? "denied" : active ? "running" : failed ? "failed" : "ran"}`,
          )}{" "}
          {ui ? t(`chat:trace.toolNames.${ui.labelKey}`) : name}
        </span>
        {files.map((path) => (
          <TaskItemFile className="max-w-full" key={path} title={path}>
            <FileIcon className="size-3 shrink-0" />
            <span className="truncate">{path}</span>
          </TaskItemFile>
        ))}
        {chips.map((chip, index) => (
          <span className="text-muted-foreground/70" key={`${index}:${chip}`}>
            {" · "}
            {chip}
          </span>
        ))}
      </span>
      {exitCode !== undefined && exitCode !== 0 ? (
        <span className="block text-destructive text-xs">
          {t("chat:trace.exitCode", { code: exitCode })}
        </span>
      ) : null}
      {failed ? (
        <span className="block text-destructive text-xs">
          {errorText ?? t("chat:trace.callFailed")}
        </span>
      ) : null}
      {toolDurationMs(part) !== undefined ? (
        <span className="block text-[10px] tabular-nums text-muted-foreground">
          {formatDuration(toolDurationMs(part) ?? 0)}
          {active ? " · …" : ""}
        </span>
      ) : active ? (
        <span className="block text-[10px] tabular-nums text-muted-foreground">…</span>
      ) : null}
    </span>
  );

  const line = (
    <TraceLine
      className="w-full items-start"
      status={active ? "running" : failed ? "error" : undefined}
    >
      <TraceIcon className="mt-0.5">
        {active ? (
          <ToolRunningMatrix name={name} />
        ) : failed ? (
          <XIcon className="size-3.5 text-destructive" />
        ) : denied ? (
          <PauseIcon className="size-3.5 text-muted-foreground" />
        ) : (
          <CheckIcon className="size-3.5 text-emerald-500" />
        )}
      </TraceIcon>
      <TraceTitle className="flex-1 whitespace-normal">{summary}</TraceTitle>
    </TraceLine>
  );

  if (!hasDetails) return line;

  return (
    <TraceCollapsible open={open} onOpenChange={setOpen} className="w-full">
      <TraceCollapsibleTrigger className="w-full items-start" aria-label={name}>
        {line}
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <div className="min-w-0 max-w-full space-y-2">
          {commandSandbox ? (
            <Trace>
              {typeof input.command === "string" ? (
                <CodeBlock size="sm">
                  <CodeBlockActions>
                    <CodeBlockCopyButton value={input.command} />
                  </CodeBlockActions>
                  <CodeBlockContent wrap>{input.command}</CodeBlockContent>
                </CodeBlock>
              ) : null}
              {terminalOutput || errorText ? (
                <CodeBlock size="sm" variant={failed ? "destructive" : "default"}>
                  <CodeBlockActions>
                    <CodeBlockCopyButton value={terminalOutput || errorText || ""} />
                  </CodeBlockActions>
                  <CodeBlockContent wrap className="max-h-64">
                    {terminalOutput || errorText}
                  </CodeBlockContent>
                </CodeBlock>
              ) : null}
            </Trace>
          ) : typescriptSandbox ? (
            <Sandbox
              className="mb-0 min-w-0 max-w-full"
              open={sandboxOpen}
              onOpenChange={setSandboxOpen}
            >
              <SandboxHeader
                state={denied ? "output-denied" : failed ? "output-error" : part.state}
                title={t("chat:trace.typescriptScript")}
              />
              <SandboxContent className="min-w-0">
                <SandboxTabs defaultValue="code">
                  <SandboxTabsBar>
                    <SandboxTabsList>
                      <SandboxTabsTrigger value="code">{t("chat:trace.code")}</SandboxTabsTrigger>
                      <SandboxTabsTrigger value="output">
                        {t("chat:trace.output")}
                      </SandboxTabsTrigger>
                    </SandboxTabsList>
                  </SandboxTabsBar>
                  <SandboxTabContent value="code">
                    <CodeFile
                      className="min-w-0 max-w-full rounded-none border-0"
                      code={
                        typeof input.code === "string" ? input.code : t("chat:trace.generatingCode")
                      }
                      language="typescript"
                      lineNumbers
                      filename="script.ts"
                    />
                  </SandboxTabContent>
                  <SandboxTabContent value="output">
                    {failed ? (
                      <StackTrace
                        className="rounded-none border-0"
                        open={stackOpen}
                        onOpenChange={setStackOpen}
                        trace={sandboxOutput || errorText || t("chat:trace.executionFailed")}
                      >
                        <StackTraceHeader action={<StackTraceCopyButton />}>
                          <StackTraceError>
                            <StackTraceErrorType />
                            <StackTraceErrorMessage />
                          </StackTraceError>
                        </StackTraceHeader>
                        <StackTraceContent>
                          <StackTraceFrames />
                        </StackTraceContent>
                      </StackTrace>
                    ) : (
                      <CodeFile
                        className="min-w-0 max-w-full rounded-none border-0"
                        code={sandboxOutput || t("chat:trace.waitingOutput")}
                        language="log"
                        filename="output.log"
                      />
                    )}
                  </SandboxTabContent>
                </SandboxTabs>
              </SandboxContent>
            </Sandbox>
          ) : customDetail ? (
            customDetail
          ) : (
            <>
              {hasInput ? <ToolInput input={part.input} /> : null}
              {output !== undefined || failed ? (
                <ToolOutput errorText={errorText} output={output} />
              ) : null}
            </>
          )}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
});

/** Consecutive tool parts share one expandable Trace group. */
function ToolGroup({
  tools,
  showDetails,
  isStreaming,
}: {
  tools: ToolPart[];
  showDetails: boolean;
  isStreaming: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useTraceDisclosure(showDetails, isStreaming);
  const active = tools.some((tool) => getToolTraceState(tool, isStreaming).active);
  const observedStart = React.useRef<number | null>(null);
  const [observedMs, setObservedMs] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!active) {
      if (observedStart.current !== null) setObservedMs(performance.now() - observedStart.current);
      return;
    }
    if (observedStart.current === null) observedStart.current = performance.now();
    setObservedMs(performance.now() - observedStart.current);
    const timer = window.setInterval(() => {
      if (observedStart.current !== null) setObservedMs(performance.now() - observedStart.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const durations = tools.flatMap((tool) => {
    const duration = toolDurationMs(tool);
    return duration === undefined ? [] : [duration];
  });
  const totalDuration =
    durations.length === tools.length
      ? durations.reduce((sum, duration) => sum + duration, 0)
      : undefined;
  const toolTitle = t("chat:trace.toolCallsCount", {
    count: tools.length,
  });

  return (
    <Task className="w-full" open={open} onOpenChange={setOpen}>
      <TaskTrigger
        className="w-full"
        title={toolTitle}
        status={
          active
            ? "running"
            : tools.some((tool) => getToolTraceState(tool, isStreaming).failed)
              ? "error"
              : undefined
        }
      >
        <TraceDescription
          className="text-[10px]"
          title={t(
            !active && totalDuration !== undefined
              ? "chat:trace.totalToolTime"
              : observedMs !== null
                ? "chat:trace.observedToolTime"
                : "chat:trace.unknownToolTime",
          )}
        >
          {active
            ? observedMs === null
              ? "…"
              : `≈${formatDuration(observedMs)} · …`
            : totalDuration !== undefined
              ? formatDuration(totalDuration)
              : observedMs === null
                ? "—"
                : `≈${formatDuration(observedMs)}`}
        </TraceDescription>
      </TaskTrigger>
      <TaskContent>
        {tools.map((tool, index) => (
          <ToolStepItem
            key={`${tool.toolCallId}:${index}`}
            part={tool}
            showDetails={showDetails}
            isStreaming={isStreaming}
          />
        ))}
      </TaskContent>
    </Task>
  );
}

export function AssistantTrace({
  parts,
  isStreaming,
}: {
  parts: TracePart[];
  isStreaming: boolean;
}) {
  const { t } = useTranslation();
  const showDetails = useDesktopSettingsQuery().data?.showWorkDetails ?? false;
  const [open, setOpen] = useTraceDisclosure(showDetails, isStreaming);
  const reasoningCount = parts.filter((part) => part.type === "reasoning").length;
  const toolCount = parts.length - reasoningCount;
  const failedCount = parts.filter(
    (part) => part.type !== "reasoning" && getToolTraceState(part, isStreaming).failed,
  ).length;
  const active = parts.some((part) =>
    part.type === "reasoning"
      ? isStreaming && getTraceStepStatus(part) === "active"
      : getToolTraceState(part, isStreaming).active,
  );
  const reasoningPart = parts.findLast(
    (part) => part.type === "reasoning" && getTraceStepStatus(part) === "active",
  );
  const streamingText =
    isStreaming && reasoningPart?.type === "reasoning" ? reasoningPart.text : "";
  const summary = [
    reasoningCount ? t("chat:trace.thinking") : null,
    toolCount ? t("chat:trace.toolCall") : null,
  ]
    .filter(Boolean)
    .join(t("chat:trace.and"));
  // 按原始顺序铺开:推理步骤原位渲染,连续工具 part 聚成一个 Task 组
  const items: Array<{ key: string; node: React.ReactNode }> = [];
  let toolRun: ToolPart[] = [];
  let toolGroupIndex = 0;
  const flushTools = () => {
    if (toolRun.length === 0) return;
    const tools = toolRun;
    toolRun = [];
    items.push({
      key: `tools-${toolGroupIndex++}-${tools[0].toolCallId}`,
      node: <ToolGroup tools={tools} showDetails={showDetails} isStreaming={isStreaming} />,
    });
  };
  parts.forEach((part, index) => {
    if (part.type === "reasoning") {
      flushTools();
      items.push({
        // Provider reasoning ids are not guaranteed to be unique within one message.
        // Keep the source index in the React key so repeated ids cannot merge steps.
        key: `reasoning-${index}-${part.id ?? "part"}`,
        node: <ReasoningStepItem isStreaming={isStreaming} part={part} showDetails={showDetails} />,
      });
      return;
    }
    toolRun.push(part);
  });
  flushTools();

  return (
    <>
      <ChainOfThought className="max-w-full" onOpenChange={setOpen} open={open}>
        <ChainOfThoughtHeader status={active ? "running" : failedCount ? "error" : undefined}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0">
              {active
                ? t("chat:trace.processing")
                : t("chat:trace.stepsCount", {
                    count: parts.length,
                    summary: summary || t("chat:trace.executionTrace"),
                  })}
            </span>
            {failedCount ? (
              <span className="text-destructive">
                {t("chat:trace.failedCount", { count: failedCount })}
              </span>
            ) : null}
            {!open && streamingText ? <ReasoningStreamingPreview text={streamingText} /> : null}
          </span>
        </ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          {items.map((item) => (
            <React.Fragment key={item.key}>{item.node}</React.Fragment>
          ))}
        </ChainOfThoughtContent>
      </ChainOfThought>
      {parts.map((part) => {
        if (part.type === "reasoning") return null;
        const name = part.type === "dynamic-tool" ? part.toolName : part.type.replace("tool-", "");
        if (name !== "generate_image" && name !== "generate_video") return null;
        return (
          <React.Suspense key={part.toolCallId} fallback={null}>
            <MediaGeneration
              kind={name === "generate_image" ? "image" : "video"}
              pending={isStreaming && getTraceStepStatus(part) === "active"}
              waiting={part.state === "approval-requested"}
              output={"output" in part ? part.output : undefined}
              error={"errorText" in part ? part.errorText : undefined}
            />
          </React.Suspense>
        );
      })}
    </>
  );
}
