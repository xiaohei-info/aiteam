/**
 * 私聊"新建对话"专家选择弹层。
 *
 * 行为：
 *  - 打开时先做一次 best-effort 授权同步（POST /api/agent/grants/sync），拉取 Manager
 *    端最新授权；sync 失败不阻断（保留本地离线降级），但会在顶部给出 Manager 端指向的
 *    错误提示（req 4），而非泛化的"加载失败"。
 *  - 从 GET /api/agent/grants/experts 拉取本地 roster，按配置完整度防呆（req 2）：
 *    model 与 provider_ref 齐全才可选；缺一则显示"待 Manager 配置"并禁用选择按钮。
 *  - 聚合每个专家的就绪状态（M5）：available=false 时禁用按钮并以后端 reasons 作为
 *    title 提示；readiness 拉取失败降级为空，不阻塞主列表。
 */

import { useEffect, useState } from "react";
import { Button, GlassPanel } from "@aiteam/shared/ui";

import type { LoadedExpertProjection } from "../group/useGroupApi";
import { listLoadedExperts, syncGrants } from "../group/useGroupApi";
import type { AgentApiClient } from "../../lib/api-client";
import { useApp } from "../../lib/app-context";
import {
  getReadinessReport,
  type ExpertReadiness,
  type ReadinessState,
} from "../readiness/useExpertReadinessApi";

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

// 配置完整度防呆（req 2）：model 与 provider_ref 齐全才视为可运行、可选择专家。
// 不在 Agent 端推断 provider（非目标），缺失即归因到 Manager 端配置。
const isConfigured = (p: LoadedExpertProjection) =>
  !!(p.model_policy?.model && p.model_policy?.provider_ref);

export function RosterPicker({ client, onPick, onCancel, busy, error }: RosterPickerProps) {
  const { session } = useApp();
  const [experts, setExperts] = useState<LoadedExpertProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // sync 失败是非致命提示（保留本地离线降级），与致命加载错误分开维护。
  const [syncError, setSyncError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<Record<string, ExpertReadiness | null>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSyncError(null);
    setLoadError(null);
    // Best-effort sync：主动 pull Manager 端最新授权。失败不阻断本地 roster 展示
    // （保留离线降级），但记录 Manager 端指向的错误供 UI 提示（req 3/4）。
    ;(async () => {
      if (session) {
        try {
          const r = await syncGrants(client, {
            tenant_id: session.claims.tenant_id ?? "",
            member_id: session.claims.user_id,
          });
          if (!r.ok && !cancelled) {
            setSyncError(r.error || "授权同步失败，请检查 Manager 端配置或授权。");
          }
        } catch {
          if (!cancelled) {
            setSyncError("授权同步失败，请检查 Manager 端配置或网络。");
          }
        }
      }
      try {
        const items = await listLoadedExperts(client);
        if (cancelled) return;
        setExperts(items.filter((p) => !p.revoked));
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "加载专家失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    // M5：聚合每个专家就绪状态；失败不阻塞主列表（降级为空）。
    Promise.resolve(getReadinessReport(client))
      .then((rep) => rep ?? null)
      .catch(() => null)
      .then((rep) => {
        if (cancelled || rep === null) return;
        const next: Record<string, ExpertReadiness | null> = {};
        for (const e of rep.experts) next[e.employee_id] = e;
        setReadiness(next);
      });

    return () => {
      cancelled = true;
    };
  }, [client, session]);

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
        {syncError && (
          <div className="py-sm text-sm text-text-secondary" role="status">
            {syncError}
          </div>
        )}
        {loadError && <div className="py-sm text-sm text-danger">{loadError}</div>}
        {error && <div className="py-sm text-sm text-danger" role="alert">{error}</div>}
        {!loading && !loadError && experts.length === 0 && !error && (
          <div className="py-sm text-sm text-text-muted">
            暂无可私聊的专家。请先在 Manager 端招募专家。
          </div>
        )}
        {!loading && !loadError && experts.length > 0 && (
          <ul className="flex list-none flex-col gap-sm overflow-auto p-0">
            {experts.map((p) => {
              const configured = isConfigured(p);
              const r = readiness[p.employee_id] ?? undefined;
              const blocked = r === undefined ? false : r.available === false;
              const disabled = busy || !configured || blocked;
              return (
                <li key={p.employee_id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-md border border-gold/15 bg-surface px-md py-sm text-left transition hover:border-gold/40 hover:bg-surface-raised disabled:opacity-60"
                    onClick={() => configured && !blocked && !busy && onPick(p)}
                    disabled={disabled}
                    aria-disabled={!configured || blocked}
                    title={
                      blocked
                        ? r?.reasons?.join("；") ?? "专家当前不可用"
                        : !configured
                          ? "待 Manager 配置"
                          : undefined
                    }
                  >
                    <span className="flex items-center gap-sm">
                      <span className="text-sm text-text-primary">{p.display_name}</span>
                      {r && (
                        <ReadinessDot
                          status={r.available ? "ready" : "blocked"}
                          label={r.available ? "可用" : "不可用"}
                        />
                      )}
                    </span>
                    <span className="flex items-center gap-sm">
                      {!configured && (
                        <span className="text-xs font-medium text-text-muted">待 Manager 配置</span>
                      )}
                      {p.runtime_binding && <span className="text-xs text-text-muted">{p.runtime_binding}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </GlassPanel>
    </div>
  );
}

interface ReadinessDotProps {
  status: ReadinessState;
  label: string;
}

/** 就绪状态小圆点 + 文案。颜色按 status 区分；仅作轻量提示，不替代 title 原因。 */
export function ReadinessDot({ status, label }: ReadinessDotProps): React.ReactNode {
  const dot =
    status === "ready"
      ? "bg-success"
      : status === "degraded"
        ? "bg-gold"
        : status === "blocked"
          ? "bg-danger"
          : "bg-text-muted";
  return (
    <span className="inline-flex items-center gap-xs text-xs text-text-muted" aria-label={`就绪：${label}`}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
