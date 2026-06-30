/**
 * W-A.2 Loop/任务编排面板（#312）。
 *
 * 展示会话维度的周期任务队列（Loop），支持：
 * - 创建 Loop（标题 + cron 表达式）
 * - 启用 / 停用（进 / 出调度器）
 * - 手动立即触发（fire now，不经 cron 判定）
 *
 * 展示态不入持久化主状态（D6）：只读 Loop 主状态（enabled/disabled、fire_count、
 * last_fired_at），不缓存 run 终态。run 终态走 RunsPanel / timeline。
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Button, Field, GlassPanel, Input, Table, cn } from "@aiteam/shared/ui";
import type { AgentApiClient } from "../../lib/api-client";
import {
  createLoop,
  disableLoop,
  enableLoop,
  fireLoopNow,
  listLoops,
  type Loop,
} from "./useLoopsApi";

interface Props {
  client: AgentApiClient;
  conversationId: string;
  refreshSignal?: number;
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function statusBadge(status: Loop["status"]): ReactNode {
  if (status === "enabled") {
    return <span className="text-success">● 启用</span>;
  }
  return <span className="text-text-muted">○ 停用</span>;
}

export function LoopPanel({ client, conversationId, refreshSignal = 0 }: Props): ReactNode {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 创建表单局部运行态（不落库、不持久化）
  const [title, setTitle] = useState("");
  const [cron, setCron] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const all = await listLoops(client);
      // 后端当前列全部 Loop；按 conversation_id 过滤到本会话
      setLoops(all.filter((l) => l.conversation_id === conversationId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载 Loop 失败");
    }
  }, [client, conversationId]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const onEnable = async (loopId: string) => {
    setBusy(true);
    setError(null);
    try {
      await enableLoop(client, loopId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "启用失败");
    } finally {
      setBusy(false);
    }
  };

  const onDisable = async (loopId: string) => {
    setBusy(true);
    setError(null);
    try {
      await disableLoop(client, loopId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "停用失败");
    } finally {
      setBusy(false);
    }
  };

  const onFire = async (loopId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fireLoopNow(client, loopId);
      if (!res.ok) setError(res.error ?? "触发失败");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "触发失败");
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setError(null);
    if (!cron.trim()) {
      setFormError("请填写 cron 表达式");
      return;
    }
    setBusy(true);
    try {
      await createLoop(client, {
        conversation_id: conversationId,
        cron: cron.trim(),
        title: title.trim() || null,
        enabled: false,
      });
      setTitle("");
      setCron("");
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassPanel className="flex flex-col gap-sm rounded-window">
      <div className="flex items-center justify-between px-md pt-sm">
        <span className="text-sm font-semibold text-text-primary">🦞 任务编排</span>
        <span className="text-xs text-text-muted">{loops.length} 个周期任务</span>
      </div>

      {error && <p className="mx-md text-xs text-danger">{error}</p>}

      {loops.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th>标题</th>
              <th>Cron</th>
              <th>状态</th>
              <th>触发</th>
              <th>最后触发</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {loops.map((l) => (
              <tr key={l.id}>
                <td className="text-sm">{l.title ?? <span className="text-text-muted">未命名</span>}</td>
                <td><code className="text-xs text-gold-bright">{l.cron}</code></td>
                <td>{statusBadge(l.status)}</td>
                <td className="text-xs text-text-secondary">{l.fire_count}</td>
                <td className="text-xs text-text-secondary">{formatTimestamp(l.last_fired_at)}</td>
                <td>
                  <div className="flex gap-xs">
                    {l.status === "disabled" ? (
                      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void onEnable(l.id)}>
                        启用
                      </Button>
                    ) : (
                      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void onDisable(l.id)}>
                        停用
                      </Button>
                    )}
                    <Button type="button" variant="metal" size="sm" disabled={busy || l.status === "disabled"} onClick={() => void onFire(l.id)}>
                      ▶ 触发
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <form className={cn("flex flex-col gap-sm border-t border-gold/10 px-md pb-sm", loops.length > 0 ? "pt-sm" : "pt-xs")} onSubmit={onCreate}>
        <div className="flex gap-sm">
          <Field label="标题" className="flex-1">
            <Input value={title} placeholder="可选，如 每日报告" onChange={(e) => setTitle(e.target.value)} disabled={busy} />
          </Field>
          <Field label="Cron 表达式" className="flex-1">
            <Input value={cron} placeholder="分 时 日 月 周，如 0 9 * * *" onChange={(e) => setCron(e.target.value)} disabled={busy} />
          </Field>
        </div>
        {formError && <p className="-mt-xs text-xs text-danger">{formError}</p>}
        <Button type="submit" variant="metal" size="sm" disabled={busy} className="self-end">
          + 创建 Loop
        </Button>
      </form>
    </GlassPanel>
  );
}
