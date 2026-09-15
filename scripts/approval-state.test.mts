import { strict as assert } from "node:assert";
import test from "node:test";
import {
  approvalResumeKey,
  isInteractionBusy,
} from "../src/renderer/src/widgets/chat-panel/model/approval-state.ts";

test("only the submitted approval card is busy", () => {
  const threadId = "thread-a";
  const firstInteraction = "run-a:tool-call-a";
  const secondInteraction = "run-a:tool-call-b";
  const busyKeys = new Set([approvalResumeKey(threadId, firstInteraction)]);

  assert.equal(isInteractionBusy(busyKeys, threadId, firstInteraction), true);
  assert.equal(isInteractionBusy(busyKeys, threadId, secondInteraction), false);
});

test("a busy approval does not lock another thread", () => {
  const interactionKey = "run-a:tool-call-a";
  const busyKeys = new Set([approvalResumeKey("thread-a", interactionKey)]);

  assert.equal(isInteractionBusy(busyKeys, "thread-b", interactionKey), false);
  assert.equal(isInteractionBusy(busyKeys, null, interactionKey), false);
});
