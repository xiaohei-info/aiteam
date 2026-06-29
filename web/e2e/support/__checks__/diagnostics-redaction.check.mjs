/**
 * P1-F7 Browser 端诊断脱敏纯逻辑自检（无需浏览器 / node_modules）。
 *
 * 跑法（node ≥ 22，TS type-strip）：
 *   node web/e2e/support/__checks__/diagnostics-redaction.check.mjs
 *
 * 锁住 closeout DAG §8：失败诊断不得输出 secret / 会话正文 / 文件正文 / 工具 I/O。
 * 失败即非零退出。Playwright 全链 artifact（report/trace/screenshot/video）由
 * playwright.config.ts + e2e/support/artifacts.ts 配置，需真实三端栈，归 BE2E-Artifact-DI 复核。
 */

import assert from "node:assert";
import {
  REDACTED,
  attachDiagnostics,
  buildFailureDiagnostics,
  captureProblemJson,
  redactDiagnostics,
  redactText,
  sanitizeUrl,
} from "../diagnostics.ts";

// 1. 敏感键脱敏（含 cookie / authorization / api_key 嵌套）。
const r = redactDiagnostics({
  tenant_id: "t1",
  authorization: "Bearer x",
  cookie: "s=1",
  nested: { api_key: "ak", ok: "v" },
});
assert.equal(r.tenant_id, "t1");
assert.equal(r.authorization, REDACTED);
assert.equal(r.cookie, REDACTED);
assert.equal(r.nested.api_key, REDACTED);
assert.equal(r.nested.ok, "v");

// 2. 会话 / 文件 / 工具内容键名整键丢弃。
const r2 = redactDiagnostics({
  messages: [{ content: "会话正文" }],
  tool_output: "x",
  file_content: "y",
  kept: 1,
});
assert.ok(!("messages" in r2));
assert.ok(!("tool_output" in r2));
assert.ok(!("file_content" in r2));
assert.equal(r2.kept, 1);

// 3. problem+json 只取定位字段。
assert.deepEqual(captureProblemJson(403, { type: "t", title: "Forbidden", detail: "会话正文", status: 403 }), {
  status: 403,
  problemJson: true,
  type: "t",
  title: "Forbidden",
});
assert.deepEqual(captureProblemJson(500, "<!doctype html>secret"), { status: 500, problemJson: false });

// 4. build + attach 都不泄露 secret / 会话正文。
const d = buildFailureDiagnostics({
  layer: "auth",
  summary: "x",
  context: { token: "sk-leak", messages: ["会话正文"], status: 401 },
});
const text = JSON.stringify(d);
assert.ok(!text.includes("sk-leak"), "secret leaked!");
assert.ok(!text.includes("会话正文"), "session content leaked!");
assert.equal(d.context.status, 401);

// 5. top-level url 泄露：query/hash 里的 token/session/code 必须被清洗（只留 origin+path）。
const dUrl = buildFailureDiagnostics({
  layer: "browser",
  summary: "auth callback failed",
  url: "https://example.test/callback?access_token=sk-url-token&session_id=sess-123#code=abc",
  context: { token: "ctx-secret" },
});
const urlText = JSON.stringify(dUrl);
assert.ok(!urlText.includes("sk-url-token"), "top-level url leaked access_token!");
assert.ok(!urlText.includes("sess-123"), "top-level url leaked session_id!");
assert.ok(!urlText.includes("code=abc"), "top-level url leaked code!");
assert.ok(!urlText.includes("ctx-secret"), "context secret leaked!");
assert.equal(dUrl.url, "https://example.test/callback");
assert.equal(sanitizeUrl("https://h.test/p?token=x#y"), "https://h.test/p");

// 6. top-level summary 泄露：Bearer / 敏感 key=value 字面量必须脱敏。
const dSum = buildFailureDiagnostics({
  layer: "auth",
  summary: "request denied: Bearer sk-live-998877 token=sk-sum-leak password=hunter2",
  context: {},
});
const sumText = JSON.stringify(dSum);
assert.ok(!sumText.includes("sk-live-998877"), "summary leaked bearer token!");
assert.ok(!sumText.includes("sk-sum-leak"), "summary leaked token literal!");
assert.ok(!sumText.includes("hunter2"), "summary leaked password literal!");
assert.equal(redactText("x Bearer abc.def y"), `x Bearer ${REDACTED} y`);

// 6b. reviewer 复审 targeted probe：Bearer 后任意非空白 token（含 `***` 占位）必须脱敏。
const probe = buildFailureDiagnostics({
  layer: "auth",
  summary: "request denied: Bearer *** token=sk-sum-leak password=hunter2",
  context: {},
});
const probeText = JSON.stringify(probe);
assert.ok(!probeText.includes("Bearer ***"), "Bearer *** survived redaction!");
assert.ok(!probeText.includes("***"), "summary still contains *** placeholder token!");
assert.ok(!probeText.includes("sk-sum-leak"), "summary leaked token=value!");
assert.ok(!probeText.includes("hunter2"), "summary leaked password=value!");
assert.equal(
  probe.summary,
  `request denied: Bearer ${REDACTED} token=${REDACTED} password=${REDACTED}`,
);
assert.equal(redactText("Bearer ***"), `Bearer ${REDACTED}`);

// 6c. cookie / session 键脱敏（Python↔TS 对齐）。
const dCookie = redactDiagnostics({ cookie: "sessionid=s3cr3t", session_id: "sess-1", ok: "v" });
assert.equal(dCookie.cookie, REDACTED);
assert.equal(dCookie.session_id, REDACTED);
assert.equal(dCookie.ok, "v");

// 7. attach 出口同样走整对象脱敏（url + summary + context）。
let attached = "";
await attachDiagnostics({ attach: async (_n, o) => { attached = String(o.body); } }, {
  layer: "browser",
  summary: "fail token=sk-attach-leak",
  url: "https://h.test/cb?access_token=sk-attach-url",
  context: { secret: "zzz" },
});
assert.ok(!attached.includes("zzz"), "attach leaked context secret!");
assert.ok(!attached.includes("sk-attach-leak"), "attach leaked summary token!");
assert.ok(!attached.includes("sk-attach-url"), "attach leaked url token!");

console.log("P1-F7 browser diagnostics no-leak checks PASSED");
