/** S04 财务管理页 — 总览指标 + 报表明细面板。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, GlassPanel } from "@aiteam/shared/ui";
import { useFinanceApi } from "./useFinanceApi.js";
import { FinanceReportsPanel } from "./FinanceReportsPanel.js";
import type { FinanceOverview, FinanceReport } from "./types.js";

const PERIODS = [
  { key: "month", label: "本月" },
  { key: "quarter", label: "本季" },
  { key: "year", label: "本年" },
  { key: "all", label: "全部" },
];

export function FinancePage(): ReactNode {
  const api = useFinanceApi();
  const [overview, setOverview] = useState<FinanceOverview | null>(null);
  const [reports, setReports] = useState<FinanceReport | null>(null);
  const [period, setPeriod] = useState("month");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const nextPeriod = period;
    try {
      const [ov, rp] = await Promise.all([
        api.getOverview(nextPeriod).catch((err) => {
          throw err instanceof Error ? err : new Error("加载失败");
        }),
        api.getReports(nextPeriod),
      ]);
      if (nextPeriod !== period) return;
      setOverview(ov);
      setReports(rp);
    } catch (err) {
      if (nextPeriod !== period) return;
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      if (nextPeriod === period) setLoading(false);
    }
  }, [api, period]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="flex flex-col gap-md">
      <div className="flex items-center justify-between">
        <h1 className="m-0 text-xl font-bold text-text-primary">财务管理</h1>
        <div className="flex gap-xs">
          {PERIODS.map((p) => (
            <Button key={p.key} variant={period === p.key ? "metal" : "ghost"} size="sm" onClick={() => setPeriod(p.key)}>
              {p.label}
            </Button>
          ))}
        </div>
      </div>

      {loading ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>
      ) : error ? (
        <GlassPanel className="rounded-window border border-danger/30 p-lg text-sm text-danger">{error}</GlassPanel>
      ) : overview ? (
        <>
          <div className="grid grid-cols-4 gap-md">
            {[
              { label: "总充值金额", value: `¥${overview.total_recharged}`, accent: "text-gold-bright" },
              { label: "实际调用量", value: `${(overview.total_tokens_billed / 1e9).toFixed(1)}B`, accent: "text-text-primary" },
              { label: "利润", value: `¥${overview.gross_profit}`, accent: "text-success" },
              { label: "利润率", value: `${overview.profit_margin.toFixed(1)}%`, accent: "text-info" },
            ].map((c) => (
              <GlassPanel key={c.label} className="rounded-window p-md">
                <p className="m-0 text-xs text-text-muted">{c.label}</p>
                <p className={`m-0 mt-xs text-lg font-bold ${c.accent}`}>{c.value}</p>
              </GlassPanel>
            ))}
          </div>

          {overview.top5_consumers.length > 0 && (
            <GlassPanel className="rounded-window p-md">
              <h2 className="m-0 mb-sm text-sm font-bold text-text-primary">TOP 5 消费企业</h2>
              {overview.top5_consumers.map((c, i) => (
                <div key={i} className="flex justify-between border-b border-gold/5 py-xs text-sm">
                  <span className="text-text-secondary">{i + 1}. {String(c.name ?? c.enterprise_name ?? "")}</span>
                  <span className="text-gold-bright">¥{String(c.amount ?? c.cost ?? "")}</span>
                </div>
              ))}
            </GlassPanel>
          )}

          {reports ? <FinanceReportsPanel reports={reports} /> : null}
        </>
      ) : null}
    </section>
  );
}
