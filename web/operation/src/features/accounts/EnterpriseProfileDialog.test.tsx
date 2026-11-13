import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EnterpriseProfileDialog } from "./EnterpriseProfileDialog";
import type { AccountsApi } from "./useAccountsApi";
import type { EnterpriseAccount } from "./types";

const enterprise = { org_id: "ent-1", enterprise_name: "示例企业" } as EnterpriseAccount;

function makeApi(overrides: Partial<AccountsApi> = {}): AccountsApi {
  return {
    getProfile: vi.fn(async () => ({ enterprise_id: "ent-1", industry: "制造业", tags: ["华东", "KA"] })),
    setProfile: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as AccountsApi;
}

describe("EnterpriseProfileDialog", () => {
  it("加载现有行业与标签，保存时提交解析后的标签", async () => {
    const api = makeApi();
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<EnterpriseProfileDialog api={api} enterprise={enterprise} onClose={onClose} onDone={onDone} />);

    await waitFor(() => expect(screen.getByLabelText(/所属行业/)).toHaveValue("制造业"));
    expect(screen.getByLabelText(/企业标签/)).toHaveValue("华东, KA");

    fireEvent.change(screen.getByLabelText(/企业标签/), { target: { value: "华南，KA, KA,  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(api.setProfile).toHaveBeenCalledWith("ent-1", { industry: "制造业", tags: ["华南", "KA"] }));
    expect(onDone).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("清空行业提交 null；超限时拦截不发请求", async () => {
    const api = makeApi();
    render(<EnterpriseProfileDialog api={api} enterprise={enterprise} onClose={() => undefined} onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText(/所属行业/)).toHaveValue("制造业"));

    fireEvent.change(screen.getByLabelText(/企业标签/), { target: { value: "x".repeat(21) } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/标签最多 10 个/)).toBeInTheDocument();
    expect(api.setProfile).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/所属行业/), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/企业标签/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.setProfile).toHaveBeenCalledWith("ent-1", { industry: null, tags: [] }));
  });

  it("保存失败：留在弹窗并显示原因", async () => {
    const api = makeApi({ setProfile: vi.fn(async () => { throw new Error("保存被拒绝"); }) });
    const onClose = vi.fn();
    render(<EnterpriseProfileDialog api={api} enterprise={enterprise} onClose={onClose} onDone={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText(/所属行业/)).toHaveValue("制造业"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("保存被拒绝")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
