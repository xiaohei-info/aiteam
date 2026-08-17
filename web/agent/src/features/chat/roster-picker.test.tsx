/**
 * RosterPicker 直接单测（#684）：
 *  - 失败路径：GET /api/agent/grants/experts 抛出 -> 渲染错误文案。
 *  - Esc 关闭：挂载后触发 keydown Escape -> 调用 onCancel；触发其它键 -> 不调用。
 *  - 配置完整度防呆（req 2）：model/provider_ref 齐全才可选；缺失示待 Manager 配置并禁用。
 *  - sync 失败提示（req 3/4）：sync 失败在顶部给出 Manager 端指向提示，且不阻断 roster 展示。
 *  - readiness（AITEAM-693）：available=false 时禁用并展示原因 title；拉取失败降级为空不阻塞。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppProvider } from "../../lib/app-context";
import { RosterPicker, ReadinessDot } from "./RosterPicker";
import { listLoadedExperts, syncGrants } from "../group/useGroupApi";
import { getReadinessReport } from "../readiness/useExpertReadinessApi";

vi.mock("../readiness/useExpertReadinessApi", () => ({
  getReadinessReport: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../group/useGroupApi", () => ({
  listLoadedExperts: vi.fn(),
  syncGrants: vi.fn(),
}));

const mockedList = listLoadedExperts as unknown as ReturnType<typeof vi.fn>;
const mockedSync = syncGrants as unknown as ReturnType<typeof vi.fn>;
const mockedReadiness = getReadinessReport as unknown as ReturnType<typeof vi.fn>;

const validClaims = {
  user_id: "u-1",
  tenant_id: "t-1",
  enterprise_id: "e-1",
  roles: ["member"],
  exp: 4070908800,
};

function loginStorage(claims = validClaims) {
  localStorage.setItem("aiteam.agent.token", "t");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify(claims));
}

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockReset();
  mockedList.mockReset();
  mockedReadiness.mockReset();
  mockedReadiness.mockResolvedValue(null);
});

afterEach(() => {
  localStorage.clear();
});

function renderPicker(onCancel = vi.fn()) {
  const client = { baseUrl: "http://test" } as never;
  render(
    <MemoryRouter>
      <AppProvider>
        <RosterPicker client={client} onPick={vi.fn()} onCancel={onCancel} />
      </AppProvider>
    </MemoryRouter>,
  );
  return client;
}

describe("RosterPicker - 失败路径", () => {
  it("roster 拉取失败时显示错误文案", async () => {
    mockedSync.mockResolvedValueOnce({ ok: true, upserted: 0, revoked: 0 });
    mockedList.mockRejectedValueOnce(new Error("network down"));
    renderPicker();
    expect(await screen.findByText(/network down/)).toBeInTheDocument();
  });

  it("roster 拉取失败（非 Error）时显示兜底文案", async () => {
    mockedSync.mockResolvedValueOnce({ ok: true, upserted: 0, revoked: 0 });
    mockedList.mockRejectedValueOnce("weird");
    renderPicker();
    expect(await screen.findByText(/加载专家失败/)).toBeInTheDocument();
  });
});

describe("RosterPicker - Escape 关闭", () => {
  it("Escape 按键调用 onCancel", async () => {
    mockedSync.mockResolvedValueOnce({ ok: true, upserted: 0, revoked: 0 });
    mockedList.mockResolvedValueOnce([]);
    const onCancel = vi.fn();
    renderPicker(onCancel);

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("非 Escape 按键不触发 onCancel", async () => {
    mockedSync.mockResolvedValueOnce({ ok: true, upserted: 0, revoked: 0 });
    mockedList.mockResolvedValueOnce([]);
    const onCancel = vi.fn();
    renderPicker(onCancel);

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "a" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("RosterPicker - 配置完整度防呆（req 2）", () => {
  it("仅缺首次冻结快照时允许在线首跑", async () => {
    mockedSync.mockResolvedValueOnce({ ok: true, upserted: 0, revoked: 0 });
    mockedList.mockResolvedValueOnce([
      {
        employee_id: "e1",
        tenant_id: "t1",
        version: "v1",
        handle: "首跑专家",
        display_name: "首跑专家",
        model_policy: { model: "gpt-5", provider_ref: "relay", thinking_level: "deep" },
        revoked: false,
      },
    ]);
    mockedReadiness.mockResolvedValueOnce({
      runtime: "ready",
      experts: [{
        employee_id: "e1", display_name: "首跑专家", handle: "首跑专家",
        available: false, runtime: "blocked", provider: "blocked", skills: [], capabilities: [],
        reasons: ["专家 首跑专家 没有已冻结快照（Manager 未拉取/未装载）"],
      }],
    });

    renderPicker();

    expect(await screen.findByRole("button", { name: /首跑专家/ })).toBeEnabled();
    expect(screen.getByText("首次运行将冻结快照")).toBeInTheDocument();
  });

  it("model 与 provider_ref 齐全时可选", async () => {
    mockedSync.mockResolvedValueOnce({ ok: true, upserted: 0, revoked: 0 });
    mockedList.mockResolvedValueOnce([
      {
        employee_id: "e1",
        tenant_id: "t1",
        version: "v1",
        handle: "专家A",
        display_name: "专家A",
        model_policy: { model: "gpt-5", provider_ref: "relay", thinking_level: "deep" },
        revoked: false,
      },
    ]);
    const onPick = vi.fn();
    const client = { baseUrl: "http://test" } as never;
    render(
      <MemoryRouter>
        <AppProvider>
          <RosterPicker client={client} onPick={onPick} onCancel={vi.fn()} />
        </AppProvider>
      </MemoryRouter>,
    );

    const btn = await screen.findByRole("button", { name: /专家A/ });
    expect(btn).toBeEnabled();
    btn.click();
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("model 或 provider_ref 缺失时示待 Manager 配置并禁用选择", async () => {
    mockedSync.mockResolvedValueOnce({ ok: true, upserted: 0, revoked: 0 });
    mockedList.mockResolvedValueOnce([
      {
        employee_id: "e1",
        tenant_id: "t1",
        version: "v1",
        handle: "待配专家",
        display_name: "待配专家",
        // provider_ref 缺失 -> 不可选
        model_policy: { model: "gpt-5", provider_ref: null },
        revoked: false,
      },
    ]);
    const onPick = vi.fn();
    const client = { baseUrl: "http://test" } as never;
    render(
      <MemoryRouter>
        <AppProvider>
          <RosterPicker client={client} onPick={onPick} onCancel={vi.fn()} />
        </AppProvider>
      </MemoryRouter>,
    );

    const btn = await screen.findByRole("button", { name: /待配专家/ });
    expect(btn).toBeDisabled();
    expect(screen.getByText("待 Manager 配置")).toBeInTheDocument();
    btn.click();
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("RosterPicker - sync 失败提示（req 3/4）", () => {
  it("sync 失败时给出 Manager 端指向提示，且不阻断 roster 展示", async () => {
    loginStorage();
    mockedSync.mockResolvedValueOnce({
      ok: false,
      upserted: 0,
      revoked: 0,
      error: "Manager 端不可达，请检查配置或授权。",
    });
    mockedList.mockResolvedValueOnce([
      {
        employee_id: "e1",
        tenant_id: "t1",
        version: "v1",
        handle: "专家A",
        display_name: "专家A",
        model_policy: { model: "gpt-5", provider_ref: "relay" },
        revoked: false,
      },
    ]);
    renderPicker();

    expect(await screen.findByText(/Manager 端不可达/)).toBeInTheDocument();
    // 离线降级保留：sync 失败仍展示本地 roster。
    expect(await screen.findByRole("button", { name: /专家A/ })).toBeEnabled();
  });
});

describe("RosterPicker — readiness (AITEAM-693)", () => {
  it("readiness 不满足时禁用该专家按钮并展示原因", async () => {
    const experts = [
      {
        employee_id: "emp-1",
        display_name: "甲",
        runtime_binding: "hermes",
        revoked: false,
        tenant_id: "t1",
        version: "v1",
        handle: "a",
        model_policy: { model: "gpt-5", provider_ref: "relay" },
      },
    ];
    mockedList.mockResolvedValueOnce(experts);
    vi.mocked(getReadinessReport).mockResolvedValueOnce({
      runtime: "ready",
      runtime_reason: undefined,
      experts: [
        {
          employee_id: "emp-1",
          display_name: "甲",
          handle: "a",
          available: false,
          runtime: "blocked",
          provider: "ready",
          skills: [],
          capabilities: [],
          reasons: ["runtime: local Pi session is not configured"],
        },
      ],
    });
    renderPicker();
    const btn = await screen.findByRole("button", { name: /甲/ });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/local Pi session/)).toBeInTheDocument();
  });

  it("readiness 满足时专家按钮可点击", async () => {
    const experts = [
      {
        employee_id: "emp-1",
        display_name: "甲",
        revoked: false,
        tenant_id: "t1",
        version: "v1",
        handle: "a",
        model_policy: { model: "gpt-5", provider_ref: "relay" },
      },
    ];
    mockedList.mockResolvedValueOnce(experts);
    vi.mocked(getReadinessReport).mockResolvedValueOnce({
      runtime: "ready",
      runtime_reason: undefined,
      experts: [
        {
          employee_id: "emp-1",
          display_name: "甲",
          handle: "a",
          available: true,
          runtime: "ready",
          provider: "ready",
          skills: [],
          capabilities: [],
          reasons: [],
        },
      ],
    });
    const onPick = vi.fn();
    const client = { baseUrl: "http://test" } as never;
    render(
      <MemoryRouter>
        <AppProvider>
          <RosterPicker client={client} onPick={onPick} onCancel={vi.fn()} />
        </AppProvider>
      </MemoryRouter>,
    );
    const btn = await screen.findByRole("button", { name: /甲/ });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("readiness 拉取失败时降级为空，不阻塞专家列表展示", async () => {
    const experts = [
      {
        employee_id: "emp-1",
        display_name: "甲",
        revoked: false,
        tenant_id: "t1",
        version: "v1",
        handle: "a",
        model_policy: { model: "gpt-5", provider_ref: "relay" },
      },
    ];
    mockedList.mockResolvedValueOnce(experts);
    vi.mocked(getReadinessReport).mockRejectedValueOnce(new Error("network"));
    const onPick = vi.fn();
    const client = { baseUrl: "http://test" } as never;
    render(
      <MemoryRouter>
        <AppProvider>
          <RosterPicker client={client} onPick={onPick} onCancel={vi.fn()} />
        </AppProvider>
      </MemoryRouter>,
    );
    // 列表正常渲染，专家按钮可点击（无 readiness 即不阻断）
    const btn = await screen.findByRole("button", { name: /甲/ });
    expect(btn).toBeEnabled();
  });
});

describe("ReadinessDot 语义分支", () => {
  it.each([
    ["ready", "可用"],
    ["degraded", "降级"],
    ["blocked", "不可用"],
    ["unknown", "未知"],
  ] as const)("%s 状态提供可访问文本", (status, label) => {
    render(<ReadinessDot status={status} label={label} />);
    expect(screen.getByRole("img", { name: `就绪：${label}` })).toBeInTheDocument();
  });
});
