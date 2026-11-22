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
});

test("declared skill references are not advertised: <available_skills> is the only list of what is installed", () => {
  for (const skills of [[], ["csv-summary@1"]]) {
    const prompt = snapshotSystemPrompt(authorization({ persona: PERSONA, skills }));
    assert.ok(prompt.includes(ANSWER_FIRST_HINT));
    assert.doesNotMatch(prompt, /Authorized skill references|csv-summary/);
  }
});

test("the rule answers first, puts problems in a final note, and overrides persona steps that need a missing skill", () => {
  assert.match(ANSWER_FIRST_HINT, /answer the user's question first/);
  assert.match(ANSWER_FIRST_HINT, /Only skills listed in <available_skills> are installed/);
  assert.match(ANSWER_FIRST_HINT, /depend on a skill that is not installed/);
  assert.match(ANSWER_FIRST_HINT, /do not apply/);
  assert.match(ANSWER_FIRST_HINT, /do not stop/);
  // Scope: skills only. Tools and data sources keep the honest-failure behaviour.
  assert.match(ANSWER_FIRST_HINT, /missing skills only/);
  assert.doesNotMatch(ANSWER_FIRST_HINT, /data source[^.]*do not apply/);
  assert.match(ANSWER_FIRST_HINT, /final separate paragraph/);
  assert.match(HONEST_FAILURE_HINT, /final note of your reply/);
});

test("without authorization the anonymous prompt is unchanged", () => {
  assert.equal(snapshotSystemPrompt(undefined), "You are an AI Team digital employee. Be concise.");
});
