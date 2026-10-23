"use client";

import { CheckIcon, CircleDashedIcon, FileCodeIcon, FlaskConicalIcon, XIcon } from "lucide-react";
import { useTranslation } from "@/shared/i18n";
import { cn } from "@/shared/lib";
import { CodeBlock, CodeBlockContent } from "@/shared/ui/code-block";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/shared/ui/trace";

// ---------------------------------------------------------------------------
// Test Results pattern(官方 docs/examples/test-results.mdx):
// 一次测试运行是一行 Trace,展开后按套件分组,失败用例自带错误输出。
// 官方数据源是工具的 suites/tests 结构化输出;本项目 agent 通过
// execute_command 跑测试,因此由 parseTestOutput 把常见 runner 的文本
// 输出还原成同一结构,解析不出时调用方回退到 Terminal。
// ---------------------------------------------------------------------------

export type TestStatus = "passed" | "failed" | "skipped";

export interface TestCase {
  name: string;
  status: TestStatus;
  error?: string;
}

export interface TestSuite {
  name: string;
  tests: TestCase[];
}

export interface TestRun {
  suites: TestSuite[];
  /** runner 汇总行里的总数;缺失时按用例数统计 */
  total?: number;
  failed?: number;
  skipped?: number;
}

const PASS_MARKS = ["✓", "✔", "√"];
const FAIL_MARKS = ["×", "✗", "✘", "✕"];
const SKIP_MARKS = ["↓", "○", "-"];

/**
 * 解析 vitest / jest 风格的逐用例行与套件行:
 *   ✓ lib/ai.test.ts (6 tests) 41ms
 *   ✓ creates a user 12ms
 *   × updates a profile 8ms
 * 汇总行(Test Files / Tests / Suites)用于校准总数。
 * 解析不出任何套件时返回 null,由调用方回退到 Terminal。
 */
export function parseTestOutput(output: string): TestRun | null {
  const lines = output.replace(/\r\n?/g, "\n").split("\n");
  const suites: TestSuite[] = [];
  let current: TestSuite | null = null;

  const markOf = (line: string): { status: TestStatus; rest: string } | null => {
    const trimmed = line.trim();
    for (const [marks, status] of [
      [PASS_MARKS, "passed"],
      [FAIL_MARKS, "failed"],
      [SKIP_MARKS, "skipped"],
    ] as const) {
      const mark = marks.find((candidate) => trimmed.startsWith(candidate));
      if (mark) return { status, rest: trimmed.slice(mark.length).trim() };
    }
    return null;
  };

  for (const line of lines) {
    const mark = markOf(line);
    if (!mark) continue;
    const { status, rest } = mark;
    if (!rest) continue;
    // 套件行带文件扩展名或 "(N tests)";用例行是普通描述。
    const isSuite =
      /\.(?:[cm]?[jt]sx?|py|rs|go|rb|java|kt|cs)\b/.test(rest) || /\(\d+ tests?\)/.test(rest);
    if (isSuite) {
      const name = rest
        .replace(/\s*\(\d+ tests?\)\s*/, " ")
        .replace(/\s+\d+(?:\.\d+)?\s*m?s\s*$/, "")
        .trim();
      if (!name) continue;
      current = { name, tests: [] };
      suites.push(current);
      continue;
    }
    if (!current) continue;
    const name = rest.replace(/\s+\d+(?:\.\d+)?\s*m?s\s*$/, "").trim();
    if (name) current.tests.push({ name, status });
  }

  if (suites.length === 0) return null;

  // 汇总行只在 runner 明确给出时采用,避免覆盖逐用例统计。
  const summary =
    /Tests?\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?\s*\((\d+)\)/.exec(
      output,
    );
  const run: TestRun = { suites };
  if (summary) {
    run.failed = summary[1] ? Number(summary[1]) : 0;
    run.skipped = summary[3] ? Number(summary[3]) : 0;
    run.total = Number(summary[4]);
  }
  return run;
}

function countTests(tests: TestCase[]) {
  return {
    total: tests.length,
    failed: tests.filter((test) => test.status === "failed").length,
    skipped: tests.filter((test) => test.status === "skipped").length,
  };
}

function formatCounts(counts: ReturnType<typeof countTests>, t: TranslationFn): string {
  return [
    t("chat:trace.testCount", { count: counts.total }),
    counts.failed > 0 ? t("chat:trace.testFailedCount", { count: counts.failed }) : "",
    counts.skipped > 0 ? t("chat:trace.testSkippedCount", { count: counts.skipped }) : "",
  ]
    .filter(Boolean)
    .join(t("chat:trace.comma"));
}

type TranslationFn = (key: string, options?: Record<string, unknown>) => string;

function TestRow({ test, t }: { test: TestCase; t: TranslationFn }) {
  if (test.status === "failed") {
    return (
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine status="error">
            <TraceIcon>
              <XIcon />
            </TraceIcon>
            <TraceTitle>{test.name}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <CodeBlock size="sm" variant="destructive">
            <CodeBlockContent wrap className="max-h-64">
              {test.error ?? ""}
            </CodeBlockContent>
          </CodeBlock>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  }

  return (
    <TraceLine>
      <TraceIcon>{test.status === "skipped" ? <CircleDashedIcon /> : <CheckIcon />}</TraceIcon>
      <TraceTitle>
        {test.status === "skipped" ? t("chat:trace.testSkipped", { name: test.name }) : test.name}
      </TraceTitle>
    </TraceLine>
  );
}

export function TestResults({
  run,
  isStreaming,
  className,
}: {
  run: TestRun;
  isStreaming?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const summary = countTests(run.suites.flatMap((suite) => suite.tests));
  const total = run.total ?? summary.total;
  const failed = run.failed ?? summary.failed;
  const skipped = run.skipped ?? summary.skipped;
  const counts = { total, failed, skipped };

  return (
    <Trace className={cn("min-w-0 max-w-full", className)}>
      <TraceCollapsible defaultOpen={failed > 0} className="w-full">
        <TraceCollapsibleTrigger className="w-full items-start">
          <TraceLine
            className="w-full items-start"
            status={isStreaming ? "running" : failed > 0 ? "error" : undefined}
          >
            <TraceIcon className="mt-0.5">
              <FlaskConicalIcon className="size-3.5" />
            </TraceIcon>
            <TraceTitle className="flex-1 whitespace-normal">
              {t("chat:trace.testRan", { summary: formatCounts(counts, t) })}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {run.suites.map((suite) => {
              const suiteCounts = countTests(suite.tests);
              return (
                <TraceCollapsible key={suite.name} defaultOpen={suiteCounts.failed > 0}>
                  <TraceCollapsibleTrigger>
                    <TraceLine status={suiteCounts.failed > 0 ? "error" : undefined}>
                      <TraceIcon>
                        <FileCodeIcon />
                      </TraceIcon>
                      <TraceTitle>
                        {suite.name}, {formatCounts(suiteCounts, t)}
                      </TraceTitle>
                    </TraceLine>
                  </TraceCollapsibleTrigger>
                  <TraceCollapsibleContent>
                    <Trace>
                      {suite.tests.map((test) => (
                        <TestRow key={`${suite.name}:${test.name}`} test={test} t={t} />
                      ))}
                    </Trace>
                  </TraceCollapsibleContent>
                </TraceCollapsible>
              );
            })}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
