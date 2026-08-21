/**
 * Agent pull/同步/用量辅助视图（#172）。
 * 展示已冻结快照 + 用量 outbox；触发配置同步。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useApp } from "../../lib/app-context";
import { flushUsage, listSnapshots, syncGrants, listOutbox, type FrozenSnapshot, type OutboxItem, type SyncResult, type UsageFlushResult } from "./useSyncApi";

export function SyncPage(): ReactNode {
  const { client, session } = useApp();
  const [snapshots, setSnapshots] = useState<FrozenSnapshot[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [flushing, setFlushing] = useState(false);
  const [flushResult, setFlushResult] = useState<UsageFlushResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [s, o] = await Promise.all([listSnapshots(client), listOutbox(client)]);
      setSnapshots(s); setOutbox(o); setDataLoaded(true);
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
      await load();
    } catch (err) { setError(err instanceof ApiError ? err.message : "同步失败"); }
    finally { setSyncing(false); }
  }

  async function handleFlush(): Promise<void> {
    if (!session) return;
    setFlushing(true);
    setError(null);
    setFlushResult(null);
    try {
      const result = await flushUsage(client);
      setFlushResult(result);
      await load();
    } catch (err) { setError(err instanceof ApiError ? err.message : "用量上报失败"); }
    finally { setFlushing(false); }
  }

  return (
    <VStack gap={4} role="region" aria-label="同步与用量">
      <HStack justify="between" align="center">
        <Heading level={1}>同步与用量</Heading>
        <HStack gap={2}>
          <Button type="button" label="立即同步" variant="primary" size="sm" onClick={handleSync} isLoading={syncing} isDisabled={!session || flushing} />
          <Button type="button" label="上报用量" variant="secondary" size="sm" onClick={handleFlush} isLoading={flushing} isDisabled={!session || syncing} />
        </HStack>
      </HStack>
      {syncResult && (
        <Banner status={syncResult.ok ? "success" : "warning"} title={`同步${syncResult.ok ? "成功" : "失败"}`} description={`新增 ${syncResult.upserted}，撤销 ${syncResult.revoked}${syncResult.error ? `（${syncResult.error}）` : ""}`} />
      )}
      {flushResult && (
        <Banner
          status={flushResult.failed.length > 0 ? "warning" : "success"}
          title="用量上报完成"
          description={`已上报 ${flushResult.sent.length}，失败 ${flushResult.failed.length}`}
          data-testid="usage-flush-result"
        />
      )}
      {error && <Banner status="error" title={error} />}
      {loading ? (
        <Banner status="info" title="加载中…" />
      ) : !dataLoaded ? null : (
        <>
          <Card padding={4}>
            <VStack gap={2}>
            <Heading level={2}>已冻结快照（{snapshots.length}）</Heading>
            {snapshots.length === 0 ? <EmptyState title="暂无快照" headingLevel={3} isCompact /> : (
                <table>
                  <thead><tr><th>员工</th><th>版本</th><th>快照版本</th></tr></thead>
                  <tbody>{snapshots.map((s) => <tr key={s.snapshot_version}><td>{s.display_name||s.employee_id}</td><td>{s.version}</td><td><Text type="code">{s.snapshot_version.slice(-8)}</Text></td></tr>)}</tbody>
                </table>
            )}
            </VStack>
          </Card>
          <Card padding={4}>
            <VStack gap={2}>
            <Heading level={2}>用量 Outbox（{outbox.length}）</Heading>
            {outbox.length === 0 ? <EmptyState title="暂无用量摘要" headingLevel={3} isCompact /> : (
                <table>
                  <thead><tr><th>类型</th><th>状态</th><th>尝试</th><th>错误</th></tr></thead>
                  <tbody>{outbox.map((o) => <tr key={o.summary_id}><td>{o.kind}</td><td>{o.status}</td><td>{o.attempts}</td><td>{o.last_error ?? "—"}</td></tr>)}</tbody>
                </table>
            )}
            </VStack>
          </Card>
        </>
      )}
    </VStack>
  );
}
