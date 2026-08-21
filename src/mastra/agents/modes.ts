import type { ToolsInput } from "@mastra/core/agent";
import { type PermissionRules, type ToolCategory, withCategoryPolicy } from "./permissions";

/**
 * 会话模式(plan → build → review):在 Agent 请求上下文上实现。
 *
 * 字段形状与工作台线程模式 API 保持稳定。
 * 模式定义包含 id / name / metadata.default / instructions /
 * additionalTools / availableTools / transitionsTo。模式指令是**叠加**在 Agent
 * 自身 instructions 之后的(官方 buildAgentMessageStreamOptions 里就是
 * `[agentInstructions, modeInstructions].join("\n")`),我们的动态 instructions 同理。
 *
 * 工具可用性由工作台 Agent 的动态 tools 配置负责。
 * 入口;我们改用 deniedCategories —— 模式把若干权限类别压成 deny,再由
 * permissions.ts 的同一套执行点落地(自己注入的工具不注入、工作区工具经
 * beforeToolCall 拒绝)。「模式收回工具」和「权限 deny」因此是同一个机制,不是两套。
 */

export type WorkModeId = "plan" | "build" | "review";

export interface WorkMode {
  id: WorkModeId;
  name: string;
  /** 前端菜单里的一句话说明(与 src/renderer/src/lib/session-policy.ts 对应) */
  description: string;
  metadata?: { default?: boolean };
  /** 叠加到 Agent instructions 之后的模式指令 */
  instructions: string;
  /** Tools layered into this mode in addition to the shared Agent tools. */
  additionalTools?: ToolsInput;
  /** Optional allow-list applied after the shared tool set is resolved. */
  availableTools?: string[];
  /** 该模式强制拒绝的权限类别(线程规则之上的叠加,用户无法在该模式下放开) */
  deniedCategories?: ToolCategory[];
  /** 计划获批后自动切换到的模式(官方 transitionsTo) */
  transitionsTo?: WorkModeId;
}

export const WORK_MODES: WorkMode[] = [
  {
    id: "plan",
    name: "计划",
    description: "先调研、写计划文件并提交审批,批准后自动切到执行",
    metadata: { default: true },
    transitionsTo: "build",
    instructions: `MODE: PLAN.
Investigate before proposing anything. Read the relevant files, run read-only checks, and ask the user with ask_user when a missing decision blocks reliable planning.
Do not carry out the work in this mode. Your deliverable is a plan, not a change.
Write the complete Markdown plan to a file under the plans/ directory of the workspace, then call submit_plan with that file path and wait for the user's decision. If the plan is rejected, revise the file and submit it again.
You may still edit or run things when it is strictly needed to investigate (for example writing the plan file itself), and every such call goes through the user's approval policy.`,
  },
  {
    id: "build",
    name: "执行",
    description: "执行已批准的计划,工具全量开放",
    instructions: `MODE: BUILD.
Carry out the approved plan. Keep the task list current with task_write / task_update / task_complete, with exactly one task in progress.
Prefer small verifiable steps: make a change, check it, then move to the next task. Report what you actually did, including anything you could not finish.
Do not silently widen the scope beyond the approved plan — if new work is required, say so and ask before doing it.`,
  },
  {
    id: "review",
    name: "复查",
    description: "只读复查已有变更并报告问题,写入与执行类工具被收回",
    deniedCategories: ["edit", "execute"],
    instructions: `MODE: REVIEW.
Inspect the current state of the workspace and report findings. You have no write or command-execution tools in this mode — do not claim to have changed anything.
Ground every finding in a file and line you actually read. Order findings by severity and state, for each one, the concrete input or state that would make it fail.
If a finding needs a change, describe the change; the user will switch to another mode to apply it.`,
  },
];

export const DEFAULT_MODE_ID: WorkModeId =
  WORK_MODES.find((mode) => mode.metadata?.default)?.id ?? "plan";

/** chat 路由 → Agent 动态 instructions/tools 传递当前模式的 RequestContext key */
export const MODE_ID_CONTEXT_KEY = "mastra-work:mode-id";

/** 按 id 取模式;非法或缺失回落默认模式(因此路由层不必再校验 modeId) */
export function resolveMode(modeId: unknown): WorkMode {
  const found = WORK_MODES.find((mode) => mode.id === modeId);
  return found ?? WORK_MODES.find((mode) => mode.id === DEFAULT_MODE_ID) ?? WORK_MODES[0];
}

/**
 * 线程规则叠加模式约束后的生效规则。
 * 模式的 deniedCategories 覆盖线程规则 —— review 模式下即使用户把 edit 设成 allow
 * 也依然拒绝,否则「只读复查」这个承诺就不成立。
 */
export function applyModeToRules(rules: PermissionRules, mode: WorkMode): PermissionRules {
  if (!mode.deniedCategories?.length) return rules;
  return mode.deniedCategories.reduce(
    (current, category) => withCategoryPolicy(current, category, "deny"),
    rules,
  );
}
