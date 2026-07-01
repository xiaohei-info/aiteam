/** P09 办公室动态页 — 工位视图 + 状态摘要 + 定时任务 Feed。 */
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Button, GlassPanel } from "@aiteam/shared/ui";
import { useApp } from "../../lib/app-context";
import { getScene, getFeed } from "./useOfficeApi";
import { ScheduledJobs } from "./ScheduledJobs";
import type { OfficeScene, OfficeFeed } from "./types";

const STATUS_COLORS: Record<string, string> = { working: "text-warning", ready: "text-success", offline: "text-text-muted", busy: "text-danger" };
const STATUS_ICONS: Record<string, string> = { working: "⚡", ready: "●", offline: "○", busy: "🔄" };

export function OfficePage() {
  const { client } = useApp();
  const [scene, setScene] = useState<OfficeScene | null>(null);
  const [feed, setFeed] = useState<OfficeFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setScene(await getScene(client)); } catch (err) { setError(err instanceof ApiError ? err.message : "加载失败"); }
    finally { setLoading(false); }
  }, [client]);

  const loadFeed = useCallback(async () => {
    setFeedLoading(true); setFeedError(null);
    try { setFeed(await getFeed(client)); } catch (err) { setFeedError(err instanceof ApiError ? err.message : "动态加载失败"); }
    finally { setFeedLoading(false); }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>;
  if (error) return <GlassPanel className="rounded-window border border-danger/30 p-lg text-sm text-danger">{error}</GlassPanel>;
  if (!scene) return null;

  return (
    <section className="flex flex-col gap-md">
      <h1 className="m-0 text-xl font-bold text-text-primary">办公室动态</h1>

      <div className="grid grid-cols-4 gap-md">
        {Object.entries(scene.summary).map(([key, val]) => (
          <GlassPanel key={key} className="rounded-window p-md">
            <p className="m-0 text-xs text-text-muted">{key}</p>
            <p className={`m-0 mt-xs text-lg font-bold ${STATUS_COLORS[key] ?? "text-text-primary"}`}>{val}</p>
          </GlassPanel>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-md">
        {scene.employees.map((emp) => (
          <GlassPanel key={emp.employee_id} data-testid="office-employee" className="rounded-window p-md text-center">
            <div className="text-2xl">{STATUS_ICONS[emp.status] ?? "●"}</div>
            <p className="m-0 mt-xs text-sm font-bold text-text-primary">{emp.display_name}</p>
            <p className={`m-0 mt-xs text-xs ${STATUS_COLORS[emp.status] ?? "text-text-muted"}`}>{emp.status}</p>
            {emp.task && <p className="m-0 mt-xs text-xs text-text-muted">{emp.task}</p>}
          </GlassPanel>
        ))}
      </div>

      {scene.employees.length === 0 && <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">暂无员工</GlassPanel>}

      <div className="flex items-center gap-sm">
        <h2 className="m-0 text-base font-semibold text-text-primary">定时任务</h2>
        <Button variant="ghost" size="sm" disabled={feedLoading} onClick={() => void loadFeed()}>刷新</Button>
      </div>

      {feedError && <GlassPanel className="rounded-window border border-danger/30 p-md text-sm text-danger">{feedError}</GlassPanel>}

      {feedLoading && <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>}

      {feed && !feedLoading && (
        <ScheduledJobs jobs={feed.events.filter((e) => e.type === "scheduled_job")} />
      )}
    </section>
  );
}
