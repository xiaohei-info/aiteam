/**
 * Agent pull/同步/用量辅助视图（#172）。
 * 展示已冻结快照 + 用量 outbox；触发配置同步。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Button, GlassPanel, Table } from "@aiteam/shared/ui";
import { useApp } from "../../lib/app-context";
import { listSnapshots, syncGrants, listOutbox, type FrozenSnapshot, type OutboxItem, type SyncResult } from "./useSyncApi";

export function SyncPage(): ReactNode {
  const { client, session, i18n } = useApp();
  const [snapshots, setSnapshots] = useState<FrozenSnapshot[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [s, o] = await Promise.all([listSnapshots(client), listOutbox(client)]);
      setSnapshots(s); setOutbox(o);
    } catch (err) { setError(err instanceof ApiError ? err.message : "加载失败"); }
    finally { setLoading(false); }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  async function handleSync(): Promise<void> {
    if (!session) return;
    setSyncing(true); setSyncResult(null);
    try {
      const r = await syncGrants(client, session.claims.tenant_id ?? "", session.claims.user_id);
      setSyncResult(r);
      void load();
    } catch (err) { setError(err instanceof ApiError ? err.message : "同步失败"); }
    finally { setSyncing(false); }
  }

  return (
    <section className="flex flex-col gap-lg">
      <div className="flex items-center justify-between gap-md">
        <h1 className="m-0 text-xl font-bold text-text-primary">同步与用量</h1>
        <Button type="button" variant="ghost" size="sm" onClick={handleSync} disabled={syncing || !session}>
          {syncing ? "同步中…" : "立即同步"}
        </Button>
      </div>
      {syncResult && (
        <GlassPanel className={`rounded-window p-md text-sm ${syncResult.ok ? "text-success" : "text-warning"}`}>
          同步{syncResult.ok ? "成功" : "失败"}：新增 {syncResult.upserted}，撤销 {syncResult.revoked}{syncResult.error ? `（${syncResult.error}）` : ""}
        </GlassPanel>
      )}
      {error && <GlassPanel className="rounded-window border border-danger/30 p-md text-sm text-danger">{error}</GlassPanel>}
      {loading ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>
      ) : (
        <>
          <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
            <h2 className="m-0 text-base font-semibold text-text-primary">已冻结快照（{snapshots.length}）</h2>
            {snapshots.length === 0 ? <p className="m-0 text-sm text-text-muted">暂无快照</p> : (
              <GlassPanel className="overflow-hidden rounded-window">
                <Table>
                  <thead><tr><th>员工</th><th>版本</th><th>快照版本</th></tr></thead>
                  <tbody>{snapshots.map((s) => <tr key={s.snapshot_version}><td>{s.display_name||s.employee_id}</td><td>{s.version}</td><td><code className="text-xs text-gold-bright">{s.snapshot_version.slice(-8)}</code></td></tr>)}</tbody>
                </Table>
              </GlassPanel>
            )}
          </GlassPanel>
          <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
            <h2 className="m-0 text-base font-semibold text-text-primary">用量 Outbox（{outbox.length}）</h2>
            {outbox.length === 0 ? <p className="m-0 text-sm text-text-muted">暂无待发摘要</p> : (
              <GlassPanel className="overflow-hidden rounded-window">
                <Table>
                  <thead><tr><th>类型</th><th>状态</th><th>尝试</th></tr></thead>
                  <tbody>{outbox.map((o) => <tr key={o.summary_id}><td>{o.kind}</td><td>{o.status}</td><td>{o.attempts}</td></tr>)}</tbody>
                </Table>
              </GlassPanel>
            )}
          </GlassPanel>
        </>
      )}
    </section>
  );
}
