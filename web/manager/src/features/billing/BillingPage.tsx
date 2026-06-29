/** B04 工资管理页 — 用量总览 + 明细 + 充值。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, GlassPanel } from "@aiteam/shared/ui";
import { useBillingApi } from "./useBillingApi";
import type { UsageOverview, BillingBalance } from "./types";

const PERIODS = [{ key: "month", label: "本月" }, { key: "last_month", label: "上月" }, { key: "all", label: "全部" }];

export function BillingPage(): ReactNode {
  const api = useBillingApi();
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [balance, setBalance] = useState<BillingBalance | null>(null);
  const [period, setPeriod] = useState("month");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, bal] = await Promise.all([api.getOverview(period), api.getBalance()]);
      setOverview(ov); setBalance(bal);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [api, period]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="flex flex-col gap-md">
      <div className="flex items-center justify-between">
        <h1 className="m-0 text-xl font-bold text-text-primary">工资管理</h1>
        <div className="flex gap-xs">
          {PERIODS.map((p) => (
            <Button key={p.key} variant={period === p.key ? "metal" : "ghost"} size="sm" onClick={() => setPeriod(p.key)}>{p.label}</Button>
          ))}
        </div>
      </div>

      {balance && (
        <div className="grid grid-cols-3 gap-md">
          <GlassPanel className="rounded-window p-md"><p className="m-0 text-xs text-text-muted">账户余额</p><p className="m-0 mt-xs text-lg font-bold text-gold-bright">¥{balance.balance}</p></GlassPanel>
          <GlassPanel className="rounded-window p-md"><p className="m-0 text-xs text-text-muted">预估可用Token</p><p className="m-0 mt-xs text-lg font-bold text-text-primary">{balance.estimated_tokens}</p></GlassPanel>
          <GlassPanel className="rounded-window p-md"><p className="m-0 text-xs text-text-muted">更新时间</p><p className="m-0 mt-xs text-sm text-text-secondary">{balance.updated_at?.slice(0, 19)}</p></GlassPanel>
        </div>
      )}

      {overview && (
        <div className="grid grid-cols-3 gap-md">
          <GlassPanel className="rounded-window p-md"><p className="m-0 text-xs text-text-muted">总消耗Token</p><p className="m-0 mt-xs text-lg font-bold text-text-primary">{overview.total_tokens.toLocaleString()}</p></GlassPanel>
          <GlassPanel className="rounded-window p-md"><p className="m-0 text-xs text-text-muted">折合费用</p><p className="m-0 mt-xs text-lg font-bold text-gold-bright">¥{overview.total_cost}</p></GlassPanel>
          <GlassPanel className="rounded-window p-md"><p className="m-0 text-xs text-text-muted">消耗最高员工</p><p className="m-0 mt-xs text-sm text-text-secondary">{overview.top_employee_id ?? "—"}</p></GlassPanel>
        </div>
      )}

      {loading && <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>}
    </section>
  );
}
