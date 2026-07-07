/**
 * RosterPicker 直接单测（#684）：
 *  - 失败路径：GET /api/agent/grants/experts 抛出 -> 渲染错误文案。
 *  - Esc 关闭：挂载后触发 keydown Escape -> 调用 onCancel；触发其它键 -> 不调用。
 *  - 配置完整度防呆（req 2）：model/provider_ref 齐全才可选；缺失示待 Manager 配置并禁用。
 *  - sync 失败提示（req 3/4）：sync 失败在顶部给出 Manager 端指向提示，且不阻断 roster 展示。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppProvider } from "../../lib/app-context";
import { RosterPicker } from "./RosterPicker";
import { listLoadedExperts, syncGrants } from "../group/useGroupApi";

vi.mock("../group/useGroupApi", () => ({
  listLoadedExperts: vi.fn(),
  syncGrants: vi.fn(),
}));

const mockedList = listLoadedExperts as unknown as ReturnType<typeof vi.fn>;
const mockedSync = syncGrants as unknown as ReturnType<typeof vi.fn>;

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
