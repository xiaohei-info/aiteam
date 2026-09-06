import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionContext } from "../../auth/session";
import { SettingsPage } from "./SettingsPage";

function renderAccount() {
  const claims = { user_id: "u1", tenant_id: "t1", roles: ["member"], exp: Date.now()/1000 + 3600 };
  render(<SessionContext.Provider value={{ token: "fixture", session: { claims, principal: { id: "u1", display_name: "Member", roles: ["member"], status: "active" } }, signIn: vi.fn(), signOut: vi.fn(), onUnauthorized: vi.fn() }}><SettingsPage /></SessionContext.Provider>);
}
const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("ordinary member can enroll/list/remove own factors without loading enterprise administration", async () => {
  let enrolled = false;
  let linked = true;
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("navigator", { credentials: { create: vi.fn(async () => ({ response: { clientDataJSON: new Uint8Array([1]).buffer, attestationObject: new Uint8Array([2]).buffer } })) } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.endsWith("registration-options")) return json({ challenge: "AQ", rp: { id: "localhost", name: "Manager" }, user: { id: "AQ", name: "u1", displayName: "Member" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] });
    if (url.endsWith("/passkeys") && method === "POST") { enrolled = true; return json({ credential_id: "key" }); }
    if (method === "DELETE") { if (url.includes("passkeys")) enrolled = false; else linked = false; return json({ deleted: true }); }
    if (url.endsWith("/passkeys")) return json(enrolled ? [{ credential_id: "key", label: "Browser" }] : []);
    if (url.endsWith("/connections")) return json(linked ? [{ provider: "github", profile_email: "fixture@example.test" }] : []);
    return json(["github"]);
  });
  renderAccount();
  await screen.findByRole("button", { name: "解绑 github" });
  expect(screen.queryByRole("heading", { name: "企业设置" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "添加 Passkey" }));
  await screen.findByRole("button", { name: "删除 Browser" });
  fireEvent.click(screen.getByRole("button", { name: "删除 Browser" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "删除 Browser" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "解绑 github" }));
  await screen.findByRole("button", { name: "绑定 github" });
  expect(calls.some((call) => call.url.includes("/settings"))).toBe(false);
  expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/passkeys"))).toBe(true);
});

it("not configured registration stays an error, never an enrolled success", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).endsWith("registration-options") ? new Response(JSON.stringify({ status: 503, code: "auth_origin_unconfigured", title: "Passkey 未配置" }), { status: 503, headers: { "Content-Type": "application/problem+json" } }) : json([]));
  renderAccount();
  fireEvent.click(screen.getByRole("button", { name: "添加 Passkey" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Passkey 未配置"));
  expect(screen.queryByRole("button", { name: /删除/ })).toBeNull();
});
