/** 审计事件页 — 事件列表。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { GlassPanel } from "@aiteam/shared/ui";
import { useAuditApi } from "./useAuditApi";
import type { AuditEvent } from "./types";

export function AuditPage(): ReactNode {
  const api = useAuditApi();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEvents(await api.list());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "审计事件加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  if (loading) return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>;

  return (
    <section className="flex flex-col gap-md">
      <h1 className="m-0 text-xl font-bold text-text-primary">审计事件</h1>
      {error && <GlassPanel className="rounded-window p-md text-sm text-danger">{error}</GlassPanel>}
      {events.length === 0 ? <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">暂无审计事件</GlassPanel> :
        <GlassPanel className="rounded-window p-md">
          <table className="w-full text-sm"><thead><tr className="border-b border-gold/15 text-left text-xs text-text-muted"><th className="pb-sm">事件类型</th><th className="pb-sm">操作者</th><th className="pb-sm">目标</th><th className="pb-sm">时间</th></tr></thead>
            <tbody>{events.map((e) => (<tr key={e.event_id} className="border-b border-gold/5" data-testid="audit-row"><td className="py-sm text-text-primary">{e.event_type}</td><td className="py-sm text-text-secondary">{e.actor_id ?? "—"}</td><td className="py-sm text-text-secondary">{e.target_type}/{e.target_id}</td><td className="py-sm text-text-muted">{e.created_at?.slice(0, 19)}</td></tr>))}</tbody>
          </table>
        </GlassPanel>}
    </section>
  );
}
