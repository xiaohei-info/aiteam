import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@aiteam/shared";
import { EnterpriseMcpDialog } from "./EnterpriseMcpDialog";
import type { EnterpriseMcpServer, EnterpriseMcpServerInput, McpProbeResult } from "./types";

function probeResult(over: Partial<McpProbeResult> = {}): McpProbeResult {
  return {
    status: "ok", auth: "none", tools: [], scopes_supported: [], scope: "", auth_host: "", dynamic_registration: true,
    server_name: "", token_rejected: false, detail: "", ...over,
  };
}

const OAUTH_ITEM: EnterpriseMcpServer = {
  server_id: "ent-1", ref: "crm", display_name: "CRM", summary: "", url: "https://crm.example.com/mcp", tools: [],
  auth: "oauth", auth_header: "", oauth_scopes: "read", timeout_ms: 30000, oauth_client_id: "app-1",
  oauth_client_secret_set: true, revision: 2,
};

function setup(props: Partial<Parameters<typeof EnterpriseMcpDialog>[0]> = {}) {
  const onSave = vi.fn(async (_input: EnterpriseMcpServerInput) => undefined);
  const probe = vi.fn(async () => probeResult());
  render(<EnterpriseMcpDialog item={null} busy={false} onClose={vi.fn()} onSave={onSave} probe={probe} {...props} />);
  const view = within(screen.getByRole("dialog"));
  return { onSave, probe: (props.probe ?? probe) as ReturnType<typeof vi.fn>, view };
}

function paste(view: ReturnType<typeof within>, value: unknown) {
  fireEvent.change(view.getByLabelText("粘贴配置", { exact: false }), { target: { value: typeof value === "string" ? value : JSON.stringify(value) } });
  fireEvent.click(view.getByRole("button", { name: "解析并填入" }));
}

function field(view: ReturnType<typeof within>, label: string) {
  return view.getByLabelText(label, { exact: false }) as HTMLInputElement;
}

describe("EnterpriseMcpDialog 从配置导入", () => {
  it("单条带令牌的配置：填入令牌鉴权，令牌不保存并提示；跳过的条目也说明", () => {
    const { view } = setup();
    paste(view, { "My CRM": { url: "https://crm.example.com/mcp", timeout: 60, headers: { "X-API-Key": "s3cret", "X-Trace": "1" } }, local: { command: "uvx" } });
    expect(field(view, "标识").value).toBe("my-crm");
    expect(field(view, "名称").value).toBe("My CRM");
    expect(field(view, "端点地址").value).toBe("https://crm.example.com/mcp");
    expect(field(view, "令牌请求头").value).toBe("X-API-Key");
    const note = view.getByText(/已改为 my-crm/).textContent ?? "";
    expect(note).toContain("配置里的令牌不会保存到企业端");
    expect(note).toContain("请求头 X-Trace 未带入");
    expect(note).toContain("已跳过：local");
    expect(field(view, "粘贴配置").value).toBe("");
  });

  it("多条配置：列出供选择，选中后填入", () => {
    const { view } = setup();
    paste(view, { a: { url: "https://a.example.com/mcp" }, b: { url: "https://b.example.com/mcp" } });
    expect(view.getByText("配置里有 2 个 MCP，请选择一个。")).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "b · https://b.example.com/mcp" }));
    expect(field(view, "标识").value).toBe("b");
    expect(view.queryByRole("button", { name: "a · https://a.example.com/mcp" })).toBeNull();
  });

  it("无法识别的内容报错，原文保留供修改", () => {
    const { view } = setup();
    paste(view, "{not json");
    expect(view.getByText(/无法识别：请粘贴 JSON 配置/)).toBeInTheDocument();
    expect(field(view, "粘贴配置").value).toBe("{not json");
  });

  it("全部被拒时列出原因", () => {
    const { view } = setup();
    paste(view, { local: { command: "uvx" } });
    expect(view.getByText(/local：.*只支持 streamable HTTP/)).toBeInTheDocument();
  });
});

describe("EnterpriseMcpDialog 读取工具", () => {
  it("需要 OAuth：切到 OAuth、带入权限范围，提示服务不支持自动注册", async () => {
    const probe = vi.fn(async () => probeResult({ status: "needs_oauth", auth: "oauth", scope: "openid", auth_host: "auth.example.com", detail: "需要登录。", dynamic_registration: false }));
    const { view } = setup({ probe, initial: { url: "https://x.example.com/mcp", display_name: "X 服务" } });
    expect(field(view, "标识").value).toBe("x");
    fireEvent.click(view.getByRole("button", { name: "读取工具" }));
    expect(await view.findByText("需要成员在 auth.example.com 登录")).toBeInTheDocument();
    expect(view.getByText(/不支持自动注册应用/)).toBeInTheDocument();
    expect(probe).toHaveBeenCalledWith({ url: "https://x.example.com/mcp", timeout_ms: 30000 });
    fireEvent.click(view.getByText("高级 · 权限范围与应用编号"));
    expect(field(view, "权限范围").value).toBe("openid");
  });

  it("需要令牌 / 令牌被拒 / 无法连接 / 接口报错 / 空结果", async () => {
    const answers: (McpProbeResult | Error | null)[] = [
      probeResult({ status: "needs_token", auth: "bearer", detail: "要令牌" }),
      probeResult({ status: "needs_token", auth: "bearer", token_rejected: true, detail: "令牌无效" }),
      probeResult({ status: "unreachable", detail: "连接超时" }),
      new ApiError("地址指向内网", 422, "validation"),
      null,
    ];
    const probe = vi.fn(async () => { const next = answers.shift()!; if (next instanceof Error) throw next; return next; });
    const { view } = setup({ probe, initial: { url: "https://x.example.com/mcp" } });
    const read = async (text: string) => {
      fireEvent.click(view.getByRole("button", { name: "读取工具" }));
      expect(await view.findByText(text)).toBeInTheDocument();
    };
    await read("需要访问令牌");
    fireEvent.change(field(view, "令牌请求头"), { target: { value: " X-Key " } });
    fireEvent.change(field(view, "测试令牌"), { target: { value: "tok" } });
    await read("测试令牌被拒绝");
    expect(probe).toHaveBeenLastCalledWith({ url: "https://x.example.com/mcp", timeout_ms: 30000, auth_header: "X-Key", test_token: "tok" });
    expect(field(view, "测试令牌").value).toBe("");
    await read("无法连接");
    await read("地址指向内网");
    await read("读取失败，请稍后再试");
  });

  it("读到工具：填入工具名与服务名，保存带上表单内容", async () => {
    const probe = vi.fn(async () => probeResult({ tools: ["search", "fetch"], server_name: "Docs" }));
    const { view, onSave } = setup({ probe, initial: { url: "https://docs.example.com/mcp" } });
    fireEvent.change(field(view, "标识"), { target: { value: "docs" } });
    fireEvent.click(view.getByRole("button", { name: "读取工具" }));
    expect(await view.findByText("已读到 2 个工具（Docs）")).toBeInTheDocument();
    expect(field(view, "名称").value).toBe("Docs");
    expect(field(view, "工具名").value).toBe("search\nfetch");
    fireEvent.click(view.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ ref: "docs", display_name: "Docs", tools: ["search", "fetch"], auth: "none", auth_header: "", oauth_client_id: "" });
  });
});

describe("EnterpriseMcpDialog 应用密钥", () => {
  async function saved(view: ReturnType<typeof within>, onSave: ReturnType<typeof vi.fn>) {
    fireEvent.click(view.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    return onSave.mock.calls.at(-1)![0];
  }

  it("已设置密钥：默认保持（不传），可清除、撤销清除", async () => {
    const { view, onSave } = setup({ item: OAUTH_ITEM });
    expect(view.getByText("应用密钥：已设置（不显示）")).toBeInTheDocument();
    expect(await saved(view, onSave)).not.toHaveProperty("oauth_client_secret");
    fireEvent.click(view.getByRole("button", { name: "清除" }));
    expect(view.getByText("应用密钥将在保存时清除")).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "撤销清除" }));
    fireEvent.click(view.getByRole("button", { name: "清除" }));
    expect(await saved(view, onSave)).toMatchObject({ oauth_client_secret: "", oauth_client_id: "app-1", oauth_scopes: "read" });
  });

  it("替换：输入新密钥后保存带上；点「不替换」回到保持", async () => {
    const { view, onSave } = setup({ item: OAUTH_ITEM });
    fireEvent.click(view.getByRole("button", { name: "替换" }));
    fireEvent.change(field(view, "应用密钥（client_secret）"), { target: { value: "new-secret" } });
    expect(await saved(view, onSave)).toMatchObject({ oauth_client_secret: "new-secret" });
    fireEvent.click(view.getByRole("button", { name: "不替换" }));
    expect(view.getByText("应用密钥：已设置（不显示）")).toBeInTheDocument();
  });
});
