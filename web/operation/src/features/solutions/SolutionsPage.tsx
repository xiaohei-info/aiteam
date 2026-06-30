import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { GlassPanel, Table } from "@aiteam/shared/ui";
import { useSolutionsApi } from "./useSolutionsApi";
import type { SolutionStat } from "./types";

export function SolutionsPage(): ReactNode {
  const api = useSolutionsApi();
  const [stats, setStats] = useState<SolutionStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStats(await api.getStats());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="flex flex-col gap-md">
      <h1 className="m-0 text-xl font-bold text-text-primary">行业方案统计</h1>
      {loading ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>
      ) : error ? (
        <GlassPanel className="rounded-window p-lg text-sm text-danger">{error}</GlassPanel>
      ) : stats.length === 0 ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">暂无方案数据</GlassPanel>
      ) : (
        <GlassPanel className="overflow-hidden rounded-window">
          <Table>
            <thead>
              <tr>
                <th>方案 ID</th>
                <th>方案名称</th>
                <th>应用次数</th>
                <th>活跃企业</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.solution_id}>
                  <td><code className="text-xs text-gold-bright">{s.solution_id}</code></td>
                  <td className="text-sm">{s.name}</td>
                  <td className="text-sm">{s.apply_count}</td>
                  <td className="text-sm">{s.active_enterprises}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </GlassPanel>
      )}
    </section>
  );
}
