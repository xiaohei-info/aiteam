import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionContext } from "../../auth/session";
import { MemoryPolicyPanel } from "./MemoryPolicyPanel";

const path = "/api/manager/employees/employee/memory-setting";
const calls: Array<{ path: string; method: string; body: any; authorization: string | null }> = [];
let fail = false;
let missing = false;
let setting: { policy: { enabled: boolean; allowed_operations: string[]; explicit_auto_retain: boolean }; retention_days: number | null; retention_status: string; retention_guarded: boolean; source: string; revision: number };
beforeEach(() => {
  calls.length = 0; fail = false; missing = false;
  setting = { policy: { enabled: true, allowed_operations: ["recall", "retain"], explicit_auto_retain: false }, retention_days: null, retention_status: "unlimited", retention_guarded: false, source: "memory_setting", revision: 1 };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const target = new URL(url, "http://manager.test").pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: target, method, body, authorization: new Headers(init?.headers).get("Authorization") });
    if (fail) return new Response(JSON.stringify({ code: "forbidden", status: 403, title: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/problem+json" } });
    if (method === "PATCH") {
      setting = { ...setting, ...body, revision: setting.revision + 1 };
      setting.retention_guarded ||= setting.retention_days !== null;
      setting.retention_status = setting.retention_guarded ? "fact_only" : "unlimited";
    }
    if (method === "DELETE") {
      setting.policy = { enabled: false, allowed_operations: [], explicit_auto_retain: false };
      setting.source = "deleted_deny"; setting.revision++;
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ data: missing ? null : setting }), { headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount() {
  return render(<SessionContext.Provider value={{ token: "fixture-token", session: null, signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} }}>
    <MemoryPolicyPanel employeeId="employee" />
  </SessionContext.Provider>);
}

it("saves independent finite consent and rereads sticky fact-only mode after relaxing future deadlines", async () => {
  mount(); await screen.findByText(/修订 1/);
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "7" } });
  fireEvent.click(screen.getByLabelText("明确授权自动提炼并写入会话记忆"));
  fireEvent.click(screen.getByRole("button", { name: "保存记忆策略" }));
  await screen.findByText(/可信原始事实（持久保留治理）/);
  expect(calls.find((call) => call.method === "PATCH")).toEqual({ path, method: "PATCH", authorization: "Bearer fixture-token",
    body: { policy: { enabled: true, allowed_operations: ["recall", "retain"], explicit_auto_retain: true }, retention_days: 7 } });
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "保存记忆策略" }));
  await screen.findByText(/修订 3/);
  expect(screen.getByText(/可信原始事实（持久保留治理）/)).toBeInTheDocument();
  expect(screen.getByText(/不等于物理擦除/)).toBeInTheDocument();
  expect(calls.every((call) => call.path === path)).toBe(true);
});

it("explicit empty operations deny all and DELETE rereads a durable denial rather than resetting defaults", async () => {
  mount(); await screen.findByText(/修订 1/);
  fireEvent.click(screen.getByLabelText("允许召回"));
  fireEvent.click(screen.getByLabelText("允许手工写入"));
  fireEvent.click(screen.getByRole("button", { name: "保存记忆策略" }));
  await screen.findByText(/修订 2/);
  expect(calls.find((call) => call.method === "PATCH")?.body.policy.allowed_operations).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "撤销记忆能力" }));
  await screen.findByText(/deleted_deny/);
  expect(screen.getByLabelText("启用员工记忆")).not.toBeChecked();
  expect(calls.slice(-2).map((call) => call.method)).toEqual(["DELETE", "GET"]);
});

it("a missing effective setting never becomes implicit recall or auto-retain permission", async () => {
  missing = true; mount();
  await screen.findByText("记忆策略加载失败，未修改权限");
  expect(screen.queryByRole("button", { name: "保存记忆策略" })).not.toBeInTheDocument();
});

it("revocation is not blocked by an invalid unsaved future retention input", async () => {
  mount(); await screen.findByText(/修订 1/);
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "-1" } });
  fireEvent.click(screen.getByRole("button", { name: "撤销记忆能力" }));
  await screen.findByText(/deleted_deny/);
  expect(screen.getByLabelText("启用员工记忆")).not.toBeChecked();
});

it("rejects invalid retention and never shows failed reads or mutations as effective permission", async () => {
  fail = true;
  const view = mount(); await screen.findByText("记忆策略加载失败，未修改权限");
  expect(screen.queryByRole("button", { name: "保存记忆策略" })).not.toBeInTheDocument();
  view.unmount(); fail = false;
  mount(); await screen.findByText(/修订 1/);
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "保存记忆策略" }));
  await screen.findByText("保留天数须为1至36500的整数，留空表示无期限");
  expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "1" } });
  fail = true; fireEvent.click(screen.getByRole("button", { name: "保存记忆策略" }));
  await waitFor(() => expect(screen.getByText("记忆策略更新或重新读取失败，请重新打开确认；不视为已成功")).toBeInTheDocument());
  expect(screen.queryByText(/有效来源/)).not.toBeInTheDocument();
});
