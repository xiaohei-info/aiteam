import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { McpServerDialog } from "./McpServerDialog";
import type { McpProbeInput, McpProbeResult, PlatformMcpServer, PlatformMcpServerInput } from "./types";

const CR = `"cr-test": {
  "type": "streamableHttp",
  "url": "https://mcp-test.cycplus.com/mcp/cr-test",
  "timeout": 30000
}`;

const probeResult = (extra: Partial<McpProbeResult>): McpProbeResult => ({
  status: "ok", auth: "none", tools: [], scopes_supported: [], scope: "", auth_host: "", dynamic_registration: false,
  server_name: "", token_rejected: false, detail: "", ...extra,
});

function setup(item: PlatformMcpServer | null = null, probe = vi.fn(async (_input: McpProbeInput) => probeResult({}))) {
  const onSave = vi.fn(async (_input: PlatformMcpServerInput) => undefined);
  const rendered = render(<McpServerDialog item={item} busy={false} onClose={() => undefined} onSave={onSave} probe={probe} />);
  return { onSave, probe, unmount: rendered.unmount };
}

describe("McpServerDialog", () => {
  it("粘贴用户给的 cr-test 配置，读取工具识别为浏览器登录，可留空工具名登记", async () => {
    const probe = vi.fn(async (_input: McpProbeInput) => probeResult({ status: "needs_oauth", auth: "oauth", auth_host: "mcp-test.cycplus.com", scope: "profile.read openid", dynamic_registration: true, detail: "需要登录" }));
    const { onSave } = setup(null, probe);
    fireEvent.change(screen.getByLabelText(/粘贴配置/), { target: { value: CR } });
    fireEvent.click(screen.getByRole("button", { name: "解析并填入" }));
    expect(screen.getByLabelText(/^标识/)).toHaveValue("cr-test");
    expect(screen.getByLabelText(/端点地址/)).toHaveValue("https://mcp-test.cycplus.com/mcp/cr-test");

    fireEvent.click(screen.getByRole("button", { name: "读取工具" }));
    await waitFor(() => expect(screen.getByText("需要成员在 mcp-test.cycplus.com 登录")).toBeInTheDocument());
    expect(probe).toHaveBeenCalledWith({ url: "https://mcp-test.cycplus.com/mcp/cr-test", timeout_ms: 30000 });

    fireEvent.click(screen.getByRole("button", { name: "登记" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({
      ref: "cr-test", display_name: "cr-test", summary: "", url: "https://mcp-test.cycplus.com/mcp/cr-test", tools: [],
      auth: "oauth", auth_header: "", oauth_scopes: "profile.read openid", timeout_ms: 30000, oauth_client_id: "",
    });
  });

  it("配置里的令牌被丢弃并提示；测试令牌只发给探测、不进保存内容", async () => {
    const probe = vi.fn(async (_input: McpProbeInput) => probeResult({ status: "ok", auth: "bearer", tools: ["lead_get", "lead_search"] }));
    const { onSave } = setup(null, probe);
    fireEvent.change(screen.getByLabelText(/粘贴配置/), { target: { value: JSON.stringify({ mcpServers: { crm: { url: "https://crm.example.com/mcp", headers: { "X-API-Key": "pasted-secret" } } } }) } });
    fireEvent.click(screen.getByRole("button", { name: "解析并填入" }));
    expect(screen.getAllByText(/令牌不会保存到平台/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/令牌请求头/)).toHaveValue("X-API-Key");
    expect(screen.getByLabelText(/粘贴配置/)).toHaveValue("");
    expect(document.body.innerHTML).not.toContain("pasted-secret");

    fireEvent.change(screen.getByLabelText(/测试令牌/), { target: { value: "probe-only-token" } });
    fireEvent.click(screen.getByRole("button", { name: "读取工具" }));
    await waitFor(() => expect(screen.getByText(/已读到 2 个工具/)).toBeInTheDocument());
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ auth_header: "X-API-Key", test_token: "probe-only-token" }));
    expect(screen.getByLabelText(/测试令牌/)).toHaveValue("");
    expect(screen.getByLabelText(/工具名/)).toHaveValue("lead_get\nlead_search");

    fireEvent.click(screen.getByRole("button", { name: "登记" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(JSON.stringify(onSave.mock.calls)).not.toContain("probe-only-token");
    expect(onSave.mock.calls[0]![0]).toMatchObject({ ref: "crm", auth: "bearer", auth_header: "X-API-Key", tools: ["lead_get", "lead_search"] });
  });

  it("拒绝 stdio / sse，给出原因", () => {
    setup();
    fireEvent.change(screen.getByLabelText(/粘贴配置/), { target: { value: JSON.stringify({ mcpServers: { local: { command: "npx" }, ev: { type: "sse", url: "https://e.example.com/sse" } } }) } });
    fireEvent.click(screen.getByRole("button", { name: "解析并填入" }));
    expect(screen.getAllByText(/只支持 streamable HTTP/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/端点地址/)).toHaveValue("");
  });

  it("已设置的应用密钥不显示：不动则保持、点清除则提交空字符串", async () => {
    const item: PlatformMcpServer = {
      server_id: "s1", ref: "cr-test", display_name: "Cycplus", summary: "", url: "https://mcp-test.cycplus.com/mcp/cr-test", tools: [],
      auth: "oauth", auth_header: "", oauth_scopes: "openid", timeout_ms: 30000, oauth_client_id: "app-1", oauth_client_secret_set: true,
      revision: 2, status: "published",
    };
    const { onSave } = setup(item);
    expect(screen.getByText("应用密钥：已设置（不显示）")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty("oauth_client_secret");

    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]![0]).toMatchObject({ oauth_client_id: "app-1", oauth_client_secret: "" });
  });

  // 读取工具的三种结果与失败分支（needs_token / 连不上 / probe 报错）。
  it("读取工具提示需要访问令牌、连不上与读取失败", async () => {
    const probe = vi.fn(async (_input: McpProbeInput) => probeResult({ status: "needs_token", auth: "bearer", detail: "需要令牌", token_rejected: true }));
    const first = setup(null, probe);
    fireEvent.change(screen.getByLabelText(/端点地址/), { target: { value: "https://x.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "读取工具" }));
    await waitFor(() => expect(screen.getByText(/测试令牌被拒绝/)).toBeInTheDocument());
    first.unmount();

    const down = vi.fn(async (_input: McpProbeInput) => probeResult({ status: "unreachable", detail: "连不上" }));
    const second = setup(null, down);
    fireEvent.change(screen.getByLabelText(/端点地址/), { target: { value: "https://y.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "读取工具" }));
    await waitFor(() => expect(screen.getByText("无法连接")).toBeInTheDocument());
    second.unmount();

    const boom = vi.fn(async (_input: McpProbeInput) => { throw new Error("boom"); });
    setup(null, boom);
    fireEvent.change(screen.getByLabelText(/端点地址/), { target: { value: "https://z.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "读取工具" }));
    await waitFor(() => expect(screen.getByText("读取失败，请稍后再试")).toBeInTheDocument());
  });

  // 配置里有多个 MCP 时列出候选择；导入note 的 info / error 分支。
  it("配置里有多个 MCP 时列出候选；无可导条目给错误提示", async () => {
    setup();
    const multi = JSON.stringify({ mcpServers: { a: { url: "https://a.example.com/mcp" }, b: { url: "https://b.example.com/mcp" } } });
    fireEvent.change(screen.getByLabelText(/粘贴配置/), { target: { value: multi } });
    fireEvent.click(screen.getByRole("button", { name: "解析并填入" }));
    expect(screen.getByText(/配置里有 2 个 MCP/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /a\.example\.com/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/粘贴配置/), { target: { value: JSON.stringify({ mcpServers: { local: { command: "npx" } } }) } });
    fireEvent.click(screen.getByRole("button", { name: "解析并填入" }));
    expect(screen.getAllByText(/配置里没有可用的 MCP|只支持 streamable HTTP/).length).toBeGreaterThan(0);
  });
});
