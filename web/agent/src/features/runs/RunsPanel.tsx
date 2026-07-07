/**
 * W-A.2 Run/Task 执行视图（#171）。
 * 展示会话维度的 run 列表 + task，支持取消 run。
 * 红线（D6）：只展示持久终态（RunStatus），不绑 runtime-native event。
 * AITEAM-693：每个 run 可展开查看追溯信息（snapshot_version / runtime / model / skills / knowledge / memory / connector）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Button, GlassPanel, Table } from "@aiteam/shared/ui";
import type { AgentApiClient } from "../../lib/api-client";
import {
  listRuns, listTasks, cancelRun, retryRun, getRunProvenance,
  type Run, type Task, type RunProvenance,
} from "./useRunsApi";

interface Props { client: AgentApiClient; conversationId: string; refreshSignal?: number; }

function statusColor(s: string): string {
  if (s === "succeeded" || s === "completed") return "text-success";
  if (s === "running" || s === "submitting") return "text-gold";
  if (s === "queued" || s === "routing") return "text-text-secondary";
  if (s === "waiting_human") return "text-gold-soft";
  if (s === "failed") return "text-danger";
  if (s === "cancelled") return "text-text-muted";
  return "text-text-secondary";
}

export function RunsPanel({ client, conversationId, refreshSignal = 0 }: Props): ReactNode {
  const [runs, setRuns] = useState<Run[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  // run_id -> provenance (loaded on demand)
  const [provenance, setProvenance] = useState<Record<string, RunProvenance | null | undefined>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loadingProv, setLoadingProv] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, t] = await Promise.all([listRuns(client, conversationId), listTasks(client, conversationId)]);
      setRuns(r); setTasks(t);
    } catch (err) { setError(err instanceof ApiError ? err.message : "加载失败"); }
  }, [client, conversationId]);

  useEffect(() => { void load(); }, [load, refreshSignal]);

  const toggle = useCallback(async (runId: string) => {
    setExpanded((prev) => {
      const next = { ...prev, [runId]: !prev[runId] };
      if (next[runId] && provenance[runId] === undefined && !loadingProv[runId]) {
        setLoadingProv((p) => ({ ...p, [runId]: true }));
        getRunProvenance(client, runId)
          .then((p) => setProvenance((pr) => ({ ...pr, [runId]: p })))
          .finally(() => setLoadingProv((lp) => ({ ...lp, [runId]: false })));
      }
      return next;
    });
  }, [provenance, loadingProv, client]);

  if (error) return <p className="m-0 text-xs text-danger">{error}</p>;
  if (runs.length === 0 && tasks.length === 0) return null;

  return (
    <div className="flex flex-col gap-sm">
      {runs.length > 0 && (
        <GlassPanel className="overflow-hidden rounded-window">
          <Table>
            <thead><tr><th>Run</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {runs.map((r) => {
                const open = expanded[r.id];
                const prov = provenance[r.id];
                return [
                  <tr key={r.id}>
                      <td><code className="text-xs text-gold-bright">{r.id.slice(-8)}</code></td>
                      <td>
                        <div className="flex flex-col">
                          <span className={statusColor(r.status)}>{r.status}</span>
                          {(r.trigger_type || r.execution_mode) && (
                            <span className="text-xs text-text-muted">{r.trigger_type}/{r.execution_mode}</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="flex gap-xs">
                          <Button type="button" variant="ghost" size="sm"
                            aria-expanded={open}
                            onClick={() => void toggle(r.id)}>
                            {open ? "收起" : "追溯"}
                          </Button>
                          {r.status === "running" && (
                            <Button type="button" variant="ghost" size="sm" onClick={async () => { await cancelRun(client, r.id); void load(); }}>取消</Button>
                          )}
                          {(r.status === "succeeded" || r.status === "completed" || r.status === "failed" || r.status === "cancelled") && (
                            <Button type="button" variant="ghost" size="sm" onClick={async () => { await retryRun(client, r.id); void load(); }}>重试</Button>
                          )}
                        </div>
                      </td>
                    </tr>,
                    open ? (
                      <tr key={`${r.id}-prov`}>
                        <td colSpan={3} className="bg-surface-raised/40">
                          <ProvenanceDetail prov={prov} loading={!!loadingProv[r.id]} run={r} />
                        </td>
                      </tr>
                    ) : null,
                  ];
              })}
            </tbody>
          </Table>
        </GlassPanel>
      )}
      {tasks.length > 0 && (
        <GlassPanel className="overflow-hidden rounded-window">
          <Table>
            <thead><tr><th>Task</th><th>状态</th></tr></thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td className="text-sm">{t.title}</td>
                  <td><span className={statusColor(t.status)}>{t.status}</span></td>
                </tr>
              ))}
            </tbody>
          </Table>
        </GlassPanel>
      )}
    </div>
  );
}

function ProvenanceDetail(
  { prov, loading, run }: {
    prov: RunProvenance | null | undefined;
    loading: boolean;
    run: Run;
  },
): ReactNode {
  if (loading || prov === undefined) {
    return <div className="px-md py-xs text-xs text-text-muted">加载追溯信息…</div>;
  }
  if (prov === null) {
    return <div className="px-md py-xs text-xs text-text-muted">无追溯信息（未绑定专家快照）</div>;
  }
  const b = prov.binding;
  const c = prov.capability;
  const kv: Array<[string, ReactNode]> = [
    ["快照版本", b.snapshot_version ?? "—"],
    ["快照来源", b.snapshot_source ?? "—"],
    ["runtime", b.runtime ?? "—"],
    ["provider", b.provider_ref ?? "—"],
    ["model", c.model ?? "—"],
    ["persona", c.persona_preview ?? "—"],
    ["skills", (b.skill_refs && b.skill_refs.length > 0) ? b.skill_refs.join(", ") : "—"],
    ["knowledge", (c.knowledge_refs && c.knowledge_refs.length > 0) ? c.knowledge_refs.join(", ") : "—"],
    ["connector", (c.connector_refs && c.connector_refs.length > 0) ? c.connector_refs.join(", ") : "—"],
    ["memory", c.memory_policy != null ? JSON.stringify(c.memory_policy) : "—"],
  ];
  void run;
  return (
    <dl className="grid grid-cols-2 gap-x-md gap-y-xs px-md py-xs text-xs">
      {kv.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-text-muted">{k}</dt>
          <dd className="text-text-primary break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
