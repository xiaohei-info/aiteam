import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n } from "@aiteam/shared";
import { I18nContext } from "../../i18n/context";
import { operationMessages } from "../../i18n/messages";
import { EnterpriseModelAccessDialog } from "./EnterpriseModelAccessDialog";
import type { AccountsApi } from "./useAccountsApi";
import type { EnterpriseAccount } from "./types";

const list = vi.fn().mockResolvedValue([
  { provider_id: "p1", provider_code: "newapi", display_name: "LLM 网关", api_protocol: "openai-completions", status: "published", version: 1, updated_at: "2026-01-01T00:00:00Z" },
]);
const models = vi.fn().mockResolvedValue([
  { model: { provider_id: "p1", model_id: "XingChenAGI/XingChenASR-V3.2-Ultra", display_name: "星辰 Ultra", capabilities: {}, status: "published", source: "discovery", version: 1, updated_at: "2026-01-01T00:00:00Z" }, rate: { pricing_status: "known", input_usd_per_million: "0", output_usd_per_million: "0" } },
]);

const providerApi = { list, models };

vi.mock("../providers/usePlatformProvidersApi", () => ({
  usePlatformProvidersApi: () => providerApi,
}));

const enterprise: EnterpriseAccount = {
  org_id: "ent-1", enterprise_name: "测试企业", contact_name: "负责人", contact_phone: "1",
  registered_at: "2026-01-01T00:00:00Z", total_recharged: "0", token_consumed: 0,
  status: "active", monthly_active: false,
};

function makeApi(): AccountsApi {
  return {
    list: vi.fn(), getDetail: vi.fn(), exportAll: vi.fn(), doAction: vi.fn(), getStats: vi.fn(),
    getLifecycleStatus: vi.fn(), changeLifecycle: vi.fn(), getQuota: vi.fn(), setQuota: vi.fn(),
    getModelAccess: vi.fn().mockResolvedValue({ enterprise_id: "ent-1", tenant_id: "tenant-1", allowed_model_refs: [] }),
    setModelAccess: vi.fn().mockResolvedValue({ enterprise_id: "ent-1", tenant_id: "tenant-1", allowed_model_refs: [] }),
    listAudits: vi.fn(),
  };
}

function renderDialog(api: AccountsApi, onDone = vi.fn(), onClose = vi.fn()) {
  const i18n = createI18n({ locale: "zh-CN", catalog: {} });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
  return render(
    <I18nContext.Provider value={i18n}>
      <MemoryRouter>
        <EnterpriseModelAccessDialog enterprise={enterprise} api={api} onClose={onClose} onDone={onDone} />
      </MemoryRouter>
    </I18nContext.Provider>,
  );
}

afterEach(() => vi.clearAllMocks());

beforeEach(() => {
  list.mockResolvedValue([
    { provider_id: "p1", provider_code: "newapi", display_name: "LLM 网关", api_protocol: "openai-completions", status: "published", version: 1, updated_at: "2026-01-01T00:00:00Z" },
  ]);
  models.mockResolvedValue([
    { model: { provider_id: "p1", model_id: "XingChenAGI/XingChenASR-V3.2-Ultra", display_name: "星辰 Ultra", capabilities: {}, status: "published", source: "discovery", version: 1, updated_at: "2026-01-01T00:00:00Z" }, rate: { pricing_status: "known", input_usd_per_million: "0", output_usd_per_million: "0" } },
  ]);
});

describe("EnterpriseModelAccessDialog", () => {
  it("保存显式空模型列表", async () => {
    const api = makeApi();
    renderDialog(api);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "开放全部已发布模型" })).not.toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "保存开放范围" }));
    await waitFor(() => expect(api.setModelAccess).toHaveBeenCalledWith("ent-1", []));
  });

  it("缺少模型开放接口时显示不可用提示", async () => {
    const api = makeApi();
    delete api.getModelAccess;
    renderDialog(api);
    expect(await screen.findByText("企业模型开放配置接口不可用")).toBeInTheDocument();
  });

  it("继承全部开放配置并支持切换后保存 null", async () => {
    const api = makeApi();
    api.getModelAccess = vi.fn().mockResolvedValue({ enterprise_id: "ent-1", tenant_id: "tenant-1", allowed_model_refs: null });
    renderDialog(api);
    const checkbox = await screen.findByRole("checkbox", { name: "开放全部已发布模型" });
    await waitFor(() => {
      expect(checkbox).toBeEnabled();
      expect(checkbox).toBeChecked();
    });
    fireEvent.change(checkbox, { target: { checked: false } });
    await waitFor(() => expect(checkbox).not.toBeChecked());
    fireEvent.change(checkbox, { target: { checked: true } });
    await waitFor(() => expect(checkbox).toBeChecked());
    await waitFor(() => expect(screen.getByRole("button", { name: "保存开放范围" })).toBeEnabled());
    const saveButton = screen.getByRole("button", { name: "保存开放范围" });
    fireEvent.click(saveButton);
    await waitFor(() => expect(api.setModelAccess).toHaveBeenCalledWith("ent-1", null));
  });

  it("目录加载失败时显示非 Error 的兜底提示", async () => {
    const api = makeApi();
    api.getModelAccess = vi.fn().mockRejectedValue("load failed");
    renderDialog(api);
    expect(await screen.findByText("模型目录加载失败")).toBeInTheDocument();
  });

  it("保存后的回调失败时保留弹窗并显示错误兜底", async () => {
    const api = makeApi();
    const onDone = vi.fn(() => { throw "save failed"; });
    renderDialog(api, onDone);
    await waitFor(() => expect(screen.getByRole("button", { name: "保存开放范围" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "保存开放范围" }));
    await waitFor(() => expect(api.setModelAccess).toHaveBeenCalledWith("ent-1", []));
    expect(onDone).toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "配置测试企业可用模型" })).toBeInTheDocument();
  });
});
