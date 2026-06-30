/**
 * W-A.4 工作台页（08 §12.1）—— 本地总览入口。
 *
 * 两段全局总览：近期会话（跳转私聊）+ Loop 状态/调度（启停/立即触发）。
 * 展示态（loading/error）为组件局部运行态，不入持久化主状态（D6）。
 * 红线：本地会话/执行内容只在本机呈现，绝不上传控制面（D13）。
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "@aiteam/shared/api-client";
import { GlassPanel, Button } from "@aiteam/shared/ui";

import { useApp } from "../../lib/app-context";
import {
  createLoop,
  disableLoop,
  enableLoop,
  fireLoop,
  listConversations,
  listLoops,
  type Conversation,
  type Loop,
} from "./useWorkspaceApi";

export function WorkspacePage() {
  const { client, i18n } = useApp();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loops, setLoops] = useState<Loop[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, l] = await Promise.all([listConversations(client), listLoops(client)]);
      setConversations(c);
      setLoops(l);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("agent.workspace.load_error"));
    } finally {
      setLoading(false);
    }
  }, [client, i18n]);

  useEffect(() => {
    void load();
  }, [load]);

  const runLoopAction = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await fn();
        await load();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : i18n.t("agent.workspace.action_error"));
      }
    },
    [load, i18n],
  );

  const [showCreateLoop, setShowCreateLoop] = useState(false);
  const [newConvId, setNewConvId] = useState("");
  const [newCron, setNewCron] = useState("0 9 * * *");
  const [newTitle, setNewTitle] = useState("");

  const handleCreateLoop = useCallback(async () => {
    if (!newConvId.trim() || !newCron.trim()) return;
    try {
      await createLoop(client, {
        conversation_id: newConvId.trim(),
        cron: newCron.trim(),
        title: newTitle.trim() || undefined,
      });
      setShowCreateLoop(false);
      setNewConvId("");
      setNewCron("0 9 * * *");
      setNewTitle("");
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : i18n.t("agent.workspace.action_error"));
    }
  }, [client, newConvId, newCron, newTitle, load, i18n]);

  const enabledCount = loops.filter((l) => l.status === "enabled").length;

  return (
    <div className="flex flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <div className="flex items-center justify-between">
          <h1 className="m-0 text-xl font-bold text-text-primary">
            {i18n.t("agent.nav.workspace")}
          </h1>
          <Button size="sm" onClick={() => setShowCreateLoop(true)}>
            + {i18n.t("agent.workspace.create_loop")}
          </Button>
        </div>
        {showCreateLoop && (
          <GlassPanel className="flex flex-col gap-sm rounded-window p-md">
            <h3 className="m-0 text-sm font-semibold text-text-primary">{i18n.t("agent.workspace.create_loop_title")}</h3>
            <input className="rounded-md border border-gold/20 bg-surface px-md py-sm text-sm text-text-primary outline-none placeholder:text-text-muted" placeholder="会话 ID (conversation_id)" value={newConvId} onChange={(e) => setNewConvId(e.target.value)} />
            <input className="rounded-md border border-gold/20 bg-surface px-md py-sm text-sm text-text-primary font-mono outline-none placeholder:text-text-muted" placeholder="cron (e.g. 0 9 * * *)" value={newCron} onChange={(e) => setNewCron(e.target.value)} />
            <input className="rounded-md border border-gold/20 bg-surface px-md py-sm text-sm text-text-primary outline-none placeholder:text-text-muted" placeholder={i18n.t("agent.workspace.title_optional")} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            <div className="flex gap-sm">
              <Button size="sm" onClick={handleCreateLoop}>{i18n.t("agent.workspace.create")}</Button>
              <Button variant="ghost" size="sm" onClick={() => setShowCreateLoop(false)}>{i18n.t("agent.workspace.cancel")}</Button>
            </div>
          </GlassPanel>
        )}
        <p className="m-0 text-sm text-text-secondary">
          {i18n.t("agent.workspace.summary")}: {conversations.length} · Loop {loops.length}（
          {enabledCount} {i18n.t("agent.workspace.enabled")}）
        </p>
        {actionError && <p className="m-0 text-sm text-danger">{actionError}</p>}
        {error && <p className="m-0 text-sm text-danger">{error}</p>}
        {loading && <p className="m-0 text-sm text-text-muted">{i18n.t("agent.workspace.loading")}</p>}
      </header>

      <GlassPanel className="flex flex-col gap-sm rounded-window p-lg">
        <h2 className="m-0 text-base font-semibold text-gold">
          {i18n.t("agent.workspace.conversations_title")}
        </h2>
        {conversations.length === 0 ? (
          <p className="m-0 text-sm text-text-muted">
            {i18n.t("agent.workspace.conversations_empty")}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-xs p-0">
            {conversations.map((c) => (
              <li
                key={c.id}
                data-testid="ws-conversation"
                className="flex items-center gap-sm border-b border-gold/10 py-xs text-sm last:border-b-0"
              >
                <Link to="/chat" className="text-gold no-underline hover:underline">
                  {c.title || c.id}
                </Link>
                <span className="text-text-muted">· {c.state}</span>
              </li>
            ))}
          </ul>
        )}
      </GlassPanel>

      <GlassPanel className="flex flex-col gap-sm rounded-window p-lg">
        <h2 className="m-0 text-base font-semibold text-gold">
          {i18n.t("agent.workspace.loops_title")}
        </h2>
        {loops.length === 0 ? (
          <p className="m-0 text-sm text-text-muted">{i18n.t("agent.workspace.loops_empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-sm p-0">
            {loops.map((l) => (
              <li
                key={l.id}
                data-testid="ws-loop"
                className="flex flex-wrap items-center gap-sm border-b border-gold/10 py-sm last:border-b-0"
              >
                <span className="flex-1 text-sm text-text-secondary">
                  <strong className="text-text-primary">{l.title || l.id}</strong> ·{" "}
                  <code className="rounded-sm bg-surface px-xs text-xs text-text-muted">{l.cron}</code> ·{" "}
                  {l.status}
                </span>
                {l.status === "enabled" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void runLoopAction(() => disableLoop(client, l.id))}
                  >
                    {i18n.t("agent.workspace.disable")}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void runLoopAction(() => enableLoop(client, l.id))}
                  >
                    {i18n.t("agent.workspace.enable")}
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => void runLoopAction(() => fireLoop(client, l.id))}
                >
                  {i18n.t("agent.workspace.fire")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </GlassPanel>
    </div>
  );
}
