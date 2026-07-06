/**
 * RosterPicker 直接单测（#673）：覆盖分支覆盖棘轮所需的失败路径与 Escape 关闭。
 *
 * 失败路径：GET /api/agent/grants/experts 抛出 → 渲染「加载专家失败」文案；
 *           （lines 43-45 of RosterPicker.tsx）。
 * Esc 关闭：挂载后触发 keydown Escape → 调用 onCancel；触发其它键 → 不调用。
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppProvider } from "../../lib/app-context";
import { RosterPicker } from "./RosterPicker";
import { listLoadedExperts } from "../group/useGroupApi";

vi.mock("../group/useGroupApi", () => ({
  listLoadedExperts: vi.fn(),
}));

const mockedList = listLoadedExperts as unknown as ReturnType<typeof vi.fn>;

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

describe("RosterPicker — 失败路径", () => {
  it("roster 拉取失败时显示错误文案", async () => {
    mockedList.mockRejectedValueOnce(new Error("network down"));
    renderPicker();
    // err instanceof Error → 显示 err.message
    expect(await screen.findByText(/network down/)).toBeInTheDocument();
  });

  it("roster 拉取失败（非 Error）时显示兜底文案", async () => {
    mockedList.mockRejectedValueOnce("weird");
    renderPicker();
    expect(await screen.findByText(/加载专家失败/)).toBeInTheDocument();
  });
});

describe("RosterPicker — Escape 关闭", () => {
  it("Escape 按键调用 onCancel", async () => {
    mockedList.mockResolvedValueOnce([]);
    const onCancel = vi.fn();
    renderPicker(onCancel);

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("非 Escape 按键不触发 onCancel", async () => {
    mockedList.mockResolvedValueOnce([]);
    const onCancel = vi.fn();
    renderPicker(onCancel);

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "a" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
