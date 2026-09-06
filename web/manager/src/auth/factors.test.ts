import { afterEach, describe, expect, it } from "vitest";
import { consumeOAuthTransaction, clearOAuthTransaction } from "./factors";

const key = "aiteam.manager.oauth.transaction";
const transaction = () => ({ state: "expected", provider: "github", intent: "login", redirectUri: window.location.origin + "/auth/oauth/callback", startedAt: Date.now() });
afterEach(() => clearOAuthTransaction());

describe("browser OAuth transaction binding", () => {
  it("consumes only this browser transaction once", () => {
    sessionStorage.setItem(key, JSON.stringify(transaction()));
    expect(consumeOAuthTransaction("expected").provider).toBe("github");
    expect(() => consumeOAuthTransaction("expected")).toThrow();
  });
  it.each(["foreign", null])("rejects uninitiated/foreign callback %s", (state) => {
    sessionStorage.setItem(key, JSON.stringify(transaction()));
    expect(() => consumeOAuthTransaction(state)).toThrow();
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it("rejects expiry and redirect mismatch", () => {
    sessionStorage.setItem(key, JSON.stringify({ ...transaction(), startedAt: Date.now() - 601000 }));
    expect(() => consumeOAuthTransaction("expected")).toThrow();
    sessionStorage.setItem(key, JSON.stringify({ ...transaction(), redirectUri: "https://other.example/auth/oauth/callback" }));
    expect(() => consumeOAuthTransaction("expected")).toThrow();
  });
});

it("authorize saves the browser transaction before navigating to the configured provider", async () => {
  const { vi } = await import("vitest");
  const { startOAuth } = await import("./factors");
  const { createManagerApiClient } = await import("../api/client");
  const assign = vi.fn();
  const origin = window.location.origin;
  vi.stubGlobal("window", { location: { origin, assign } });
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ data: { state: "nonce", authorization_url: "https://provider.example/auth" } }), { headers: { "Content-Type": "application/json" } }));
  try {
    const client = createManagerApiClient({ getToken: () => "fixture" });
    await startOAuth(client, "t1", "github", "link", "u1");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ intent: "link", provider: "github", tenant_id: "t1" });
    expect(assign).toHaveBeenCalledWith("https://provider.example/auth");
    expect(consumeOAuthTransaction("nonce")).toMatchObject({ userId: "u1", intent: "link" });
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: null }), { headers: { "Content-Type": "application/json" } }));
    await expect(startOAuth(client, "t1", "github", "login")).rejects.toThrow("未返回");
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});
