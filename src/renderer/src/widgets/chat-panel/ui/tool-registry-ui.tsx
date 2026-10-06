import {
  AppWindowIcon,
  ArrowLeftIcon,
  ArrowUpDownIcon,
  BookMarkedIcon,
  BookOpenIcon,
  CameraIcon,
  CircleStopIcon,
  ClockIcon,
  CodeXmlIcon,
  DatabaseIcon,
  FileCode2Icon,
  FileDownIcon,
  FilePenLineIcon,
  FilePlus2Icon,
  FileSearchIcon,
  FileTextIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  GlobeIcon,
  InboxIcon,
  KeyboardIcon,
  LibraryBigIcon,
  ListChecksIcon,
  type LucideIcon,
  MonitorIcon,
  MousePointer2Icon,
  MousePointerClickIcon,
  MoveIcon,
  NetworkIcon,
  PlugIcon,
  RadioIcon,
  ScissorsIcon,
  SearchIcon,
  StethoscopeIcon,
  TerminalIcon,
  TextSearchIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import * as React from "react";
import { contentObjectUrl } from "@/entities/workbench/api/workbench-api";
import { useAuth } from "@/features/auth";
import { useTranslation } from "@/shared/i18n";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/shared/ui/ai-elements/code-block";
import { asRecord, asString } from "../model/types";

// ---------------------------------------------------------------------------
// 每个工具的专属 UI 注册表:图标 + 本地化标签 + 关键参数摘要 + 展开详情。
// 注册表只做「展示」,不改变 ToolStepItem 的状态/折叠行为;未注册的工具
// 走通用回退(原始工具名 + 参数提示 + ToolInput/ToolOutput JSON)。
// ---------------------------------------------------------------------------

export type ToolSummary = { chips?: string[]; files?: string[] };

export type ToolUIDescriptor = {
  icon: LucideIcon;
  /** chat:trace.toolNames 下的 key */
  labelKey: string;
  summarize?: (input: Record<string, unknown>, output: unknown, name: string) => ToolSummary;
  /** 展开后的详情;返回 undefined/null 时回退到通用 ToolInput/ToolOutput */
  detail?: (ctx: { input: Record<string, unknown>; output: unknown }) => React.ReactNode;
};

const asStr = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const pickStr = (input: Record<string, unknown>, ...keys: string[]): string | undefined =>
  keys.map((key) => asStr(input[key])).find(Boolean);

const cap = (text: string, max = 72): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const resultsOf = (output: unknown): Record<string, unknown>[] => {
  const results = asRecord(output)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
};

const pathFiles = (input: Record<string, unknown>, ...keys: string[]): string[] => {
  const value = pickStr(input, ...(keys.length > 0 ? keys : ["path"]));
  return value ? [value] : [];
};

const queryChips = (input: Record<string, unknown>, ...keys: string[]): string[] => {
  const value = pickStr(input, ...(keys.length > 0 ? keys : ["query"]));
  return value ? [value] : [];
};

type CodeLanguage = React.ComponentProps<typeof CodeBlock>["language"];

const EXT_LANG: Record<string, CodeLanguage> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  html: "html",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
};

const langOf = (path?: string): CodeLanguage => {
  const ext = path?.split(".").pop()?.toLowerCase();
  return (ext && EXT_LANG[ext]) || "log";
};

const lineRange = (input: Record<string, unknown>): string | undefined => {
  const offset = typeof input.offset === "number" ? input.offset : undefined;
  const limit = typeof input.limit === "number" ? input.limit : undefined;
  if (!offset && !limit) return undefined;
  if (offset && limit) return `L${offset}–${offset + limit - 1}`;
  return offset ? `L${offset}–` : undefined;
};

/** 详情里长文本的截断上限:CodeBlock 无虚拟化,超长输出会拖垮展开动画 */
const DETAIL_TEXT_LIMIT = 12_000;

const capped = (text: string): string =>
  text.length > DETAIL_TEXT_LIMIT ? `${text.slice(0, DETAIL_TEXT_LIMIT)}\n…` : text;

const outputText = (output: unknown): string | undefined =>
  typeof output === "string" ? output : asString(asRecord(output)?.text);

function CodeFile({
  code,
  language,
  filename,
}: {
  code: string;
  language: CodeLanguage;
  filename?: string;
}) {
  return (
    <CodeBlock className="min-w-0 max-w-full" code={code} language={language}>
      <CodeBlockHeader>
        <CodeBlockTitle>
          <FileCode2Icon className="size-3.5" />
          {filename ? <CodeBlockFilename>{filename}</CodeBlockFilename> : null}
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton size="icon-xs" />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}

/** 搜索/检索类结果列表:tavily/firecrawl/library 共用,字段名做防御性兼容 */
function ResultsDetail({ output }: { output: unknown }) {
  const { t } = useTranslation();
  const results = resultsOf(output);
  if (results.length === 0) return null;
  return (
    <div className="space-y-1">
      {results.slice(0, 8).map((item, index) => {
        const title = pickStr(item, "title", "filename") ?? asStr(item.url) ?? "—";
        const url = asStr(item.url);
        const snippet = pickStr(item, "snippet", "content", "text");
        const score = typeof item.score === "number" ? item.score : undefined;
        return (
          <div className="rounded-md border bg-muted/30 px-2 py-1.5 text-xs" key={index}>
            <div className="flex items-center justify-between gap-2">
              {url ? (
                <a
                  className="truncate font-medium text-primary underline underline-offset-2 [overflow-wrap:anywhere]"
                  href={url}
                  rel="noreferrer"
                  target="_blank"
                  title={title}
                >
                  {title}
                </a>
              ) : (
                <span className="truncate font-medium" title={title}>
                  {title}
                </span>
              )}
              {score !== undefined ? (
                <span className="shrink-0 text-muted-foreground">{score.toFixed(2)}</span>
              ) : null}
            </div>
            {snippet ? (
              <p className="mt-0.5 line-clamp-2 text-muted-foreground [overflow-wrap:anywhere]">
                {cap(snippet, 240)}
              </p>
            ) : null}
          </div>
        );
      })}
      {results.length > 8 ? (
        <p className="text-muted-foreground text-xs">
          {t("chat:trace.moreResults", { count: results.length - 8 })}
        </p>
      ) : null}
    </div>
  );
}

function PairDetail({
  oldText,
  newText,
  language,
}: {
  oldText?: string;
  newText?: string;
  language: CodeLanguage;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      {oldText ? (
        <CodeFile
          code={capped(oldText)}
          filename={t("chat:trace.oldContent")}
          language={language}
        />
      ) : null}
      {newText ? (
        <CodeFile
          code={capped(newText)}
          filename={t("chat:trace.newContent")}
          language={language}
        />
      ) : null}
    </div>
  );
}

function TextDetail({ text, language = "log" }: { text: string; language?: CodeLanguage }) {
  return <CodeFile code={capped(text)} language={language} />;
}

/** library_document_chunker:切分片段预览(#index + 文本) */
function ChunkListDetail({ output }: { output: unknown }) {
  const { t } = useTranslation();
  const chunks = (
    Array.isArray(asRecord(output)?.chunks) ? asRecord(output)?.chunks : []
  ) as Record<string, unknown>[];
  if (chunks.length === 0) return null;
  return (
    <div className="space-y-1">
      {chunks.slice(0, 6).map((item, index) => {
        const text = asStr(item.text);
        if (!text) return null;
        const label = typeof item.index === "number" ? `#${item.index}` : `#${index}`;
        return (
          <div className="rounded-md border bg-muted/30 px-2 py-1.5 text-xs" key={label}>
            <span className="font-medium text-muted-foreground">{label}</span>
            <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {cap(text, 400)}
            </p>
          </div>
        );
      })}
      {chunks.length > 6 ? (
        <p className="text-muted-foreground text-xs">
          {t("chat:trace.moreResults", { count: chunks.length - 6 })}
        </p>
      ) : null}
    </div>
  );
}

/** 只有一行说明文字的详情(read_file 的媒体输出等) */
function MediaNote() {
  const { t } = useTranslation();
  return <p className="text-muted-foreground text-xs">{t("chat:trace.mediaReturned")}</p>;
}

/** browser_screenshot:截图归档在用户内容目录,经 /work/contents 取回路由内联显示 */
function ScreenshotDetail({ contentObject }: { contentObject: Record<string, unknown> }) {
  const { t } = useTranslation();
  const { user: authUser } = useAuth();
  const userId = authUser?.id ?? "anonymous";
  const [failed, setFailed] = React.useState(false);
  const objectId = asStr(contentObject.objectId);
  const kind = asStr(contentObject.kind);
  if (!objectId || !kind || failed) return null;
  return (
    <img
      alt={t("chat:trace.toolNames.browser_screenshot")}
      className="max-h-72 max-w-full rounded-md border"
      onError={() => setFailed(true)}
      src={contentObjectUrl(userId, {
        objectId,
        kind,
        threadId: asStr(contentObject.threadId),
        contentType: asStr(contentObject.contentType),
      })}
    />
  );
}

// --- 展开详情的通用构件 ------------------------------------------------------

/** 单条说明/结果文本(删除确认、创建目录、进程终止等轻量输出) */
function TextNote({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-muted-foreground text-xs [overflow-wrap:anywhere]">
      {cap(text, 2000)}
    </p>
  );
}

function RecordRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-xs">
      <span className="w-24 shrink-0 truncate text-muted-foreground/70">{label}</span>
      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{value}</span>
    </div>
  );
}

function recordValue(value: unknown): React.ReactNode | undefined {
  if (typeof value === "boolean") {
    return (
      <span className={value ? "text-emerald-600" : "text-muted-foreground"}>
        {value ? "✓" : "✗"}
      </span>
    );
  }
  if (typeof value === "number") return String(value);
  const text = asStr(value);
  return text ? cap(text, 400) : undefined;
}

/** 对象输出 → 字段行;数组/长嵌套跳过,留给列表类组件 */
function RecordDetail({ output, fields }: { output: unknown; fields?: string[] }) {
  const record = asRecord(output);
  if (!record) return null;
  const keys = fields ?? Object.keys(record);
  const rows = keys
    .filter((key) => {
      const value = record[key];
      return (
        value !== undefined &&
        value !== null &&
        (typeof value !== "object" || React.isValidElement(value))
      );
    })
    .map((key) => {
      const value = recordValue(record[key]);
      return value === undefined ? null : <RecordRow key={key} label={key} value={value} />;
    });
  return rows.some(Boolean) ? <div className="space-y-0.5">{rows}</div> : null;
}

/** 数组字段的记录列表(notifications / subscriptions / tabs...) */
function RecordsDetail({
  output,
  field,
  fields,
}: {
  output: unknown;
  field: string;
  fields?: string[];
}) {
  const { t } = useTranslation();
  const records = Array.isArray(asRecord(output)?.[field]) ? asRecord(output)?.[field] : [];
  if (!Array.isArray(records) || records.length === 0) return null;
  return (
    <div className="space-y-1">
      {(records as unknown[]).slice(0, 8).map((item, index) => {
        const record = asRecord(item);
        return record ? (
          <div className="rounded-md border bg-muted/30 px-2 py-1.5" key={index}>
            <RecordDetail fields={fields} output={record} />
          </div>
        ) : null;
      })}
      {records.length > 8 ? (
        <p className="text-muted-foreground text-xs">
          {t("chat:trace.moreResults", { count: records.length - 8 })}
        </p>
      ) : null}
    </div>
  );
}

/** 浏览器操作结果:success/url/title/value/scroll/hint 等统一卡片;额外字段自行追加 */
function BrowserResultDetail({ output, extra }: { output: unknown; extra?: React.ReactNode }) {
  const record = asRecord(output);
  if (!record) return null;
  const success = record.success === true;
  const url = asStr(record.url);
  const title = asStr(record.title) ?? url;
  const hint = asStr(record.hint);
  return (
    <div className="space-y-1">
      <RecordDetail
        fields={["error", "value", "result", "scroll", "elementCount", "index", "remaining"]}
        output={record}
      />
      {extra}
      {url ? (
        <p className="truncate text-xs">
          <a
            className="text-primary underline underline-offset-2"
            href={url}
            rel="noreferrer"
            target="_blank"
            title={title}
          >
            {success ? "✓" : "✗"} {title}
          </a>
        </p>
      ) : (
        <p className={`text-xs ${success ? "text-emerald-600" : "text-destructive"}`}>
          {success ? "✓" : "✗"}
        </p>
      )}
      {hint ? <p className="text-muted-foreground/70 text-xs">{cap(hint, 200)}</p> : null}
    </div>
  );
}

/**
 * 详情函数返回的 JSX 元素恒为真值,内部渲染 null 也会压掉通用 JSON 回退;
 * 因此每个详情入口先判断"有内容可渲染",没有就返回 null。
 */
const browserDetail = ({ output }: { output: unknown }) =>
  asRecord(output) ? <BrowserResultDetail output={output} /> : null;

const browserTabsDetail = ({ output }: { output: unknown }) =>
  asRecord(output) ? (
    <BrowserResultDetail extra={<RecordsDetail field="tabs" output={output} />} output={output} />
  ) : null;

const resultsDetail = ({ output }: { output: unknown }) =>
  resultsOf(output).length > 0 ? <ResultsDetail output={output} /> : null;

const chunkDetail = ({ output }: { output: unknown }) => {
  const chunks = asRecord(output)?.chunks;
  return Array.isArray(chunks) && chunks.length > 0 ? <ChunkListDetail output={output} /> : null;
};

const recordDetail = (output: unknown) => {
  const record = asRecord(output);
  if (!record) return null;
  const hasRows = Object.keys(record).some(
    (key) => record[key] !== undefined && record[key] !== null && typeof record[key] !== "object",
  );
  return hasRows ? <RecordDetail output={output} /> : null;
};

const recordsDetailFor =
  (field: string) =>
  ({ output }: { output: unknown }) => {
    const list = asRecord(output)?.[field];
    return Array.isArray(list) && list.length > 0 ? (
      <RecordsDetail field={field} output={output} />
    ) : null;
  };

// --- 工作区文件工具 ---------------------------------------------------------

const workspaceUIs: Record<string, ToolUIDescriptor> = {
  mastra_workspace_read_file: {
    icon: FileTextIcon,
    labelKey: "read_file",
    summarize: (input, output) => ({
      files: pathFiles(input),
      chips: [lineRange(input), asStr(asRecord(output)?.mediaType)].filter((v): v is string =>
        Boolean(v),
      ),
    }),
    detail: ({ input, output }) => {
      if (asRecord(output)?.__workspaceMedia) return <MediaNote />;
      const text = outputText(output);
      const path = pickStr(input, "path");
      return text ? <CodeFile code={capped(text)} filename={path} language={langOf(path)} /> : null;
    },
  },
  mastra_workspace_write_file: {
    icon: FilePlus2Icon,
    labelKey: "write_file",
    summarize: (input) => ({ files: pathFiles(input) }),
    detail: ({ input }) => {
      const content = asStr(input.content);
      const path = pickStr(input, "path");
      return content ? (
        <CodeFile code={capped(content)} filename={path} language={langOf(path)} />
      ) : null;
    },
  },
  mastra_workspace_edit_file: {
    icon: FilePenLineIcon,
    labelKey: "edit_file",
    summarize: (input) => ({ files: pathFiles(input) }),
    detail: ({ input }) => (
      <PairDetail
        language={langOf(pickStr(input, "path"))}
        newText={asStr(input.newString)}
        oldText={asStr(input.oldString)}
      />
    ),
  },
  mastra_workspace_delete: {
    icon: Trash2Icon,
    labelKey: "delete_file",
    summarize: (input) => ({
      files: pathFiles(input),
      chips: [input.recursive === true ? "recursive" : undefined].filter((v): v is string =>
        Boolean(v),
      ),
    }),
    detail: ({ output }) => {
      const text = outputText(output);
      return text ? <TextNote text={text} /> : null;
    },
  },
  mastra_workspace_file_stat: {
    icon: FileSearchIcon,
    labelKey: "file_stat",
    summarize: (input) => ({ files: pathFiles(input) }),
    detail: ({ output }) => recordDetail(output),
  },
  mastra_workspace_mkdir: {
    icon: FolderPlusIcon,
    labelKey: "mkdir",
    summarize: (input) => ({ files: pathFiles(input) }),
    detail: ({ output }) => {
      const text = outputText(output);
      return text ? <TextNote text={text} /> : null;
    },
  },
  mastra_workspace_list_files: {
    icon: FolderTreeIcon,
    labelKey: "list_files",
    summarize: (input) => ({ files: pathFiles(input) }),
    detail: ({ output }) => {
      const text = outputText(output);
      return text ? <TextDetail text={text} /> : null;
    },
  },
  mastra_workspace_grep: {
    icon: TextSearchIcon,
    labelKey: "grep",
    summarize: (input) => ({
      chips: queryChips(input, "pattern"),
      files: pathFiles(input, "path"),
    }),
    detail: ({ output }) => {
      const text = outputText(output);
      return text ? <TextDetail text={text} /> : null;
    },
  },
  mastra_workspace_ast_edit: {
    icon: FilePenLineIcon,
    labelKey: "ast_edit",
    summarize: (input) => ({
      files: pathFiles(input),
      chips: [pickStr(input, "transform"), pickStr(input, "pattern")].filter((v): v is string =>
        Boolean(v),
      ),
    }),
    detail: ({ output }) => {
      const text = outputText(output);
      return text ? <TextNote text={text} /> : null;
    },
  },
  mastra_workspace_search: {
    icon: FileSearchIcon,
    labelKey: "workspace_search",
    summarize: (input) => ({ chips: queryChips(input) }),
    detail: ({ output }) => {
      const text = outputText(output);
      return text ? <TextDetail text={text} /> : null;
    },
  },
  mastra_workspace_index: {
    icon: DatabaseIcon,
    labelKey: "workspace_index",
    summarize: (input) => ({ files: pathFiles(input) }),
    detail: ({ output }) => {
      const text = outputText(output);
      return text ? <TextNote text={text} /> : null;
    },
  },
  mastra_workspace_get_process_output: {
    icon: TerminalIcon,
    labelKey: "process_output",
    summarize: (input) => ({ chips: queryChips(input, "pid") }),
    detail: ({ output }) => {
      const text = outputText(output);
      return text ? <TextDetail text={text} /> : null;
    },
  },
  mastra_workspace_kill_process: {
    icon: CircleStopIcon,
    labelKey: "kill_process",
    summarize: (input) => ({ chips: queryChips(input, "pid") }),
    detail: ({ output }) => {
      const text = outputText(output);
      return text ? <TextNote text={text} /> : null;
    },
  },
  mastra_workspace_lsp_inspect: {
    icon: StethoscopeIcon,
    labelKey: "lsp_inspect",
    summarize: (input) => ({
      files: pathFiles(input, "path", "filePath"),
      chips: [typeof input.line === "number" ? `L${input.line}` : undefined].filter(
        (v): v is string => Boolean(v),
      ),
    }),
    detail: ({ output }) => {
      const record = asRecord(output) ?? {};
      const diagnostics = Array.isArray(record.diagnostics) ? record.diagnostics : [];
      const hover = asStr(asRecord(record.hover)?.value);
      const locations = (field: string): string[] => {
        const list = Array.isArray(record[field]) ? record[field] : [];
        return (list as unknown[])
          .map((item) => asStr(asRecord(item)?.location) ?? asStr(asRecord(item)?.preview))
          .filter((v): v is string => Boolean(v));
      };
      const definitions = locations("definition");
      const implementations = locations("implementations");
      if (
        diagnostics.length === 0 &&
        !hover &&
        definitions.length === 0 &&
        implementations.length === 0
      ) {
        return null;
      }
      return (
        <div className="space-y-1">
          {hover ? (
            <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{hover}</p>
          ) : null}
          {diagnostics.slice(0, 8).map((item, index) => {
            const message = asStr(asRecord(item)?.message);
            if (!message) return null;
            const severity = asStr(asRecord(item)?.severity) ?? "info";
            return (
              <p className="text-xs [overflow-wrap:anywhere]" key={index}>
                <span
                  className={
                    severity === "error"
                      ? "text-destructive"
                      : severity === "warning"
                        ? "text-amber-600"
                        : "text-muted-foreground"
                  }
                >
                  {severity === "error" ? "✗" : severity === "warning" ? "⚠" : "·"}
                </span>{" "}
                {message}
              </p>
            );
          })}
          {definitions.length > 0 ? (
            <p className="truncate text-primary text-xs" title={definitions[0]}>
              → {definitions[0]}
            </p>
          ) : null}
          {implementations.slice(0, 4).map((location) => (
            <p className="truncate text-muted-foreground text-xs" key={location} title={location}>
              ⇒ {location}
            </p>
          ))}
        </div>
      );
    },
  },
};

// --- 浏览器工具 -------------------------------------------------------------

const browserUIs: Record<string, ToolUIDescriptor> = {
  browser_goto: {
    icon: GlobeIcon,
    labelKey: "browser_goto",
    summarize: (input) => ({ chips: [cap(pickStr(input, "url") ?? "", 80)].filter(Boolean) }),
    detail: browserDetail,
  },
  browser_snapshot: {
    icon: AppWindowIcon,
    labelKey: "browser_snapshot",
    detail: ({ output }) => {
      const record = asRecord(output);
      const tree = asStr(record?.snapshot);
      if (!record || !tree) return null;
      return (
        <div className="space-y-1">
          <BrowserResultDetail
            extra={
              <RecordDetail fields={["url", "title", "elementCount", "scroll"]} output={record} />
            }
            output={record}
          />
          <CodeFile code={capped(tree)} language="log" />
        </div>
      );
    },
  },
  browser_click: {
    icon: MousePointerClickIcon,
    labelKey: "browser_click",
    summarize: (input) => ({
      chips: [pickStr(input, "ref"), pickStr(input, "button")].filter((v): v is string =>
        Boolean(v),
      ),
    }),
    detail: browserDetail,
  },
  browser_type: {
    icon: KeyboardIcon,
    labelKey: "browser_type",
    summarize: (input) => ({
      chips: [pickStr(input, "ref"), cap(pickStr(input, "text") ?? "", 40)].filter(
        (v): v is string => Boolean(v),
      ),
    }),
    detail: browserDetail,
  },
  browser_press: {
    icon: KeyboardIcon,
    labelKey: "browser_press",
    summarize: (input) => {
      const combo = [...((input.modifiers as string[] | undefined) ?? []), asStr(input.key) ?? ""]
        .join("+")
        .replace(/\+$/, "");
      return { chips: combo ? [combo] : [] };
    },
    detail: browserDetail,
  },
  browser_select: {
    icon: ListChecksIcon,
    labelKey: "browser_select",
    summarize: (input) => ({
      chips: [
        pickStr(input, "ref"),
        pickStr(input, "value", "label") ??
          (typeof input.index === "number" ? `#${input.index}` : undefined),
      ].filter((v): v is string => Boolean(v)),
    }),
    detail: browserDetail,
  },
  browser_scroll: {
    icon: ArrowUpDownIcon,
    labelKey: "browser_scroll",
    summarize: (input) => ({
      chips: [
        [
          pickStr(input, "direction"),
          typeof input.amount === "number" ? String(input.amount) : undefined,
        ]
          .filter((v): v is string => Boolean(v))
          .join(" ") || undefined,
      ].filter((v): v is string => Boolean(v)),
    }),
    detail: browserDetail,
  },
  browser_hover: {
    icon: MousePointer2Icon,
    labelKey: "browser_hover",
    summarize: (input) => ({ chips: queryChips(input, "ref") }),
    detail: browserDetail,
  },
  browser_back: {
    icon: ArrowLeftIcon,
    labelKey: "browser_back",
    detail: browserDetail,
  },
  browser_wait: {
    icon: ClockIcon,
    labelKey: "browser_wait",
    summarize: (input) => ({
      chips: [
        pickStr(input, "ref", "state") ??
          (typeof input.timeout === "number" ? `${input.timeout}ms` : undefined),
      ].filter((v): v is string => Boolean(v)),
    }),
    detail: browserDetail,
  },
  browser_tabs: {
    icon: AppWindowIcon,
    labelKey: "browser_tabs",
    summarize: (input) => ({
      chips: [
        pickStr(input, "action"),
        typeof input.index === "number" ? `#${input.index}` : undefined,
        cap(pickStr(input, "url") ?? "", 60) || undefined,
      ].filter((v): v is string => Boolean(v)),
    }),
    detail: browserTabsDetail,
  },
  browser_drag: {
    icon: MoveIcon,
    labelKey: "browser_drag",
    summarize: (input) => ({
      chips: [
        [
          pickStr(input, "sourceRef", "sourceSelector"),
          pickStr(input, "targetRef", "targetSelector"),
        ]
          .filter((v): v is string => Boolean(v))
          .join(" → "),
      ].filter(Boolean),
    }),
    detail: browserDetail,
  },
  browser_screenshot: {
    icon: CameraIcon,
    labelKey: "browser_screenshot",
    // 截图原图归档为用户内容对象(contentObject 引用带取回路由所需字段),内联展示
    detail: ({ output }) => {
      const contentObject = asRecord(asRecord(output)?.contentObject);
      return contentObject ? <ScreenshotDetail contentObject={contentObject} /> : null;
    },
  },
  browser_evaluate: {
    icon: CodeXmlIcon,
    labelKey: "browser_evaluate",
    detail: ({ input, output }) => {
      const script = asStr(input.script);
      const result = asRecord(output)?.result;
      const resultText =
        result === undefined
          ? undefined
          : typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2);
      if (!script && !resultText) return null;
      return (
        <div className="space-y-1">
          {script ? (
            <CodeFile code={capped(script)} filename="evaluate.js" language="javascript" />
          ) : null}
          {resultText ? <TextDetail text={capped(resultText)} /> : null}
          {asStr(asRecord(output)?.hint) ? (
            <p className="text-muted-foreground/70 text-xs">{asStr(asRecord(output)?.hint)}</p>
          ) : null}
        </div>
      );
    },
  },
};

// --- 联网检索 / 资料库 / 信号 / 技能 ----------------------------------------

const webUIs: Record<string, ToolUIDescriptor> = {
  web_fetch: {
    icon: FileDownIcon,
    labelKey: "web_fetch",
    summarize: (input, output) => ({
      chips: [cap(pickStr(input, "url") ?? "", 80)].filter(Boolean),
      files: [asStr(asRecord(output)?.workspacePath)].filter((v): v is string => Boolean(v)),
    }),
    detail: ({ output }) => {
      const text = pickStr(asRecord(output) ?? {}, "content", "summary");
      return text ? (
        <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{cap(text, 2000)}</p>
      ) : null;
    },
  },
  tavily_search: {
    icon: SearchIcon,
    labelKey: "tavily_search",
    summarize: (input) => ({ chips: queryChips(input) }),
    detail: resultsDetail,
  },
  tavily_extract: {
    icon: FileDownIcon,
    labelKey: "tavily_extract",
    detail: resultsDetail,
  },
  firecrawl_search: {
    icon: SearchIcon,
    labelKey: "firecrawl_search",
    summarize: (input) => ({ chips: queryChips(input) }),
    detail: resultsDetail,
  },
  firecrawl_scrape: {
    icon: FileDownIcon,
    labelKey: "firecrawl_scrape",
    summarize: (input, output) => ({
      chips: [cap(pickStr(input, "url") ?? "", 80)].filter(Boolean),
      files: [asStr(asRecord(output)?.workspacePath)].filter((v): v is string => Boolean(v)),
    }),
    detail: ({ output }) => {
      const markdown = pickStr(asRecord(output) ?? {}, "markdown", "summary", "content");
      return markdown ? <CodeFile code={capped(markdown)} language="markdown" /> : null;
    },
  },
  library_vector_search: {
    icon: LibraryBigIcon,
    labelKey: "library_vector_search",
    summarize: (input) => ({ chips: queryChips(input) }),
    detail: resultsDetail,
  },
  library_graph_search: {
    icon: NetworkIcon,
    labelKey: "library_graph_search",
    summarize: (input) => ({ chips: queryChips(input) }),
    detail: resultsDetail,
  },
  library_document_chunker: {
    icon: ScissorsIcon,
    labelKey: "library_chunker",
    summarize: (input) => ({
      chips: [
        pickStr(input, "strategy"),
        typeof input.chunkSize === "number" ? `size=${input.chunkSize}` : undefined,
      ].filter((v): v is string => Boolean(v)),
    }),
    detail: chunkDetail,
  },
};

const miscUIs: Record<string, ToolUIDescriptor> = {
  signal_subscribe: {
    icon: RadioIcon,
    labelKey: "signal_subscribe",
    summarize: (input) => ({
      chips: [
        pickStr(input, "provider"),
        pickStr(input, "externalResourceId"),
        cap(pickStr(input, "pollUrl") ?? "", 60) || undefined,
      ].filter((v): v is string => Boolean(v)),
    }),
    detail: ({ output }) => recordDetail(output),
  },
  signal_unsubscribe: {
    icon: RadioIcon,
    labelKey: "signal_unsubscribe",
    summarize: (input) => ({
      chips: [pickStr(input, "provider"), pickStr(input, "externalResourceId")].filter(
        (v): v is string => Boolean(v),
      ),
    }),
    detail: ({ output }) => recordDetail(output),
  },
  signal_list_subscriptions: {
    icon: RadioIcon,
    labelKey: "signal_list",
    summarize: (input) => ({ chips: queryChips(input, "provider") }),
    detail: recordsDetailFor("subscriptions"),
  },
  notification_inbox: {
    icon: InboxIcon,
    labelKey: "notification_inbox",
    summarize: (input) => ({ chips: queryChips(input, "action") }),
    detail: recordsDetailFor("notifications"),
  },
  skill: {
    icon: BookMarkedIcon,
    labelKey: "skill",
    summarize: (input) => ({ chips: queryChips(input, "name") }),
    detail: ({ output }) => {
      const text = outputText(output);
      return text ? <TextNote text={text} /> : null;
    },
  },
  skill_search: {
    icon: SearchIcon,
    labelKey: "skill_search",
    summarize: (input) => ({
      chips: [
        pickStr(input, "query"),
        typeof input.topK === "number" ? `top ${input.topK}` : undefined,
      ].filter((v): v is string => Boolean(v)),
    }),
    detail: ({ output }) => {
      const text = outputText(output);
      return text ? <TextDetail text={text} /> : null;
    },
  },
  skill_read: {
    icon: BookOpenIcon,
    labelKey: "skill_read",
    summarize: (input) => ({
      files: pathFiles(input, "path"),
      chips: [
        pickStr(input, "skillName"),
        typeof input.startLine === "number" && typeof input.endLine === "number"
          ? `L${input.startLine}–${input.endLine}`
          : undefined,
      ].filter((v): v is string => Boolean(v)),
    }),
    detail: ({ input, output }) => {
      const text = outputText(output);
      const path = pickStr(input, "path");
      return text ? <CodeFile code={capped(text)} filename={path} language={langOf(path)} /> : null;
    },
  },
  "workflow-teamWorkflow": {
    icon: WorkflowIcon,
    labelKey: "team_workflow",
    detail: ({ output }) => recordDetail(output),
  },
};

/** 逐字注册表未命中时按前缀兜底;详情统一走 RecordDetail(非对象输出回退通用 JSON) */
const PREFIX_UIS: Array<{ prefix: string; descriptor: ToolUIDescriptor }> = [
  {
    prefix: "mastra_workspace_computer_",
    descriptor: {
      icon: MonitorIcon,
      labelKey: "computer",
      detail: ({ output }) => <RecordDetail output={output} />,
    },
  },
  {
    prefix: "anysearch_",
    descriptor: {
      icon: SearchIcon,
      labelKey: "anysearch",
      summarize: (input) => ({ chips: queryChips(input) }),
      detail: ({ output }) => recordDetail(output),
    },
  },
  {
    prefix: "workflow-",
    descriptor: {
      icon: WorkflowIcon,
      labelKey: "workflow",
      summarize: (_input, _output, name) => ({ chips: [name.slice("workflow-".length)] }),
      detail: ({ output }) => recordDetail(output),
    },
  },
  {
    prefix: "mcp_",
    descriptor: {
      icon: PlugIcon,
      labelKey: "mcp",
      // mcp_<serverId>_<toolName> 的 serverId 自身可含下划线,不拆分,整段展示
      summarize: (_input, _output, name) => ({ chips: [name.slice("mcp_".length)] }),
      detail: ({ output }) => recordDetail(output),
    },
  },
];

const EXACT_UIS: Record<string, ToolUIDescriptor> = {
  ...workspaceUIs,
  ...browserUIs,
  ...webUIs,
  ...miscUIs,
};

export function getToolUI(name: string): ToolUIDescriptor | undefined {
  const exact = EXACT_UIS[name];
  if (exact) return exact;
  return PREFIX_UIS.find((entry) => name.startsWith(entry.prefix))?.descriptor;
}
