import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "./routes";
import { AstryxProviders } from "../astryx/AstryxProviders";
import { AppProvider } from "../lib/app-context";

const originalFetch = globalThis.fetch;

function loginStorage() {
  localStorage.setItem("aiteam.agent.token", "test-token");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify({
    user_id: "u1",
    tenant_id: "t1",
    roles: ["member"],
    exp: 9999999999,
  }));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
});

describe("Agent routes", () => {
  it("redirects the retired knowledge route to the accessible workspace empty state", async () => {
    loginStorage();
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    render(
      <MemoryRouter initialEntries={["/knowledge"]}>
        <AstryxProviders>
          <AppProvider>
            <AppRoutes />
          </AppProvider>
        </AstryxProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("region", { name: "本地工作台" })).toBeInTheDocument();
    expect(screen.getByText("暂无会话")).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(requests.every((url) => url.includes("/api/agent/conversations"))).toBe(true);
  });
});
