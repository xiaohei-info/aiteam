import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "@aiteam/shared";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpMarketPage } from "./McpMarketPage";

const api = { list: vi.fn(), enable: vi.fn(), disable: vi.fn(), probe: vi.fn(), createCustom: vi.fn(), updateCustom: vi.fn() };
vi.mock("./useMcpMarketApi", () => ({ useMcpMarketApi: () => api }));
const assistApi = { find: vi.fn() };
vi.mock("../capability-assist/useCapabilityAssistApi", () => ({ useCapabilityAssistApi: () => assistApi }));
const modelsApi = { list: async () => ({ providers: [], models: [{ model: { provider_id: "p1", model_id: "m1", display_name: "m1", status: "published", version: 1 }, rate: { pricing_status: "known" } }] }) };
vi.mock("../platform-models/usePlatformModelsApi", () => ({ usePlatformModelsApi: () => modelsApi }));

const server = (extra: Record<string, unknown> = {}) => ({
  server_id: "s1", ref: "mes", display_name: "MES 查询", summary: "查批次", url: "https://mcp.example.com/mes", tools: ["search"],
  auth: "none", auth_header: "", oauth_scopes: "", timeout_ms: 30000, oauth_client: "dynamic", platform_revision: 1, published: true, enabled: false, enabled_revision: null, update_available: false, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.enable.mockResolvedValue({});
  api.disable.mockResolvedValue(undefined);
  api.createCustom.mockResolvedValue({});
  api.updateCustom.mockResolvedValue({});
});

const own = (extra: Record<string, unknown> = {}) => ({
  server_id: "ent-1", ref: "erp", display_name: "ERP 订单", summary: "查订单", url: "https://erp.example.com/mcp", tools: ["find_order"],
  auth: "none", auth_header: "", oauth_scopes: "", timeout_ms: 30000, oauth_client_id: "", oauth_client_secret_set: false, revision: 2, ...extra,
});

describe("McpMarketPage", () => {
  it("启用平台 MCP；已启用且有更新时可更新或停用", async () => {
    api.list.mockResolvedValue({ platform_available: true, servers: [server(), server({ server_id: "s2", ref: "doc", display_name: "文档", enabled: true, enabled_revision: 1, platform_revision: 2, update_available: true })] });
    render(<MemoryRouter><McpMarketPage /></MemoryRouter>);
    await screen.findByText("MES 查询");
    expect(screen.getByText("已启用 · 有更新")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "启用" }));
    await waitFor(() => expect(api.enable).toHaveBeenCalledWith("s1"));
    fireEvent.click(screen.getByRole("button", { name: "停用" }));
    await waitFor(() => expect(api.disable).toHaveBeenCalledWith("s2"));
    expect(screen.getByRole("button", { name: "更新" })).toBeInTheDocument();
  });

  it("平台不可达或已下架时只能停用，不能启用", async () => {
    api.list.mockResolvedValue({ platform_available: false, servers: [server({ enabled: true, enabled_revision: 1, published: false, platform_revision: null })] });
    render(<MemoryRouter><McpMarketPage /></MemoryRouter>);
    await screen.findByText(/平台 MCP 目录暂时不可用/);
    expect(screen.getByText("已启用 · 平台已下架")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "启用" })).toBeNull();
    expect(screen.getByRole("button", { name: "停用" })).toBeInTheDocument();
  });
});

describe("企业自建 MCP", () => {
  it("分组显示；空时给出说明", async () => {
    api.list.mockResolvedValue({ platform_available: true, servers: [server()], enterprise: [] });
    render(<MemoryRouter><McpMarketPage /></MemoryRouter>);
    expect(await screen.findByText("还没有企业自建的 MCP")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "平台 MCP" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "企业自建" })).toBeInTheDocument();
  });

  it("添加：检查地址带出工具，提交字段；被拒时原因显示在窗口里且窗口保留", async () => {
    api.list.mockResolvedValue({ platform_available: true, servers: [], enterprise: [] });
    api.probe.mockResolvedValue({ status: "ok", auth: "none", tools: ["find_order", "list_orders"], scopes_supported: [], scope: "", auth_host: "", dynamic_registration: false, server_name: "ERP", token_rejected: false, detail: "" });
    api.createCustom.mockRejectedValueOnce(new ApiError("本企业目录里已有标识为 erp 的 MCP，请换一个标识", 409, "conflict"));
    render(<MemoryRouter><McpMarketPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "添加企业 MCP" }));
    const dialog = await screen.findByRole("dialog", { name: "添加企业 MCP" });
    fireEvent.change(within(dialog).getByLabelText(/^标识/), { target: { value: "erp" } });
    fireEvent.change(within(dialog).getByLabelText(/^端点地址/), { target: { value: "https://erp.example.com/mcp" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "读取工具" }));
    await waitFor(() => expect(api.probe).toHaveBeenCalledWith({ url: "https://erp.example.com/mcp", timeout_ms: 30000 }));
    expect(await within(dialog).findByText("已读到 2 个工具（ERP）")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^名称/)).toHaveValue("ERP");
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));
    expect(await within(dialog).findByText(/已有标识为 erp/)).toBeInTheDocument();
    expect(api.createCustom).toHaveBeenCalledWith(expect.objectContaining({ ref: "erp", display_name: "ERP", tools: ["find_order", "list_orders"], auth: "none" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "添加企业 MCP" })).toBeNull());
    expect(await screen.findByText(/ERP 已添加/)).toBeInTheDocument();
  });

  it("标识带前缀：平台 taiyim/、企业自建为企业名/", async () => {
    api.list.mockResolvedValue({ platform_available: true, servers: [], enterprise: [own()], enterprise_namespace: "太一科技" });
    render(<MemoryRouter><McpMarketPage /></MemoryRouter>);
    expect(await screen.findByText(/标识 太一科技\/erp · 修订 2/)).toBeInTheDocument();
  });

  it("编辑不能改标识；删除先确认", async () => {
    api.list.mockResolvedValue({ platform_available: true, servers: [], enterprise: [own()] });
    render(<MemoryRouter><McpMarketPage /></MemoryRouter>);
    expect(await screen.findByText(/标识 erp · 修订 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑企业 MCP" });
    expect(within(dialog).getByLabelText(/^标识/)).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/^名称/), { target: { value: "ERP 订单 v2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.updateCustom).toHaveBeenCalledWith("ent-1", expect.objectContaining({ ref: "erp", display_name: "ERP 订单 v2" })));
    expect(api.updateCustom.mock.calls[0]![1]).not.toHaveProperty("oauth_client_secret");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(api.disable).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(api.disable).toHaveBeenCalledWith("ent-1"));
  });
});

describe("让模型帮我找（MCP 市场）", () => {
  const candidate = { kind: "mcp", source: "config", url: "https://erp.example.com/mcp", title: "ERP 订单", summary: "查订单", reason: "", verified: false };

  it("技能目录交过来的 MCP 候选：直接打开预填的添加对话框", async () => {
    api.list.mockResolvedValue({ platform_available: true, servers: [], enterprise: [] });
    render(<MemoryRouter initialEntries={[{ pathname: "/mcp-market", state: { assistCandidate: candidate } }]}><McpMarketPage /></MemoryRouter>);
    const dialog = await screen.findByRole("dialog", { name: "添加企业 MCP" });
    expect(within(dialog).getByLabelText(/^端点地址/)).toHaveValue("https://erp.example.com/mcp");
    expect(within(dialog).getByLabelText(/^名称/)).toHaveValue("ERP 订单");
    expect(within(dialog).getByLabelText(/^标识/)).toHaveValue("erp");
  });

  it("选了技能候选：转到技能目录并带上候选", async () => {
    api.list.mockResolvedValue({ platform_available: true, servers: [], enterprise: [] });
    const skill = { ...candidate, kind: "skill", source: "clawhub", url: "https://clawhub.ai/alice/skills/minutes", title: "会议纪要" };
    assistApi.find.mockResolvedValue({ candidates: [skill], notes: "", incomplete: false, dropped: 0, rounds: 1, tool_calls: 1, usage: { input_tokens: 1, output_tokens: 1, cost: "0", pricing_status: "known" } });
    function Capability() { const location = useLocation(); return <p>技能页 {JSON.stringify(location.state)}</p>; }
    render(
      <MemoryRouter initialEntries={["/mcp-market"]}>
        <Routes><Route path="/mcp-market" element={<McpMarketPage />} /><Route path="/skill-market" element={<Capability />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "让模型帮我找" }));
    const dialog = await screen.findByRole("dialog", { name: "让模型帮我找" });
    fireEvent.change(within(dialog).getByLabelText(/需求/), { target: { value: "会议纪要" } });
    const start = within(dialog).getByRole("button", { name: "开始查找" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    fireEvent.click(await within(dialog).findByRole("button", { name: "用这个" }));
    expect(await screen.findByText(/技能页/)).toHaveTextContent("https://clawhub.ai/alice/skills/minutes");
  });
});
