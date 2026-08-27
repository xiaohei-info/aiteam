import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionContext } from "../../auth/session";
import { GatewayPage } from "./GatewayPage";

vi.mock("../../api/client", () => ({
  createOperationApiClient: () => ({
    post: vi.fn().mockResolvedValue({ url: "/api/operation/newapi-console/", expires_in: 600 }),
    del: vi.fn().mockResolvedValue(null),
  }),
}));

function renderPage() {
  return render(
    <SessionContext.Provider value={{
      session: null,
      token: "operation-token",
      signIn: vi.fn(),
      signOut: vi.fn(),
      onUnauthorized: vi.fn(),
    }}>
      <GatewayPage />
    </SessionContext.Provider>,
  );
}

describe("GatewayPage", () => {
  it("creates a server-side NewAPI console session and embeds only the returned route", async () => {
    renderPage();
    expect(await screen.findByTitle("NewAPI 原生控制台")).toHaveAttribute(
      "src",
      "/api/operation/newapi-console/",
    );
    await waitFor(() => expect(screen.getByText("平台级 NewAPI 管理")).toBeInTheDocument());
  });
});
