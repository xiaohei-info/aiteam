import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionContext } from "../auth/session";
import { OAuthCallbackPage } from "./OAuthCallbackPage";

const token = `header.${btoa(JSON.stringify({ user_id: "u1" }))}.signature`;
function renderCallback(currentToken: string | null = token) {
  const signIn = vi.fn();
  render(<SessionContext.Provider value={{ session: null, token: currentToken, signIn, signOut: vi.fn(), onUnauthorized: vi.fn() }}><MemoryRouter initialEntries={["/auth/oauth/callback"]}><Routes><Route path="/auth/oauth/callback" element={<OAuthCallbackPage />} /><Route path="/" element={<p>Logged in</p>} /><Route path="/settings" element={<p>Settings</p>} /></Routes></MemoryRouter></SessionContext.Provider>);
  return signIn;
}
function seed(intent = "login", userId = "u1") {
  sessionStorage.setItem("aiteam.manager.oauth.transaction", JSON.stringify({ state: "nonce", provider: "github", intent, userId, startedAt: Date.now(), redirectUri: window.location.origin + "/auth/oauth/callback" }));
}
beforeEach(() => window.history.replaceState(null, "", "/auth/oauth/callback?state=nonce&code=synthetic"));
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });
it("does not send an unsolicited callback to Manager", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  renderCallback();
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("不匹配"));
  expect(fetch).not.toHaveBeenCalled();
  expect(window.location.search).toBe("");
});
it("completes login with matching transaction and actual API envelope", async () => {
  seed();
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { token: "issued" } }), { headers: { "Content-Type": "application/json" } }));
  const signIn = renderCallback();
  await screen.findByText("Logged in");
  expect(signIn).toHaveBeenCalledWith("issued");
  expect(String(fetch.mock.calls[0]?.[0])).toContain("/api/auth/oauth/callback");
});
it("completes only a same-user link using its state and JWT", async () => {
  seed("link");
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { linked: true } }), { headers: { "Content-Type": "application/json" } }));
  renderCallback();
  await screen.findByText("Settings");
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ state: "nonce", provider: "github" });
});
it.each([null, `header.${btoa(JSON.stringify({ user_id: "u2" }))}.signature`])("rejects missing/switched identity before linking", async (currentToken) => {
  seed("link");
  const fetch = vi.spyOn(globalThis, "fetch");
  renderCallback(currentToken);
  await screen.findByRole("alert");
  expect(fetch).not.toHaveBeenCalled();
});
it("surfaces provider denial without issuing credentials", async () => {
  seed();
  window.history.replaceState(null, "", "/auth/oauth/callback?state=nonce&error=denied");
  renderCallback();
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("取消"));
});
it("does not accept a null token response", async () => {
  seed();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: null }), { headers: { "Content-Type": "application/json" } }));
  const signIn = renderCallback();
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("未返回"));
  expect(signIn).not.toHaveBeenCalled();
});
