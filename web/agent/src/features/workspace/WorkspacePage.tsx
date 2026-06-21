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

import { useApp } from "../../lib/app-context";
import {
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

  const enabledCount = loops.filter((l) => l.status === "enabled").length;

  return (
    <div className="workspace-page">
      <h1>{i18n.t("agent.nav.workspace")}</h1>
      <p className="workspace-summary">
        {i18n.t("agent.workspace.summary")}: {conversations.length} · Loop {loops.length}（
        {enabledCount} {i18n.t("agent.workspace.enabled")}）
      </p>
      {actionError && <p className="workspace-error">{actionError}</p>}
      {error && <p className="workspace-error">{error}</p>}
      {loading && <p>{i18n.t("agent.workspace.loading")}</p>}

      <section>
        <h2>{i18n.t("agent.workspace.conversations_title")}</h2>
        {conversations.length === 0 ? (
          <p>{i18n.t("agent.workspace.conversations_empty")}</p>
        ) : (
          <ul className="workspace-conversations">
            {conversations.map((c) => (
              <li key={c.id} data-testid="ws-conversation">
                <Link to="/chat">{c.title || c.id}</Link> · {c.state}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>{i18n.t("agent.workspace.loops_title")}</h2>
        {loops.length === 0 ? (
          <p>{i18n.t("agent.workspace.loops_empty")}</p>
        ) : (
          <ul className="workspace-loops">
            {loops.map((l) => (
              <li key={l.id} data-testid="ws-loop">
                <span>
                  <strong>{l.title || l.id}</strong> · <code>{l.cron}</code> · {l.status}
                </span>
                {l.status === "enabled" ? (
                  <button type="button" onClick={() => void runLoopAction(() => disableLoop(client, l.id))}>
                    {i18n.t("agent.workspace.disable")}
                  </button>
                ) : (
                  <button type="button" onClick={() => void runLoopAction(() => enableLoop(client, l.id))}>
                    {i18n.t("agent.workspace.enable")}
                  </button>
                )}
                <button type="button" onClick={() => void runLoopAction(() => fireLoop(client, l.id))}>
                  {i18n.t("agent.workspace.fire")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
