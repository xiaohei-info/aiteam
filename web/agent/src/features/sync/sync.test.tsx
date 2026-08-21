import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppProvider } from "../../lib/app-context";
import { SyncPage } from "./SyncPage";

function envelope<T>(data: T): string {
  return JSON.stringify({ data });
}

function login() {
  localStorage.setItem("aiteam.agent.token", "test-token");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify({
    user_id: "member-1",
    tenant_id: "tenant-1",
    enterprise_id: "enterprise-1",
    roles: ["member"],
    exp: 9999999999,
  }));
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AppProvider>
        <SyncPage />
      </AppProvider>
    </MemoryRouter>,
  );
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
});

describe("SyncPage", () => {
  it("uses flat list envelopes and projects sync plus usage flush results", async () => {
    login();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agent/grants/snapshots")) {
        return new Response(envelope([{ employee_id: "e1", version: "v1", snapshot_version: "snapshot-1", display_name: "专家A" }]), { headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/agent/usage/outbox")) {
        return new Response(envelope([{ summary_id: "sum-1", tenant_id: "tenant-1", kind: "hourly", status: "failed", attempts: 2, last_error: "Manager offline", created_at: "2026-01-01T00:00:00Z" }]), { headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/agent/grants/sync")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ tenant_id: "tenant-1", member_id: "member-1" });
        return new Response(envelope({ ok: true, upserted: 1, revoked: 0 }), { headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/agent/usage/flush")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ limit: 50 });
        return new Response(envelope({ sent: ["sum-1"], failed: [] }), { headers: { "content-type": "application/json" } });
      }
      return new Response(envelope(null), { headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("专家A")).toBeInTheDocument());
    expect(screen.getByText("Manager offline")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "立即同步" }));
    await waitFor(() => expect(screen.getByText(/同步成功/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "上报用量" }));
    await waitFor(() => expect(screen.getByTestId("usage-flush-result")).toHaveTextContent("已上报 1，失败 0"));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/agent/usage/flush"))).toBe(true);
  });

  it("renders empty snapshot and outbox projections explicitly", async () => {
    login();
    globalThis.fetch = vi.fn(async () => new Response(envelope([]), { headers: { "content-type": "application/json" } })) as typeof fetch;
    renderPage();
    await waitFor(() => expect(screen.getByText("暂无快照")).toBeInTheDocument());
    expect(screen.getByText("暂无用量摘要")).toBeInTheDocument();
  });

  it("renders Agent API errors instead of treating them as empty data", async () => {
    login();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ type: "about:blank", title: "Unavailable", status: 503, code: "manager_unavailable", detail: "同步服务不可用" }), { status: 503, headers: { "content-type": "application/problem+json" } })) as typeof fetch;
    renderPage();
    await waitFor(() => expect(screen.getByText("同步服务不可用")).toBeInTheDocument());
    expect(screen.queryByText("暂无快照")).toBeNull();
  });
});
