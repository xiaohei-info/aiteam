/** 系统健康页 — 各服务状态一览。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { GlassPanel } from "@aiteam/shared/ui";
import { useSystemHealthApi } from "./useSystemHealthApi.js";
import type { SystemHealth } from "./types.js";

export function SystemHealthPage(): ReactNode {
  const api = useSystemHealthApi();
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setHealth(await api.getHealth()); } catch { /* ignore */ } finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>;

  if (!health) return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">暂无数据</GlassPanel>;

  const statusColor = (s: string) =>
    s === "up" || s === "healthy" ? "text-success" : s === "local" ? "text-info" : "text-danger";

  return (
    <section className="flex flex-col gap-md">
      <h1 className="m-0 text-xl font-bold text-text-primary">系统健康</h1>
      <GlassPanel className="rounded-window p-md">
        <div className="flex items-center gap-sm">
          <span className={`inline-block h-2 w-2 rounded-full ${health.status === "healthy" ? "bg-success" : "bg-danger"}`} />
          <span className={`text-sm font-bold ${statusColor(health.status)}`}>{health.status}</span>
          <span className="text-xs text-text-muted">{health.timestamp}</span>
        </div>
      </GlassPanel>
      <div className="grid grid-cols-3 gap-md">
        {Object.entries(health.services).map(([name, status]) => (
          <GlassPanel key={name} className="rounded-window p-md">
            <p className="m-0 text-xs text-text-muted">{name}</p>
            <p className={`m-0 mt-xs text-sm font-bold ${statusColor(status)}`}>{status}</p>
          </GlassPanel>
        ))}
      </div>
    </section>
  );
}
