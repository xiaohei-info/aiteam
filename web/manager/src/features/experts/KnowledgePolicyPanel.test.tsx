import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { SessionContext } from "../../auth/session";
import { KnowledgePolicyPanel } from "./KnowledgePolicyPanel";

const calls: Array<{ path: string; method: string; body: unknown; authorization: string | null }> = [];
let whole: Array<Record<string, unknown>> = [];
let policies: Array<Record<string, unknown>> = [];
let fail = false;
const base = "/api/manager/employees/employee";

beforeEach(() => {
  calls.length = 0; whole = []; policies = []; fail = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://manager.test").pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body, authorization: new Headers(init?.headers).get("Authorization") });
    if (fail) return new Response(JSON.stringify({ status: 403, code: "forbidden", title: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/problem+json" } });
    if (path === `${base}/knowledge-bindings` && method === "POST") whole = [{ binding_id: "whole", knowledge_space_id: "enterprise_shared", enabled: body.enabled, revoked_at: null }];
    if (path === `${base}/knowledge-bindings/whole` && method === "PATCH") whole = whole.map((row) => ({ ...row, ...body, revoked_at: null }));
    if (path === `${base}/knowledge-document-bindings/doc` && method === "PUT") policies = [{ document_id: "doc", enabled: body.enabled, revoked_at: null }];
    if (path === `${base}/knowledge-document-bindings/doc` && method === "DELETE") {
      policies = [{ document_id: "doc", enabled: false, revoked_at: "2026-09-06" }];
      return new Response(null, { status: 204 });
    }
    const data = path === "/api/manager/knowledge-spaces" ? [{ knowledge_space_id: "enterprise_shared" }]
      : path.endsWith("/documents") ? [{ id: "doc", display_name: "政策A", status: "ready" }]
      : path === `${base}/knowledge-bindings` ? whole
      : path === `${base}/knowledge-document-bindings` ? policies : {};
    return new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(tools: string[] = []) {
  return render(<SessionContext.Provider value={{ token: "fixture-token", session: null, signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} }}>
    <KnowledgePolicyPanel employeeId="employee" tools={tools} />
  </SessionContext.Provider>);
}

it("keeps untouched inheritance, writes whole deny on Manager and rereads the actual state", async () => {
  mount();
  expect(await screen.findByText("企业知识：继承企业默认")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "禁用知识能力" }));
  expect(await screen.findByText("企业知识：已拒绝")).toBeInTheDocument();
  expect(screen.getByText("当前工具许可：无知识工具")).toBeInTheDocument();
  expect(calls.find((c) => c.method === "POST")).toEqual({ path: `${base}/knowledge-bindings`, method: "POST", body: { knowledge_space_id: "enterprise_shared", enabled: false }, authorization: "Bearer fixture-token" });
  fireEvent.click(screen.getByRole("button", { name: "允许知识能力" }));
  expect(await screen.findByText("企业知识：显式允许")).toBeInTheDocument();
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: true });
});

it("document disable/delete retain a visible denial; explicit allow does not override whole or tools", async () => {
  whole = [{ binding_id: "whole", knowledge_space_id: "enterprise_shared", enabled: false, revoked_at: null }];
  mount(["read"]);
  await screen.findByText("政策A · ready · 继承");
  fireEvent.click(screen.getByRole("button", { name: "禁用 政策A" }));
  await screen.findByText("政策A · ready · 已拒绝");
  fireEvent.click(screen.getByRole("button", { name: "撤销 政策A" }));
  await screen.findByText("政策A · ready · 已撤销");
  fireEvent.click(screen.getByRole("button", { name: "允许 政策A" }));
  await screen.findByText("政策A · ready · 显式允许");
  expect(screen.getByText("企业知识：已拒绝")).toBeInTheDocument();
  expect(screen.getByText("当前工具许可：无知识工具")).toBeInTheDocument();
  expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ enabled: false }, { enabled: true }]);
  expect(calls.find((c) => c.method === "DELETE")?.path).toBe(`${base}/knowledge-document-bindings/doc`);
});

it("never treats a failed policy load or mutation as default permission or success", async () => {
  fail = true;
  const view = mount();
  await screen.findByText("知识策略加载失败，未修改权限");
  expect(screen.queryByRole("button", { name: "允许知识能力" })).not.toBeInTheDocument();
  view.unmount(); fail = false;
  mount(["knowledge_get"]);
  await screen.findByText("当前工具许可：knowledge_get");
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "禁用知识能力" }));
  await waitFor(() => expect(screen.getByText("知识策略更新或重新读取失败，请重新打开确认；不视为已成功")).toBeInTheDocument());
  expect(screen.queryByText("企业知识：已拒绝")).not.toBeInTheDocument();
});
