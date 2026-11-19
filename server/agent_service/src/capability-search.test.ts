import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { capabilitySearchTool } from "./connectors.js";
import { createFixture } from "./test-fixture.js";

/** 只测 ClawHub 分支：GitHub 分支依赖外网，不在单测里打。 */
test("capability_search 把 ClawHub 候选整理成模型能判断的清单", async () => {
  const owner = { tenantId: "tenant-1", memberId: "member-1" };
const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/v1/search") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ results: [
        { slug: "self-improving-agent", description: "记录经验", downloads: 900, install: { reference: "alice/self-improving-agent" }, canonicalUrl: "https://clawhub.ai/alice/skills/self-improving-agent" },
        { slug: "weekly-report", description: "写周报", downloads: 12, install: { reference: "bob/weekly-report" } },
        { slug: "broken", description: "缺 install", downloads: 1 },
      ] }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const prev = process.env.AITEAM_CLAWHUB_BASE_URL;
  const address = server.address();
  assert(address && typeof address === "object");
  process.env.AITEAM_CLAWHUB_BASE_URL = `http://127.0.0.1:${address.port}`;
  const github = "http://127.0.0.1:1"; // 连不上 → GitHub 分支失败但不影响 ClawHub 结果
  const prevGithub = process.env.AITEAM_GITHUB_API_BASE_URL;
  process.env.AITEAM_GITHUB_API_BASE_URL = github;
  try {
    const fixture = await createFixture();
    const tool = capabilitySearchTool(fixture.store, owner);
    const run = (tool.execute as unknown as (id: string, p: unknown, s?: AbortSignal) => Promise<{ content?: { text: string }[] }>)("t", { query: "周报", source: "clawhub" });
    const result = await run;
    const text = result.content?.[0]?.text ?? "";
    assert.match(text, /weekly-report/);
    assert.match(text, /写周报/);
    assert.match(text, /https:\/\/clawhub\.ai\/bob\/skills\/weekly-report/);
    assert.doesNotMatch(text, /broken/, "缺 install.reference 的条目组不出地址，应跳过");
  } finally {
    if (prev === undefined) delete process.env.AITEAM_CLAWHUB_BASE_URL;
    else process.env.AITEAM_CLAWHUB_BASE_URL = prev;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("capability_search 搜不到时如实说，不编造", async () => {
  const owner = { tenantId: "tenant-1", memberId: "member-1" };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/v1/search") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ results: [] })); }
    if (url.pathname === "/search/repositories") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ items: [] })); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const prev = process.env.AITEAM_CLAWHUB_BASE_URL;
  process.env.AITEAM_CLAWHUB_BASE_URL = `http://127.0.0.1:${address.port}`;
  const prevGithub = process.env.AITEAM_GITHUB_API_BASE_URL;
  process.env.AITEAM_GITHUB_API_BASE_URL = `http://127.0.0.1:${address.port}`;
  try {
    const fixture = await createFixture();
    const tool = capabilitySearchTool(fixture.store, owner);
    const run = (tool.execute as unknown as (id: string, p: unknown, s?: AbortSignal) => Promise<{ content?: { text: string }[] }>)("t", { query: "不存在的东西", source: "clawhub" });
    assert.match((await run).content?.[0]?.text ?? "", /没找到/);
  } finally {
    if (prev === undefined) delete process.env.AITEAM_CLAWHUB_BASE_URL;
    else process.env.AITEAM_CLAWHUB_BASE_URL = prev;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
