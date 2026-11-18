import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isPersonalCapabilityTool, usedPersonalCapability } from "./usage.js";

const assistant = (name: string) => ({
  type: "message",
  id: `a-${name}`,
  timestamp: "2026-09-05T08:01:01.000Z",
  message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name, arguments: {} }], stopReason: "stop" },
}) as unknown as SessionEntry;

const user = (text: string) => ({
  type: "message",
  id: `u-${text.length}`,
  timestamp: "2026-09-05T08:01:01.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
}) as unknown as SessionEntry;

const SKILL_BLOCK = (name: string, location: string) =>
  `<skill name="${name}" location="${location}">\nReferences are relative to ${location}.\n\n正文\n</skill>`;

test("个人 MCP 工具名按 connector_my_ 前缀识别", () => {
  assert.equal(isPersonalCapabilityTool("connector_my_notion"), true);
  assert.equal(isPersonalCapabilityTool("connector_my_a-b_c"), true);
  // 企业配置的连接器不算个人能力
  assert.equal(isPersonalCapabilityTool("connector_notion"), false);
  assert.equal(isPersonalCapabilityTool("connector_my_"), false);
  assert.equal(isPersonalCapabilityTool("bash"), false);
});

test("用了成员自己装的 MCP 的运行被判为个人能力使用", () => {
  const owns = () => false;
  assert.equal(usedPersonalCapability([assistant("connector_my_notion")], owns), true);
  assert.equal(usedPersonalCapability([assistant("connector_notion")], owns), false);
  assert.equal(usedPersonalCapability([assistant("bash"), assistant("read")], owns), false);
});

test("用了本机导入技能的运行被判为个人能力使用，企业技能不算", () => {
  const owns = (location: string) => location === "/member/skills/weekly-report";
  assert.equal(usedPersonalCapability([user(SKILL_BLOCK("weekly-report", "/member/skills/weekly-report"))], owns), true);
  assert.equal(usedPersonalCapability([user(SKILL_BLOCK("doc-search", "/enterprise/skills/doc-search"))], owns), false);
  // 普通消息与空内容不误判
  assert.equal(usedPersonalCapability([user("帮我写个周报")], owns), false);
  assert.equal(usedPersonalCapability([], owns), false);
});

test("技能块带参数（skill 块后跟用户消息）也能识别", () => {
  const owns = (location: string) => location === "/member/skills/ppt";
  const text = `${SKILL_BLOCK("ppt", "/member/skills/ppt")}\n\n按这个模板做 10 页`;
  assert.equal(usedPersonalCapability([user(text)], owns), true);
});
