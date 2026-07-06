/**
 * 专家实例列表页（AITEAM-683）。
 *
 * Manager 端查看本 tenant 已招募/落地的专家实例，点击行打开
 * {@link EmployeeConfigDrawer} 修改 LLM/provider 配置。
 *
 * 原占位（Deprecated）被本实现替代（AITEAM-356 时招募/实例入口收口到
 * /marketplace + /solutions；本卡恢复实例列表 + 详情配置能力）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Button, GlassPanel } from "@aiteam/shared/ui";
import { useI18n } from "../../i18n/context";
import { EmployeeConfigDrawer } from "./EmployeeConfigDrawer";
import { useExpertsApi } from "./useExpertsApi";
import type { EmployeeConfig } from "./types";

export function ExpertsPage(): ReactNode {
  const i18n = useI18n();
  const api = useExpertsApi();

  const [items, setItems] = useState<EmployeeConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await api.listEmployees());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.experts.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSaved = useCallback(
    (updated: EmployeeConfig) => {
      setItems((prev) => prev.map((e) => (e.employee_id === updated.employee_id ? updated : e)));
      setDetailId(null);
    },
    [],
  );

  return (
    <section className="flex flex-col gap-lg">
      <h1 className="m-0 text-xl font-bold text-text-primary">
        {i18n.t("manager.experts.instances_title")}
      </h1>

      {error && <GlassPanel className="rounded-window border border-danger/30 p-md text-sm text-danger">{error}</GlassPanel>}

      {loading ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">
          {i18n.t("manager.experts.loading")}
        </GlassPanel>
      ) : items.length === 0 ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">
          {i18n.t("manager.experts.instances_empty")}
        </GlassPanel>
      ) : (
        <GlassPanel className="overflow-hidden rounded-window">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gold/10 text-left text-xs text-text-secondary">
                <th className="px-md py-sm">{i18n.t("manager.experts.display_name")}</th>
                <th className="px-md py-sm">slug</th>
                <th className="px-md py-sm">{i18n.t("manager.experts.status_active")}</th>
                <th className="px-md py-sm">{i18n.t("manager.experts.provider_ref")}</th>
                <th className="px-md py-sm">{i18n.t("manager.experts.model")}</th>
                <th className="px-md py-sm">{i18n.t("manager.experts.config_status")}</th>
                <th className="px-md py-sm" />
              </tr>
            </thead>
            <tbody>
              {items.map((e) => {
                const configured = Boolean(e.model_policy.provider_ref && e.model_policy.model);
                return (
                  <tr
                    key={e.employee_id}
                    className="border-b border-gold/5 transition hover:bg-gold/5"
                    data-testid="employee-row"
                  >
                    <td className="px-md py-sm font-medium text-text-primary">{e.display_name}</td>
                    <td className="px-md py-sm"><code className="text-xs text-gold-bright">{e.employee_slug}</code></td>
                    <td className="px-md py-sm text-text-secondary">{e.status}</td>
                    <td className="px-md py-sm text-text-secondary">{e.model_policy.provider_ref ?? "—"}</td>
                    <td className="px-md py-sm text-text-secondary">{e.model_policy.model || "—"}</td>
                    <td className="px-md py-sm">
                      <span
                        className={`rounded-full px-sm py-xs text-xs ${
                          configured ? "bg-success/20 text-success" : "bg-warning/20 text-warning"
                        }`}
                        data-testid="config-status"
                      >
                        {configured
                          ? i18n.t("manager.experts.configured")
                          : i18n.t("manager.experts.unconfigured")}
                      </span>
                    </td>
                    <td className="px-md py-sm text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        data-testid="edit-config"
                        onClick={() => setDetailId(e.employee_id)}
                      >
                        {i18n.t("manager.experts.edit_config")}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </GlassPanel>
      )}

      {detailId && (
        <EmployeeConfigDrawer
          employeeId={detailId}
          onClose={() => setDetailId(null)}
          onSaved={onSaved}
        />
      )}
    </section>
  );
}
