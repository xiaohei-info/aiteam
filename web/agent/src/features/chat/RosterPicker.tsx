/**
 * 私聊"新建对话"专家选择弹层。
 *
 * 从 GET /api/agent/grants/experts 拉取 roster，点击任一非已吊销专家即回调
 * onPick(expert)，由父组件调用 createConversation({ entry_employee_id, title })
 * 建会话并选中进入聊天。
 */

import { useEffect, useState } from "react";
import { Button, GlassPanel } from "@aiteam/shared/ui";

import type { LoadedExpertProjection } from "../group/useGroupApi";
import { listLoadedExperts } from "../group/useGroupApi";
import type { AgentApiClient } from "../../lib/api-client";

export interface RosterPickerProps {
  client: AgentApiClient;
  /** 选中专家后回调（父组件据此建会话）。 */
  onPick: (expert: LoadedExpertProjection) => void;
  /** 取消/关闭弹层。 */
  onCancel: () => void;
  /** 创建进行中（禁用选择按钮，避免重复提交）。 */
  busy?: boolean;
  /** 建会话失败时的错误文案（来自父组件 useApiError）。 */
  error?: string | null;
}

export function RosterPicker({ client, onPick, onCancel, busy, error }: RosterPickerProps) {
  const [experts, setExperts] = useState<LoadedExpertProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listLoadedExperts(client)
      .then((items) => {
        if (cancelled) return;
        setExperts(items.filter((p) => !p.revoked));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "加载专家失败");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Esc 关闭弹层。
  useEffect(() => {
    if (busy) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[1400] flex items-center justify-center bg-black/40 p-md"
      onClick={() => !busy && onCancel()}
      role="dialog"
      aria-modal="true"
      aria-label="选择专家开始私聊"
    >
      <GlassPanel
        className="flex max-h-[80vh] w-full max-w-md flex-col gap-md rounded-window p-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-text-primary">选择专家开始私聊</h2>
          <Button type="button" variant="ghost" size="sm" aria-label="关闭" onClick={onCancel} disabled={busy}>
            ✕
          </Button>
        </div>
        {loading && <div className="py-sm text-sm text-text-secondary">加载中…</div>}
        {loadError && <div className="py-sm text-sm text-danger">{loadError}</div>}
        {error && <div className="py-sm text-sm text-danger" role="alert">{error}</div>}
        {!loading && !loadError && experts.length === 0 && !error && (
          <div className="py-sm text-sm text-text-muted">
            暂无可私聊的专家。请先在 Manager 端招募专家。
          </div>
        )}
        {!loading && !loadError && experts.length > 0 && (
          <ul className="flex list-none flex-col gap-sm overflow-auto p-0">
            {experts.map((p) => (
              <li key={p.employee_id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-md border border-gold/15 bg-surface px-md py-sm text-left transition hover:border-gold/40 hover:bg-surface-raised disabled:opacity-60"
                  onClick={() => onPick(p)}
                  disabled={busy}
                >
                  <span className="text-sm text-text-primary">{p.display_name}</span>
                  {p.runtime_binding && <span className="text-xs text-text-muted">{p.runtime_binding}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </GlassPanel>
    </div>
  );
}
