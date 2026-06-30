/**
 * W-A.2 Run/Task 执行视图（#171）。
 * 展示会话维度的 run 列表 + task，支持取消 run。
 * 红线（D6）：只展示持久终态（RunStatus），不绑 runtime-native event。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Button, GlassPanel, Table } from "@aiteam/shared/ui";
import type { AgentApiClient } from "../../lib/api-client";
import { listRuns, listTasks, cancelRun, retryRun, type Run, type Task } from "./useRunsApi";

interface Props { client: AgentApiClient; conversationId: string; refreshSignal?: number; }

function statusColor(s: string): string {
  if (s === "completed") return "text-success";
  if (s === "running") return "text-gold";
  if (s === "failed") return "text-danger";
  if (s === "cancelled") return "text-text-muted";
  return "text-text-secondary";
}

export function RunsPanel({ client, conversationId, refreshSignal = 0 }: Props): ReactNode {
  const [runs, setRuns] = useState<Run[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, t] = await Promise.all([listRuns(client, conversationId), listTasks(client, conversationId)]);
      setRuns(r); setTasks(t);
    } catch (err) { setError(err instanceof ApiError ? err.message : "加载失败"); }
  }, [client, conversationId]);

  useEffect(() => { void load(); }, [load, refreshSignal]);

  if (error) return <p className="m-0 text-xs text-danger">{error}</p>;
  if (runs.length === 0 && tasks.length === 0) return null;

  return (
    <div className="flex flex-col gap-sm">
      {runs.length > 0 && (
        <GlassPanel className="overflow-hidden rounded-window">
          <Table>
            <thead><tr><th>Run</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><code className="text-xs text-gold-bright">{r.id.slice(-8)}</code></td>
                  <td><span className={statusColor(r.status)}>{r.status}</span></td>
                  <td>
                    <div className="flex gap-xs">
                      {r.status === "running" && (
                        <Button type="button" variant="ghost" size="sm" onClick={async () => { await cancelRun(client, r.id); void load(); }}>取消</Button>
                      )}
                      {(r.status === "completed" || r.status === "failed" || r.status === "cancelled") && (
                        <Button type="button" variant="ghost" size="sm" onClick={async () => { await retryRun(client, r.id); void load(); }}>重试</Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
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
