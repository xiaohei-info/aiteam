import { describe, expect, it } from "vitest";
import { parseMcpConfig, suggestMcpRef } from "./mcp-config";

const CR = `"cr-test": {
  "type": "streamableHttp",
  "url": "https://mcp-test.cycplus.com/mcp/cr-test",
  "timeout": 30000
}`;

function servers(text: string) {
  const result = parseMcpConfig(text);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("parseMcpConfig", () => {
  it("reads the user's cr-test snippet without outer braces", () => {
    const { servers: [server], rejected } = servers(CR);
    expect(rejected).toEqual([]);
    expect(server).toMatchObject({ name: "cr-test", ref: "cr-test", refAdjusted: false, url: "https://mcp-test.cycplus.com/mcp/cr-test", timeout_ms: 30000, droppedSecret: false });
    expect(server!.auth).toBeUndefined();
  });

  it("accepts the four formats", () => {
    expect(servers(`{${CR}}`).servers[0]!.ref).toBe("cr-test");
    expect(servers(`${CR},`).servers[0]!.ref).toBe("cr-test");
    expect(servers(JSON.stringify({ mcpServers: { a: { type: "http", url: "https://a.example.com/mcp" }, b: { url: "https://b.example.com/mcp" } } })).servers.map((s) => s.ref)).toEqual(["a", "b"]);
    expect(servers(JSON.stringify({ servers: { c: { type: "streamable-http", url: "https://c.example.com/mcp" } } })).servers[0]!.ref).toBe("c");
    const unnamed = servers(JSON.stringify({ type: "streamableHttp", url: "https://mcp.example.com/mcp/notion" })).servers[0]!;
    expect(unnamed).toMatchObject({ name: "", ref: "notion", refAdjusted: false });
    const link = servers("https://mcp-test.cycplus.com/mcp/cr-test").servers[0]!;
    expect(link).toMatchObject({ name: "", ref: "cr-test", url: "https://mcp-test.cycplus.com/mcp/cr-test" });
  });

  it("rejects stdio, command and sse but keeps the usable ones", () => {
    const result = servers(JSON.stringify({ mcpServers: {
      local: { command: "npx", args: ["x"] },
      pipe: { type: "stdio" },
      events: { type: "sse", url: "https://e.example.com/sse" },
      nourl: { type: "http" },
      ok: { url: "https://ok.example.com/mcp" },
    } }));
    expect(result.servers.map((s) => s.ref)).toEqual(["ok"]);
    expect(result.rejected.map((r) => r.name)).toEqual(["local", "pipe", "events", "nourl"]);
    for (const item of result.rejected.slice(0, 3)) expect(item.reason).toContain("只支持 streamable HTTP");
    expect(parseMcpConfig(JSON.stringify({ command: "uvx" }))).toMatchObject({ ok: true, servers: [] });
  });

  it("turns token headers into bearer and drops the token value", () => {
    const text = JSON.stringify({ crm: { url: "https://crm.example.com/mcp", headers: { "X-API-Key": "super-secret-value", "X-Trace": "1" } } });
    const result = servers(text);
    expect(result.servers[0]).toMatchObject({ auth: "bearer", auth_header: "X-API-Key", droppedSecret: true, ignoredHeaders: ["X-Trace"] });
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    const bearer = servers(JSON.stringify({ x: { url: "https://x.example.com/mcp", headers: { Authorization: "Bearer abc123" } } })).servers[0]!;
    expect(bearer).toMatchObject({ auth: "bearer", auth_header: "", droppedSecret: true });
    expect(JSON.stringify(bearer)).not.toContain("abc123");
  });

  it("suggests a valid ref and converts seconds", () => {
    const item = servers(JSON.stringify({ "My CRM Server": { url: "https://crm.example.com/mcp", timeout: 60 } })).servers[0]!;
    expect(item).toMatchObject({ name: "My CRM Server", ref: "my-crm-server", refAdjusted: true });
    expect(item.timeout_ms).toBe(60000);
    expect(servers(JSON.stringify({ a: { url: "https://a.example.com/mcp", timeout: 999999 } })).servers[0]!.timeout_ms).toBe(300000);
    expect(suggestMcpRef("123 Tool")).toBe("mcp-123-tool");
    expect(suggestMcpRef("中文")).toBe("mcp");
  });

  it("explains what it cannot read", () => {
    expect(parseMcpConfig("")).toMatchObject({ ok: false });
    expect(parseMcpConfig("not json")).toMatchObject({ ok: false });
    expect(parseMcpConfig("ftp://x.example.com")).toMatchObject({ ok: false });
    expect(parseMcpConfig(JSON.stringify({ a: { url: "javascript:alert(1)" } }))).toMatchObject({ ok: true, servers: [], rejected: [{ name: "a" }] });
  });
});
