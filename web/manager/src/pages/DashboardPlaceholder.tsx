/**
 * 企业概览首页（W-M.1）。
 * 接 /api/manager/usage/rollup/list + /audits → 企业计量/审计概览。
 * 红线（D13）：只展示脱敏聚合摘要，绝不含会话内容。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { GlassPanel, Table } from "@aiteam/shared/ui";
import { useI18n } from "../i18n/context";
import { useGovernanceApi } from "../features/governance/useGovernanceApi";
import type { UsageRollup, AuditSummary } from "../features/governance/types";

function fmt(v: number): string { return v.toLocaleString("zh-CN"); }
function fmtCost(v: number | string): string {
  const yuan = Number(v) / 100;
  return yuan >= 10000 ? `${(yuan/10000).toFixed(2)} 万元` : `¥${yuan.toLocaleString("zh-CN", {minimumFractionDigits:2})}`;
}

export function DashboardPlaceholder(): ReactNode {
  const i18n = useI18n();
  const api = useGovernanceApi();
  const [rollups, setRollups] = useState<UsageRollup[]>([]);
  const [audits, setAudits] = useState<AuditSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [r, a] = await Promise.all([api.listUsageRollups(), api.listAudits()]);
      setRollups(r); setAudits(a);
    } catch (err) { setError(err instanceof Error ? err.message : "加载失败"); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="flex flex-col gap-lg">
      <h1 className="m-0 text-xl font-bold text-text-primary">
        {i18n.t("manager.nav.dashboard")}
      </h1>
      {loading ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>
      ) : error ? (
        <GlassPanel className="rounded-window border border-danger/30 p-md text-sm text-danger">{error}</GlassPanel>
      ) : (
        <>
          <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
            <h2 className="m-0 text-base font-semibold text-text-primary">计量汇总（最近 {rollups.length} 条）</h2>
            {rollups.length === 0 ? (
              <p className="m-0 text-sm text-text-muted">暂无计量数据</p>
            ) : (
              <GlassPanel className="overflow-hidden rounded-window">
                <Table>
                  <thead><tr><th>员工</th><th>执行</th><th>Token</th><th>消耗</th><th>错误</th></tr></thead>
                  <tbody>
                    {rollups.slice(0, 5).map((r) => (
                      <tr key={r.rollup_id}>
                        <td>{r.employee_id ?? "—"}</td>
                        <td>{fmt(r.run_count)}</td>
                        <td>{fmt(r.token_total)}</td>
                        <td>{fmtCost(r.cost_total)}</td>
                        <td>{fmt(r.error_count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </GlassPanel>
            )}
          </GlassPanel>
          <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
            <h2 className="m-0 text-base font-semibold text-text-primary">审计事件（最近 {audits.length} 条）</h2>
            {audits.length === 0 ? (
              <p className="m-0 text-sm text-text-muted">暂无审计记录</p>
            ) : (
              <GlassPanel className="overflow-hidden rounded-window">
                <Table>
                  <thead><tr><th>操作者</th><th>动作</th><th>资源</th><th>时间</th></tr></thead>
                  <tbody>
                    {audits.slice(0, 5).map((a) => (
                      <tr key={a.event_id}>
                        <td>{a.actor}</td>
                        <td>{a.action}</td>
                        <td>{a.resource_type ? `${a.resource_type}/${a.resource_id}` : "—"}</td>
                        <td>{a.occurred_at}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </GlassPanel>
            )}
          </GlassPanel>
        </>
      )}
    </section>
  );
}
