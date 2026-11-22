import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthorization } from "./pi/session-host.js";
import { ANSWER_FIRST_HINT, HONEST_FAILURE_HINT, snapshotSystemPrompt } from "./employee-prompt.js";

const PERSONA = "你是招聘专家。启动：被唤醒后第一动作加载 recruitment-dispatch 调度 skill；失败即停。";

function authorization(snapshot: Record<string, unknown>): SessionAuthorization {
  return { snapshot, permissionMode: "workspace-write" } as unknown as SessionAuthorization;
}

test("persona that names a skill the snapshot does not carry still gets the answer-first rule after the persona", () => {
  const prompt = snapshotSystemPrompt(authorization({ persona: PERSONA, skills: [], skill_refs: [] }));
  assert.ok(prompt.startsWith(PERSONA));
  assert.ok(prompt.includes(ANSWER_FIRST_HINT));
  assert.ok(prompt.indexOf(ANSWER_FIRST_HINT) > prompt.indexOf(PERSONA));
  assert.doesNotMatch(prompt, /Authorized skill references/);
});

test("the answer-first rule is present with bound skills too, next to their references", () => {
  const prompt = snapshotSystemPrompt(authorization({ persona: PERSONA, skills: ["csv-summary@1"] }));
  assert.ok(prompt.includes(ANSWER_FIRST_HINT));
  assert.ok(prompt.includes("Authorized skill references: csv-summary@1"));
});

test("the rule answers first, puts problems in a final note, and overrides persona steps that need a missing skill", () => {
  assert.match(ANSWER_FIRST_HINT, /answer the user's question first/);
  assert.match(ANSWER_FIRST_HINT, /Only skills listed in <available_skills> are installed/);
  assert.match(ANSWER_FIRST_HINT, /do not apply/);
  assert.match(ANSWER_FIRST_HINT, /do not stop/);
  assert.match(ANSWER_FIRST_HINT, /final separate paragraph/);
  assert.match(HONEST_FAILURE_HINT, /final note of your reply/);
});

test("without authorization the anonymous prompt is unchanged", () => {
  assert.equal(snapshotSystemPrompt(undefined), "You are an AI Team digital employee. Be concise.");
});
