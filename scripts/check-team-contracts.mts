// Manual check: node --experimental-strip-types scripts/check-team-contracts.mts
// Deliberately not part of format/lint/typecheck; no application or model is started.
import assert from "node:assert/strict";
import {
  composeAgentInstructions,
  DEFAULT_WORK_INSTRUCTIONS,
} from "../src/mastra/agents/agent-instructions.ts";
import {
  PERMISSION_RULES_CONTEXT_KEY,
  parsePermissionRules,
  requestToolApproval,
  resolveAgentActiveTools,
  resolveMode,
  resolveRequestMode,
  SESSION_TOOL_POLICY_CONTEXT_KEY,
} from "../src/mastra/agents/permissions.ts";
import {
  buildDisplayMessages,
  withHandoffMessages,
} from "../src/renderer/src/widgets/chat-panel/lib/display.ts";
import type { WorkUIMessage } from "../src/renderer/src/widgets/chat-panel/model/types.ts";
import {
  type AgentProfile,
  agentMemberSchema,
  agentWorkflowSchema,
  DEFAULT_AGENT_PROFILE_ID,
  delegationMemberIds,
  validateAgentTeam,
} from "../src/shared/agent-contract.ts";

const members = ["reviewer", "reviewer_2"].map((id) =>
  agentMemberSchema.parse({
    id,
    name: "Same name",
    instructions: "Implement the requested changes",
  }),
);
const handoff = {
  type: "team" as const,
  members,
  workflow: agentWorkflowSchema.parse({
    strategy: "handoff",
    entryMemberId: "reviewer",
    steps: [],
  }),
};
assert.doesNotThrow(() => validateAgentTeam(handoff));
assert.throws(() =>
  validateAgentTeam({ ...handoff, workflow: { ...handoff.workflow, entryMemberId: "missing" } }),
);
assert.throws(() => validateAgentTeam({ ...handoff, members: [members[0]] }));
assert.throws(() =>
  validateAgentTeam({
    ...handoff,
    members: [{ ...members[0], delegates: [members[1].id] }, members[1]],
  }),
);
assert.throws(() =>
  validateAgentTeam({ ...handoff, workflow: { ...handoff.workflow, strategy: "supervisor" } }),
);
const council = {
  ...handoff,
  workflow: agentWorkflowSchema.parse({
    strategy: "workflow",
    steps: [
      {
        id: "council",
        kind: "council",
        memberIds: members.map((member) => member.id),
        judgeMemberId: "reviewer",
      },
    ],
  }),
};
assert.doesNotThrow(() => validateAgentTeam(council));
assert.throws(() =>
  validateAgentTeam({
    ...council,
    members: [
      { ...members[0], delegates: [members[1].id] },
      { ...members[1], delegates: [members[0].id] },
    ],
  }),
);
assert.throws(() =>
  validateAgentTeam({
    ...council,
    workflow: agentWorkflowSchema.parse({
      strategy: "workflow",
      steps: [
        {
          id: "council",
          kind: "council",
          memberIds: ["reviewer", "reviewer"],
          judgeMemberId: "reviewer_2",
        },
      ],
    }),
  }),
);

const first: WorkUIMessage = {
  id: "first",
  role: "assistant",
  metadata: { createdAt: "2026-10-07T00:00:00Z", teamMemberId: "reviewer", agentProfileId: "team" },
  parts: [{ type: "text", text: "First specialist" }],
};
const second: WorkUIMessage = {
  id: "second",
  role: "assistant",
  metadata: {
    createdAt: "2026-10-07T00:02:00Z",
    teamMemberId: "reviewer_2",
    agentProfileId: "team",
  },
  parts: [{ type: "text", text: "Second specialist" }],
};
const transfer = {
  id: 1,
  profileId: "team",
  fromMemberId: "reviewer",
  toMemberId: "reviewer_2",
  reason: "Needs another specialty",
  context: "Evidence collected",
  createdAt: "2026-10-07T00:01:00Z",
};
const display = buildDisplayMessages(withHandoffMessages([first, second], [transfer]));
assert.deepEqual(
  display.map((entry) => entry.message.id),
  ["first", "handoff-1", "second"],
);
assert.equal(new Set(display.map((entry) => entry.key)).size, 3);
assert.equal(buildDisplayMessages([first, second]).length, 2);
const differentTeam = buildDisplayMessages([
  first,
  { ...first, id: "other-team", metadata: { ...first.metadata, agentProfileId: "other-team" } },
]);
assert.equal(differentTeam.length, 2);
assert.equal(new Set(differentTeam.map((entry) => entry.key)).size, 2);
const repeated = buildDisplayMessages([first, { ...first, id: "first-next" }]);
assert.equal(repeated.length, 1);
assert.equal(repeated[0].message.parts.length, 2);
assert.equal(first.parts.length, 1, "Rendering must not mutate source history");
const pending = buildDisplayMessages(withHandoffMessages([first], [transfer]), true);
assert.equal(pending.at(-1)?.sourceIds.length, 0);
assert.equal(pending.at(-1)?.message.metadata?.handoff, undefined);
const customAgent: AgentProfile = {
  id: "custom-author",
  type: "agent",
  name: "Author",
  displayName: "Author",
  profession: "Writing",
  description: "Writes fiction",
  instructions: "AUTHOR_SYSTEM_INSTRUCTIONS: Write fiction in the requested style.",
  skills: [],
  members: [],
  tags: [],
  quickPrompts: [],
  enabled: true,
  createdAt: "2026-10-07",
  updatedAt: "2026-10-07",
};
const defaultInstructions = [DEFAULT_WORK_INSTRUCTIONS, "DEFAULT_CODING_PROMPT"];
const customPrompt = composeAgentInstructions({ profile: customAgent, defaultInstructions });
assert.equal(customPrompt[0], customAgent.instructions);
assert.ok(!customPrompt.join("\n").includes("DEFAULT_CODING_PROMPT"));
assert.ok(!customPrompt.join("\n").includes("You are MastraWork"));
assert.deepEqual(delegationMemberIds(customAgent), []);
const defaultAgent = { ...customAgent, id: DEFAULT_AGENT_PROFILE_ID };
assert.deepEqual(delegationMemberIds(defaultAgent), ["explorer", "reviewer"]);
assert.ok(
  composeAgentInstructions({ profile: defaultAgent, defaultInstructions }).includes(
    "DEFAULT_CODING_PROMPT",
  ),
);

const team: AgentProfile = {
  ...customAgent,
  id: "team",
  type: "team",
  members,
  instructions: "SUPERVISOR_ONLY_INSTRUCTIONS",
  workflow: agentWorkflowSchema.parse({ strategy: "supervisor", steps: [] }),
};
const memberPrompt = composeAgentInstructions({
  profile: team,
  member: members[0],
  defaultInstructions,
}).join("\n");
assert.ok(memberPrompt.includes(members[0].instructions));
assert.ok(!memberPrompt.includes(team.instructions));
assert.ok(!memberPrompt.includes("DEFAULT_CODING_PROMPT"));
const supervisorPrompt = composeAgentInstructions({ profile: team, defaultInstructions }).join(
  "\n",
);
assert.ok(supervisorPrompt.includes("agent-reviewer:"));
assert.ok(supervisorPrompt.includes("agent-reviewer_2:"));
assert.ok(!supervisorPrompt.includes("DEFAULT_CODING_PROMPT"));
assert.ok(supervisorPrompt.includes("Background task IDs are not process PIDs"));

// Delegation must use the parent policy even without a Controller stream consumer.
const approvalContext = { [PERMISSION_RULES_CONTEXT_KEY]: parsePermissionRules({}) };
for (const toolName of [
  "agent-reviewer",
  "mastra_workspace_read_file",
  "task_update",
  "mcp_server_tool",
  "computer_click",
]) {
  assert.equal(
    await requestToolApproval({ toolName, args: {}, requestContext: approvalContext }),
    false,
  );
}
const restrictedContext = {
  [PERMISSION_RULES_CONTEXT_KEY]: parsePermissionRules({
    categories: { read: "ask" },
    tools: { "agent-reviewer": "deny" },
  }),
};
assert.equal(
  await requestToolApproval({
    toolName: "mastra_workspace_read_file",
    args: {},
    requestContext: restrictedContext,
  }),
  true,
);
assert.equal(
  await requestToolApproval({
    toolName: "agent-reviewer",
    args: {},
    requestContext: restrictedContext,
  }),
  true,
);
// Live grants override the persisted category; another session must remain unaffected.
assert.equal(
  await requestToolApproval({
    toolName: "mastra_workspace_read_file",
    args: {},
    requestContext: {
      ...restrictedContext,
      [SESSION_TOOL_POLICY_CONTEXT_KEY]: () => "allow",
    },
  }),
  false,
);
assert.equal(
  await requestToolApproval({
    toolName: "mastra_workspace_read_file",
    args: {},
    requestContext: restrictedContext,
  }),
  true,
);

const tools = [
  "agent-reviewer",
  "agent-reviewer_2",
  "agent-reviewer_extra",
  "mastra_workspace_read_file",
  "mastra_workspace_write_file",
  "mastra_workspace_execute_command",
  "tavily_search",
  "ask_user",
];
const policy = {
  tools,
  mode: resolveMode("build"),
  rules: parsePermissionRules({}),
  profile: team,
  scheduled: false,
  readOnlyExpert: false,
};
assert.equal(
  resolveRequestMode({
    get: (key) => (key === "controller" ? { session: { modeId: "build" } } : "plan"),
  }).id,
  "build",
);
assert.deepEqual(resolveAgentActiveTools(policy), [
  "agent-reviewer",
  "agent-reviewer_2",
  "mastra_workspace_read_file",
  "ask_user",
]);
for (const modeId of ["plan", "review"]) {
  const exposed = resolveAgentActiveTools({
    ...policy,
    mode: resolveMode(modeId),
    activeTools: ["mastra_workspace_read_file", "ask_user"],
  });
  assert.ok(
    exposed.includes("agent-reviewer"),
    "A native mode allowlist must not hide configured delegates",
  );
  assert.ok(!exposed.includes("agent-reviewer_extra"));
  assert.ok(!exposed.includes("mastra_workspace_execute_command"));
  assert.ok(!exposed.includes("mastra_workspace_write_file"));
}
const denied = resolveAgentActiveTools({
  ...policy,
  rules: parsePermissionRules({ tools: { "agent-reviewer": "deny" } }),
});
assert.ok(!denied.includes("agent-reviewer"), "Delegation must not bypass per-tool denies");
const deniedCategory = resolveAgentActiveTools({
  ...policy,
  rules: parsePermissionRules({ categories: { other: "deny" } }),
});
assert.ok(!deniedCategory.includes("agent-reviewer_2"));
const workerBuild = resolveAgentActiveTools({ ...policy, member: members[0] });
assert.ok(
  !workerBuild.includes("agent-reviewer_extra"),
  "A stale toolset must not expose an unconfigured member",
);
assert.ok(
  workerBuild.includes("mastra_workspace_write_file"),
  "Members execute the task under their own mode and permissions",
);
const workerReview = resolveAgentActiveTools({
  ...policy,
  member: members[0],
  mode: resolveMode("review"),
});
assert.ok(!workerReview.includes("mastra_workspace_write_file"));
assert.ok(!workerReview.includes("mastra_workspace_execute_command"));
const builtInReadOnly = resolveAgentActiveTools({
  ...policy,
  profile: undefined,
  readOnlyExpert: true,
});
assert.ok(!builtInReadOnly.includes("mastra_workspace_write_file"));
console.log(
  "Team validation, identity isolation, delegation policy and handoff chronology passed.",
);
