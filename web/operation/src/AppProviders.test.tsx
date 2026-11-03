import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "./AppProviders";
import { useSession } from "./auth/session";

const token = `header.${btoa(JSON.stringify({ user_id: "op1", roles: ["system_admin"], exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;

function Harness() {
  const { token: currentToken, signIn, signOut } = useSession();
  return (
    <>
      <output data-testid="token">{currentToken ?? ""}</output>
      <button onClick={() => signIn(token)}>sign in</button>
      <button onClick={signOut}>sign out</button>
    </>
  );
}

describe("Operation AppProviders session revocation", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("revokes the server session before clearing the local token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    render(
      <AppProviders>
        <Harness />
      </AppProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: "sign in" }));
    await waitFor(() => expect(screen.getByTestId("token")).toHaveTextContent(token));
    fireEvent.click(screen.getByRole("button", { name: "sign out" }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/operation/auth/logout",
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
    });
    expect(screen.getByTestId("token")).toHaveTextContent("");
    expect(localStorage.getItem("aiteam.operation.token")).toBeNull();
  });
});
