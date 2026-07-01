/**
 * SolutionApplyRecord 追踪页——方案应用历史/状态（AITEAM-266，upstream #316）。
 *
 * 企业此前无法追踪方案应用历史、查看落地状态、了解每个方案每次是谁/何时/以何版本落到本租户。
 * 本页把这些信息（源自后端 solution_apply_record 审计表）呈现为可扫读的列表：
 * 已落地方案实例 + 某方案的方案应用历史记录（who/when/version/status + 落地专家）。
 *
 * 只读页；写配置仍走「招募专家」页的操作。租户隔离由后端 TenantContext 裁决（D22），
 * 前端不拼 tenant 过滤、不跨端直调。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { GlassPanel } from "@aiteam/shared/ui";
import { useI18n } from "../../i18n/context";
import { useSolutionApplyApi } from "./useSolutionApplyApi";
import type { SolutionApplyRecord, SolutionInstanceSummary } from "./types";

const STATUS_STYLE: Record<string, string> = {
  applied: "bg-success/20 text-success",
  revoked: "bg-danger/20 text-danger",
};
const FALLBACK_STATUS_STYLE = "bg-text-muted/20 text-text-muted";

export function SolutionApplyHistoryPage(): ReactNode {
  const i18n = useI18n();
  const api = useSolutionApplyApi();
  const [instances, setInstances] = useState<SolutionInstanceSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [records, setRecords] = useState<SolutionApplyRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInstances = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setInstances(await api.listSolutionInstances());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.experts.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  const openRecords = useCallback(
    async (instanceId: string, solutionId: string) => {
      setActiveId(instanceId);
      setRecordsLoading(true);
      try {
        setRecords(await api.listApplyRecords(solutionId));
      } catch {
        setRecords([]);
      } finally {
        setRecordsLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void loadInstances();
  }, [loadInstances]);

  return (
    <section className="flex flex-col gap-lg">
      <div className="flex flex-wrap items-baseline justify-between gap-md">
        <h1 className="m-0 text-xl font-bold text-text-primary">
          {i18n.t("manager.solution_apply.title")}
        </h1>
        <p className="m-0 text-sm text-text-muted">
          {i18n.t("manager.solution_apply.description")}
        </p>
      </div>

      {error && (
        <GlassPanel className="rounded-window p-md text-sm text-danger" role="alert">
          {error}
        </GlassPanel>
      )}

      {loading ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">
          {i18n.t("manager.experts.loading")}
        </GlassPanel>
      ) : instances.length === 0 ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">
          {i18n.t("manager.solution_apply.empty_instances")}
        </GlassPanel>
      ) : (
        <GlassPanel className="flex flex-col divide-y divide-gold/10 overflow-hidden rounded-window">
          {instances.map((instance) => {
            const open = activeId === instance.id;
            return (
              <div key={instance.id} data-testid="instance-row" className="flex flex-col gap-sm px-lg py-md">
                <div className="flex flex-wrap items-center gap-sm">
                  <span className="font-semibold text-text-primary">
                    {instance.display_name || instance.solution_id}
                  </span>
                  <code className="text-xs text-gold-bright">
                    {instance.solution_id}
                    {instance.solution_version ? `@${instance.solution_version}` : ""}
                  </code>
                  <span className="text-xs text-text-muted">{instance.status}</span>
                  <button
                    type="button"
                    aria-expanded={open}
                    className="ml-auto text-xs text-gold underline"
                    onClick={() => void openRecords(instance.id, instance.solution_id)}
                  >
                    {i18n.t("manager.solution_apply.view_history")}
                  </button>
                </div>
                {open ? (
                  <ApplyRecords records={records} loading={recordsLoading} i18n={i18n} />
                ) : null}
              </div>
            );
          })}
        </GlassPanel>
      )}
    </section>
  );
}

function ApplyRecords({
  records,
  loading,
  i18n,
}: {
  records: SolutionApplyRecord[];
  loading: boolean;
  i18n: ReturnType<typeof useI18n>;
}): ReactNode {
  if (loading) {
    return <p className="m-0 text-sm text-text-secondary">{i18n.t("manager.experts.loading")}</p>;
  }
  if (records.length === 0) {
    return (
      <p className="m-0 text-sm text-text-muted">{i18n.t("manager.solution_apply.empty_records")}</p>
    );
  }
  return (
    <div className="flex flex-col gap-sm">
      {records.map((record) => {
        const statusStyle = STATUS_STYLE[record.status] ?? FALLBACK_STATUS_STYLE;
        return (
          <div
            key={record.id}
            data-testid="apply-record-row"
            className="flex flex-col gap-xs rounded-md bg-surface/60 px-md py-sm"
          >
            <div className="flex flex-wrap items-center gap-sm">
              <span className={`text-xs px-sm py-xs rounded-full ${statusStyle}`} data-testid="apply-record-status">
                {i18n.t(`manager.solution_apply.status.${record.status}`)}
              </span>
              <span className="text-xs text-text-secondary">
                {record.solution_version ? `v${record.solution_version}` : "—"}
              </span>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-md gap-y-xs text-xs">
              <dt className="text-text-muted">{i18n.t("manager.solution_apply.applied_by")}</dt>
              <dd className="m-0 text-text-primary">{record.applied_by ?? "—"}</dd>
              <dt className="text-text-muted">{i18n.t("manager.solution_apply.applied_at")}</dt>
              <dd className="m-0 text-text-primary">{record.created_at?.slice(0, 19) ?? "—"}</dd>
              <dt className="text-text-muted">{i18n.t("manager.solution_apply.expert_count")}</dt>
              <dd className="m-0 text-text-primary">{record.expert_instance_ids.length}</dd>
            </dl>
            {record.expert_instance_ids.length > 0 ? (
              <div className="flex flex-wrap gap-xs">
                {record.expert_instance_ids.map((id) => (
                  <code key={id} className="text-xs bg-surface px-sm py-0.5 rounded">
                    {id}
                  </code>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
