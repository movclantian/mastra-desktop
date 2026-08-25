import { CheckIcon, WrenchIcon, XIcon } from "lucide-react";
import * as React from "react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import {
  Sandbox,
  SandboxContent,
  SandboxHeader,
  SandboxTabContent,
  SandboxTabs,
  SandboxTabsBar,
  SandboxTabsList,
  SandboxTabsTrigger,
} from "@/components/ai-elements/sandbox";
import {
  StackTrace,
  StackTraceActions,
  StackTraceContent,
  StackTraceCopyButton,
  StackTraceError,
  StackTraceErrorMessage,
  StackTraceErrorType,
  StackTraceExpandButton,
  StackTraceFrames,
  StackTraceHeader,
} from "@/components/ai-elements/stack-trace";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import { ToolInput, ToolOutput, type ToolPart } from "@/components/ai-elements/tool";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { AnimatedChevron } from "@/components/ui/animated-icon";
import { Dotm3x3_6 } from "@/components/ui/dotm-3x3-6";
import { DotmCircular4 } from "@/components/ui/dotm-circular-4";
import { DotmHex1 } from "@/components/ui/dotm-hex-1";
import { DotmSquare10 } from "@/components/ui/dotm-square-10";
import { DotmTriangle2 } from "@/components/ui/dotm-triangle-2";
import { getTraceStepStatus, type TracePart } from "../types";

// ---------------------------------------------------------------------------
// 执行轨迹:推理步骤走官方 ChainOfThought 渲染;工具步骤按 docs/aielements/
// task.tsx 的 Task 模式 —— 连续的工具 part 归为一组,整组渲染成一个 Task
// (折叠触发器 + TaskContent 左边框时间线 + TaskItem 单行摘要)。
// 组件仍按 part 引用 memo:AI SDK 流式更新时未变更的 part 保持引用稳定
// (AI SDK v5 特性),已完成步骤可跳过重渲染,这是流式不卡顿的根治手段。
// ---------------------------------------------------------------------------

/**
 * 运行中指示器按工具类别分派点阵动效 —— 同一个转圈无法区分"在跑代码"
 * 和"在联网检索",不同点阵各自对应一种真实工作形态:
 * CRT 电子束扫描 = 沙箱执行、雷达 = 联网检索、蜂巢 = 知识库/RAG 检索、
 * 核心涟漪 = 其余通用工具调用。
 */
function ToolRunningMatrix({ name }: { name: string }) {
  const id = name.toLowerCase();
  if (id.includes("execute_typescript") || id.includes("execute_command")) {
    return <DotmSquare10 size={15} dotSize={1.8} colorPreset="solid-theme" />;
  }
  if (
    id.includes("search") ||
    id.includes("tavily") ||
    id.includes("fetch") ||
    id.includes("web")
  ) {
    return <DotmCircular4 size={15} dotSize={1.8} colorPreset="solid-theme" />;
  }
  if (id.includes("rag") || id.includes("knowledge") || id.includes("library")) {
    return <DotmHex1 size={15} dotSize={1.8} colorPreset="solid-theme" />;
  }
  return <Dotm3x3_6 size={13} dotSize={2} colorPreset="solid-theme" />;
}

const ReasoningStepItem = React.memo(function ReasoningStepItem({
  part,
  isStreaming,
}: {
  part: Extract<TracePart, { type: "reasoning" }>;
  isStreaming: boolean;
}) {
  const partStreaming = isStreaming && part.state === "streaming";
  return (
    <ChainOfThoughtStep label="" status={partStreaming ? "active" : "complete"}>
      <Reasoning className="mb-0" defaultOpen={partStreaming} isStreaming={partStreaming}>
        <div className="flex min-w-0 items-center gap-2">
          <ReasoningTrigger />
          {/* 三角波点阵 = 模型正在思考,与工具执行态的点阵形态明确区分 */}
          {partStreaming ? (
            <DotmTriangle2 size={14} dotSize={1.8} colorPreset="solid-theme" />
          ) : null}
        </div>
        {/*
         * 流式与完成态统一走 ReasoningContent(Streamdown):Streamdown 为流式
         * 增量解析设计,块级 memo,每 token 只重解析尾部未完成块 —— 与主回答
         * (MessageResponse)同一条渲染路径,不存在"每 token 全量重跑"。
         * 之前流式态用纯文本、结束后切 Markdown,会造成完成瞬间的排版闪变。
         */}
        <ReasoningContent>{part.text || "此模型未返回可展示的推理摘要"}</ReasoningContent>
      </Reasoning>
    </ChainOfThoughtStep>
  );
});

/**
 * 工具步骤:TaskItem 单行摘要(状态图标 + 工具名 + 关键参数)。
 * 有参数或输出时整行可点,展开显示 ToolInput/ToolOutput 的 JSON 详情
 * (默认收起,需要时再看,不再无条件倾倒原始数据)。
 */
const ToolStepItem = React.memo(function ToolStepItem({ part }: { part: ToolPart }) {
  const name = part.type === "dynamic-tool" ? part.toolName : part.type.replace("tool-", "");
  const typescriptSandbox = name === "execute_typescript";
  const commandSandbox = name === "mastra_workspace_execute_command";
  const sandboxTool = typescriptSandbox || commandSandbox;
  const [open, setOpen] = React.useState(sandboxTool);
  const active = getTraceStepStatus(part) === "active";
  const failed = part.state === "output-error";
  const errorText = "errorText" in part ? part.errorText : undefined;
  const hasInput = part.input !== undefined;
  const output = "output" in part ? part.output : undefined;
  const input = (part.input ?? {}) as Record<string, unknown>;
  // 参数摘要:取第一个有值的短字符串(query/url/path 等关键参数通常排在最前)
  const hint = Object.values(input).find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const hintLabel = hint ? (hint.length > 64 ? `${hint.slice(0, 64)}…` : hint) : null;
  const hasDetails = hasInput || output !== undefined;

  const sandboxOutput = React.useMemo(() => {
    if (!sandboxTool) return "";
    if (failed) return errorText ?? "执行失败";
    if (output === undefined) return active ? "正在执行..." : "";
    if (typeof output === "string") return output;
    if (commandSandbox) {
      return typeof output === "string" ? output : JSON.stringify(output, null, 2);
    }
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
  }, [active, commandSandbox, errorText, failed, output, sandboxTool]);

  const summary = (
    <>
      {name}
      {hintLabel ? <span className="text-muted-foreground/70"> · {hintLabel}</span> : null}
      {failed ? (
        <span className="block text-destructive text-xs">{errorText ?? "调用失败"}</span>
      ) : null}
    </>
  );

  return (
    <AnimatedCollapsible
      open={open}
      duration={0.24}
      contentClassName="min-w-0"
      trigger={
        <TaskItem className="flex items-start gap-2">
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
            {active ? (
              <ToolRunningMatrix name={name} />
            ) : failed ? (
              <XIcon className="size-3.5 text-destructive" />
            ) : (
              <CheckIcon className="size-3.5 text-emerald-500" />
            )}
          </span>
          {hasDetails ? (
            <button
              className="min-w-0 flex-1 break-words text-left"
              onClick={() => setOpen(!open)}
              type="button"
            >
              {summary}
            </button>
          ) : (
            <span className="min-w-0 flex-1 break-words">{summary}</span>
          )}
          {hasDetails ? (
            <AnimatedChevron open={open} className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
        </TaskItem>
      }
    >
      {hasDetails ? (
        <div className="mt-1 min-w-0 max-w-full space-y-2 pl-3">
          {sandboxTool ? (
            <Sandbox className="mb-0 min-w-0 max-w-full" defaultOpen>
              <SandboxHeader
                state={part.state}
                title={commandSandbox ? "工作区命令" : "TypeScript 工作区脚本"}
              />
              <SandboxContent className="min-w-0">
                <SandboxTabs defaultValue="code">
                  <SandboxTabsBar>
                    <SandboxTabsList>
                      <SandboxTabsTrigger value="code">代码</SandboxTabsTrigger>
                      <SandboxTabsTrigger value="output">输出</SandboxTabsTrigger>
                    </SandboxTabsList>
                  </SandboxTabsBar>
                  <SandboxTabContent value="code">
                    <CodeBlock
                      className="min-w-0 max-w-full rounded-none border-0"
                      code={
                        commandSandbox
                          ? typeof input.command === "string"
                            ? input.command
                            : "# 正在生成命令..."
                          : typeof input.code === "string"
                            ? input.code
                            : "// 正在生成代码..."
                      }
                      language={commandSandbox ? "bash" : "typescript"}
                      showLineNumbers
                    >
                      <CodeBlockCopyButton className="absolute top-2 right-2" size="sm" />
                    </CodeBlock>
                  </SandboxTabContent>
                  <SandboxTabContent value="output">
                    {failed ? (
                      <StackTrace
                        className="rounded-none border-0"
                        defaultOpen
                        trace={sandboxOutput || errorText || "执行失败"}
                      >
                        <StackTraceHeader>
                          <StackTraceError>
                            <StackTraceErrorType />
                            <StackTraceErrorMessage />
                          </StackTraceError>
                          <StackTraceActions>
                            <StackTraceCopyButton />
                            <StackTraceExpandButton />
                          </StackTraceActions>
                        </StackTraceHeader>
                        <StackTraceContent>
                          <StackTraceFrames />
                        </StackTraceContent>
                      </StackTrace>
                    ) : (
                      <CodeBlock
                        className="min-w-0 max-w-full rounded-none border-0"
                        code={sandboxOutput || "正在等待输出…"}
                        language="log"
                      >
                        <CodeBlockCopyButton className="absolute top-2 right-2" size="sm" />
                      </CodeBlock>
                    )}
                  </SandboxTabContent>
                </SandboxTabs>
              </SandboxContent>
            </Sandbox>
          ) : (
            <>
              {hasInput ? <ToolInput input={part.input} /> : null}
              {output !== undefined ? <ToolOutput errorText={errorText} output={output} /> : null}
            </>
          )}
        </div>
      ) : null}
    </AnimatedCollapsible>
  );
});

/**
 * 工具组:连续的工具 part 归为一组,渲染成一个 Task(折叠头 + 时间线)。
 * 必须和推理步骤一样包在 ChainOfThoughtStep 里 —— 那层的 `div.relative` 图标列
 * (圆点 + absolute 竖线)就是左侧时间线;少了它,工具组会贴到最左与 Header 平齐,
 * 和推理步骤错开一个图标列的宽度,层级就断了。
 */
function ToolGroup({ tools }: { tools: ToolPart[] }) {
  const active = tools.some((tool) => getTraceStepStatus(tool) === "active");
  return (
    <ChainOfThoughtStep label="" status={active ? "active" : "complete"}>
      <Task className="w-full">
        {/* w-full:折叠头占满整行,chevron 与外层 Header 的一样右对齐 */}
        <TaskTrigger className="w-full" title={`工具调用 · ${tools.length} 步`}>
          <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
            <WrenchIcon className="size-4" />
            <p className="flex-1 text-left text-sm">工具调用 · {tools.length} 步</p>
            <AnimatedChevron
              open={false}
              className="size-4 group-data-[state=open]:rotate-180 transition-transform duration-200"
            />
          </div>
        </TaskTrigger>
        <TaskContent>
          {tools.map((tool) => (
            <ToolStepItem key={tool.toolCallId} part={tool} />
          ))}
        </TaskContent>
      </Task>
    </ChainOfThoughtStep>
  );
}

export function AssistantTrace({
  parts,
  isStreaming,
}: {
  parts: TracePart[];
  isStreaming: boolean;
}) {
  const reasoningCount = parts.filter((part) => part.type === "reasoning").length;
  const toolCount = parts.length - reasoningCount;
  const active = parts.some((part) => getTraceStepStatus(part) === "active");
  const summary = [reasoningCount ? "思考" : null, toolCount ? "工具调用" : null]
    .filter(Boolean)
    .join("与");
  const [open, setOpen] = React.useState(isStreaming && active);
  const wasStreaming = React.useRef(isStreaming);

  React.useEffect(() => {
    if (isStreaming && active && !wasStreaming.current) {
      setOpen(true);
    }
    if (!isStreaming && wasStreaming.current) {
      setOpen(false);
    }
    wasStreaming.current = isStreaming;
  }, [active, isStreaming]);

  // 按原始顺序铺开:推理步骤原位渲染,连续工具 part 聚成一个 Task 组
  const items: Array<{ key: string; node: React.ReactNode }> = [];
  let toolRun: ToolPart[] = [];
  const flushTools = () => {
    if (toolRun.length === 0) return;
    const tools = toolRun;
    toolRun = [];
    items.push({ key: `tools-${tools[0].toolCallId}`, node: <ToolGroup tools={tools} /> });
  };
  parts.forEach((part, index) => {
    if (part.type === "reasoning") {
      flushTools();
      items.push({
        // Provider reasoning ids are not guaranteed to be unique within one message.
        // Keep the source index in the React key so repeated ids cannot merge steps.
        key: `reasoning-${index}-${part.id ?? "part"}`,
        node: <ReasoningStepItem isStreaming={isStreaming} part={part} />,
      });
      return;
    }
    toolRun.push(part);
  });
  flushTools();

  return (
    <ChainOfThought className="max-w-full" onOpenChange={setOpen} open={open}>
      <ChainOfThoughtHeader>
        {active ? "正在处理" : `${summary || "执行轨迹"} · ${parts.length} 个步骤`}
      </ChainOfThoughtHeader>
      {/* 不额外缩进:每个步骤自带 ChainOfThoughtStep 的图标列,圆点正好落在
          Header 的 BrainIcon 那一列,步骤正文与 Header 文字起点对齐;
          再往内一层的层级由工具组 TaskContent 自带的时间线承担 */}
      <ChainOfThoughtContent>
        {items.map((item) => (
          <React.Fragment key={item.key}>{item.node}</React.Fragment>
        ))}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}
