/** Official Controller modes shared by the workbench and agent request handlers. */
import type { AgentControllerMode } from "@mastra/core/agent-controller";
import { READ_ONLY_TOOL_NAMES } from "./permissions";

export type WorkModeId = "plan" | "build" | "review";

export type WorkMode = AgentControllerMode & {
  id: WorkModeId;
  name: string;
  /** 前端菜单里的一句话说明(与 src/renderer/src/lib/session-policy.ts 对应) */
  description: string;
  /** 叠加到 Agent instructions 之后的模式指令 */
  instructions: string;
};

const WORK_MODES: WorkMode[] = [
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
    availableTools: READ_ONLY_TOOL_NAMES,
    instructions: `MODE: REVIEW.
Inspect the current state of the workspace and report findings. You have no write or command-execution tools in this mode — do not claim to have changed anything.
Ground every finding in a file and line you actually read. Order findings by severity and state, for each one, the concrete input or state that would make it fail.
If a finding needs a change, describe the change; the user will switch to another mode to apply it.`,
  },
];

export function listWorkModes(): WorkMode[] {
  return WORK_MODES.map((mode) => ({ ...mode }));
}

export const DEFAULT_MODE_ID: WorkModeId =
  WORK_MODES.find((mode) => mode.metadata?.default)?.id ?? "plan";

/** chat 路由 → Agent 动态 instructions/tools 传递当前模式的 RequestContext key */
export const MODE_ID_CONTEXT_KEY = "mastra-work:mode-id";

/** 按 id 取模式;非法或缺失回落默认模式(因此路由层不必再校验 modeId) */
export function resolveMode(modeId: unknown): WorkMode {
  const found = WORK_MODES.find((mode) => mode.id === modeId);
  return found ?? WORK_MODES.find((mode) => mode.id === DEFAULT_MODE_ID) ?? WORK_MODES[0];
}
