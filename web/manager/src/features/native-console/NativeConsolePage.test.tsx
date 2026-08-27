import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionContext } from "../../auth/session";
import { NativeConsolePage } from "./NativeConsolePage";

vi.mock("../../api/client", () => ({
  createManagerApiClient: () => ({
    post: vi.fn().mockImplementation((path: string) => Promise.resolve({
      url: `${path.replace(/\/session$/, "/")}`,
      expires_in: 600,
    })),
    del: vi.fn().mockResolvedValue(null),
  }),
}));

function renderPage(component: "lightrag" | "hindsight") {
  return render(
    <SessionContext.Provider value={{
      session: null,
      token: "manager-token",
      signIn: vi.fn(),
      signOut: vi.fn(),
      onUnauthorized: vi.fn(),
    }}>
      <NativeConsolePage component={component} />
    </SessionContext.Provider>,
  );
}

describe("NativeConsolePage", () => {
  it.each([
    ["lightrag", "LightRAG 原生控制台", "/api/manager/native-console/lightrag/"],
    ["hindsight", "Hindsight 原生控制台", "/api/manager/native-console/hindsight/"],
  ] as const)("embeds the %s Manager-owned console route", async (component, title, src) => {
    renderPage(component);
    expect(await screen.findByTitle(title)).toHaveAttribute("src", src);
    expect(screen.getByText("企业专属原生控制台")).toBeInTheDocument();
  });
});
