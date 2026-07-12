/**
 * W-A.2 Run/Task 执行视图（#171）。
 * 展示会话维度的 run 列表 + task，支持取消 run。
 * 红线（D6）：只展示持久终态（RunStatus），不绑 runtime-native event。
 * AITEAM-693：每个 run 可展开查看追溯信息（snapshot_version / runtime / model / skills / knowledge / memory / connector）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { AgentApiClient } from "../../lib/api-client";
import {
  listRuns, listTasks, cancelRun, retryRun, getRunProvenance,
  type Run, type Task, type RunProvenance,
} from "./useRunsApi";

interface Props { client: AgentApiClient; conversationId: string; refreshSignal?: number; }

function statusVariant(status: string): "success" | "warning" | "error" | "neutral" {
  if (status === "succeeded" || status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running" || status === "submitting" || status === "waiting_human") return "warning";
  return "neutral";
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

  if (error) return <Banner status="error" title={error} />;
  if (runs.length === 0 && tasks.length === 0) return null;

  return (
    <VStack gap={2} role="region" aria-label="运行与任务">
      {runs.length > 0 && (
        <Card padding={3}>
          <VStack gap={2}>
            <Text type="label">Run</Text>
          <table>
            <thead><tr><th>Run</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {runs.map((r) => {
                const open = expanded[r.id];
                const prov = provenance[r.id];
                return [
                  <tr key={r.id}>
                      <td><Text type="code">{r.id.slice(-8)}</Text></td>
                      <td>
                        <VStack gap={1}>
                          <Badge label={r.status} variant={statusVariant(r.status)} />
                          {(r.trigger_type || r.execution_mode) && (
                            <Text type="supporting">{r.trigger_type}/{r.execution_mode}</Text>
                          )}
                        </VStack>
                      </td>
                      <td>
                        <HStack gap={1} wrap="wrap">
                          <Button type="button" label={open ? "收起" : "追溯"} variant="secondary" size="sm"
                            aria-expanded={open}
                            onClick={() => void toggle(r.id)} />
                          {r.status === "running" && (
                            <Button type="button" label="取消" variant="secondary" size="sm" onClick={async () => { await cancelRun(client, r.id); void load(); }} />
                          )}
                          {(r.status === "succeeded" || r.status === "completed" || r.status === "failed" || r.status === "cancelled") && (
                            <Button type="button" label="重试" variant="secondary" size="sm" onClick={async () => { await retryRun(client, r.id); void load(); }} />
                          )}
                        </HStack>
                      </td>
                    </tr>,
                    open ? (
                      <tr key={`${r.id}-prov`}>
                        <td colSpan={3}>
                          <ProvenanceDetail prov={prov} loading={!!loadingProv[r.id]} run={r} />
                        </td>
                      </tr>
                    ) : null,
                  ];
            })}
            </tbody>
          </table>
          </VStack>
        </Card>
      )}
      {tasks.length > 0 && (
        <Card padding={3}>
          <VStack gap={2}>
            <Text type="label">Task</Text>
          <table>
            <thead><tr><th>Task</th><th>状态</th></tr></thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td><Badge label={t.status} variant={statusVariant(t.status)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          </VStack>
        </Card>
      )}
    </VStack>
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
    return <Text type="supporting" as="div">加载追溯信息…</Text>;
  }
  if (prov === null) {
    return <Text type="supporting" as="div">无追溯信息（未绑定专家快照）</Text>;
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
    <dl>
      {kv.map(([k, v]) => (
        <HStack as="div" key={k} gap={2}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </HStack>
      ))}
    </dl>
  );
}
