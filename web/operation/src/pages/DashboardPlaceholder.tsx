/**
 * 运营端总览首页（W-O.1）。
 * GET /api/operation/rollups/board → 跨企业脱敏聚合看板。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, GlassPanel } from "@aiteam/shared/ui";
import { useI18n } from "../i18n/context";
import { type RollupBoard, useBoardApi } from "../features/board/useBoardApi";

function fmt(v: number): string { return v.toLocaleString("zh-CN"); }
function fmtCost(v: number | string): string {
  const yuan = Number(v) / 100;
  return yuan >= 10000 ? `${(yuan / 10000).toFixed(2)} 万元` : `¥${yuan.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}`;
}

function MetricCard({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <GlassPanel className="flex flex-col gap-xs rounded-window p-md">
      <span className="text-xs text-text-secondary">{label}</span>
      <span className="text-xl font-bold text-text-primary">{value}</span>
    </GlassPanel>
  );
}

export function DashboardPlaceholder(): ReactNode {
  const i18n = useI18n();
  const api = useBoardApi();
  const [board, setBoard] = useState<RollupBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setBoard(await api.getBoard()); }
    catch (err) { setError(err instanceof Error ? err.message : "加载失败"); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="flex flex-col gap-lg">
      <h1 className="m-0 text-xl font-bold text-text-primary">
        {i18n.t("operation.nav.dashboard")}
      </h1>
      {loading ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>
      ) : error ? (
        <GlassPanel className="flex flex-col gap-md rounded-window border border-danger/30 p-lg">
          <p className="m-0 text-sm text-danger">{error}</p>
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={load}>重试</Button>
        </GlassPanel>
      ) : board ? (
        <div className="grid grid-cols-2 gap-md md:grid-cols-3">
          <MetricCard label="企业数" value={fmt(board.enterprise_count)} />
          <MetricCard label="执行次数" value={fmt(board.run_count)} />
          <MetricCard label="总消耗" value={fmtCost(board.cost_total)} />
          <MetricCard label="总 Token" value={fmt(board.token_total)} />
          <MetricCard label="错误次数" value={fmt(board.error_count)} />
          <MetricCard label="总耗时（秒）" value={fmt(board.duration_seconds_total)} />
        </div>
      ) : (
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">暂无数据</GlassPanel>
      )}
    </section>
  );
}
