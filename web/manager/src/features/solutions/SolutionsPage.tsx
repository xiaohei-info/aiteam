/**
 * 方案目录页（AITEAM-290 / GH#404）。
 *
 * 独立的行业方案入口：方案目录浏览 + 查看详情 + 一键应用 + 已应用方案实例只读展示。
 * 应用方案后提示可前往专家实例配置 Provider / LLM（AITEAM-683）。
 *
 * 设计对齐 PRD B06：方案定义在 Operator 端，Manager 端只可查看方案详情与应用方案，
 * 不能再编辑方案内容（不再提供实例编辑入口）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Button, GlassPanel } from "@aiteam/shared/ui";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useExpertsApi } from "../experts/useExpertsApi";
import type { SolutionInstance, SolutionPackage } from "../experts/types";

export function SolutionsPage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useExpertsApi();

  const [solutions, setSolutions] = useState<SolutionPackage[]>([]);
  const [solutionInstances, setSolutionInstances] = useState<SolutionInstance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<SolutionPackage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, si] = await Promise.all([api.listSolutions(), api.listSolutionInstances()]);
      setSolutions(s);
      setSolutionInstances(si);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.experts.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => { void load(); }, [load]);

  const runAction = useCallback(
    async (fn: () => Promise<unknown>, successKey: string) => {
      setActionError(null);
      setNotice(null);
      try {
        await fn();
        setNotice(i18n.t(successKey));
        await load();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : i18n.t("manager.experts.action_error"));
      }
    },
    [i18n, load],
  );

  return (
    <section className="flex flex-col gap-lg">
      <h1 className="m-0 text-xl font-bold text-text-primary">{i18n.t("manager.nav.solutions")}</h1>
      {notice && (
        <p className="m-0 flex flex-wrap items-center gap-sm text-sm text-success" role="status">
          <span>{notice}</span>
          <Link to="/experts" className="text-gold-bright underline" data-testid="goto-experts">
            {i18n.t("manager.experts.edit_config")}
          </Link>
        </p>
      )}
      {actionError && <p className="m-0 text-sm text-danger">{actionError}</p>}
      {error && <p className="m-0 text-sm text-danger">{error}</p>}
      {loading && <p className="m-0 text-sm text-text-secondary">{i18n.t("manager.experts.loading")}</p>}

      <div className="flex flex-col gap-md">
        <h2 className="m-0 text-base font-semibold text-text-primary">{i18n.t("manager.experts.solutions_title")}</h2>
        {solutions.length === 0 ? (
          <GlassPanel className="rounded-window p-lg text-sm text-text-muted">{i18n.t("manager.experts.solutions_empty")}</GlassPanel>
        ) : (
          <GlassPanel className="flex flex-col divide-y divide-gold/10 overflow-hidden rounded-window">
            {solutions.map((s) => (
              <div key={`${s.solution_id}@${s.version}`} data-testid="solution-row"
                className="flex flex-wrap items-center gap-sm px-lg py-md">
                <span className="font-medium text-text-primary">{s.display_name}</span>
                <code className="text-xs text-gold-bright">{s.solution_id}</code>
                <span className="ml-auto flex items-center gap-sm">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setDetailFor(s)}>
                    {i18n.t("manager.experts.view_detail")}
                  </Button>
                  {canWrite && (
                    <Button type="button" variant="ghost" size="sm"
                      onClick={() => void runAction(() => api.applySolution({ solution_id: s.solution_id }), "manager.experts.apply_ok")}>
                      {i18n.t("manager.experts.apply")}
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </GlassPanel>
        )}
      </div>

      <div className="flex flex-col gap-md">
        <h2 className="m-0 text-base font-semibold text-text-primary">{i18n.t("manager.experts.solution_instances_title")}</h2>
        {solutionInstances.length === 0 ? (
          <GlassPanel className="rounded-window p-lg text-sm text-text-muted">{i18n.t("manager.experts.solution_instances_empty")}</GlassPanel>
        ) : (
          solutionInstances.map((si) => (
            <SolutionInstanceCard key={si.id} instance={si} />
          ))
        )}
      </div>

      {detailFor && (
        <SolutionDetailOverlay
          solution={detailFor}
          onClose={() => setDetailFor(null)}
        />
      )}
    </section>
  );
}

function SolutionDetailOverlay({ solution, onClose }: {
  solution: SolutionPackage; onClose: () => void;
}): ReactNode {
  const i18n = useI18n();
  const experts = solution.experts ?? [];
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-lg backdrop-blur-sm" role="dialog" aria-modal="true" onClick={onClose}>
      <GlassPanel className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-window p-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-lg flex items-start justify-between gap-md">
          <div>
            <h2 className="m-0 text-lg font-semibold text-text-primary">{solution.display_name}</h2>
            <code className="text-xs text-gold-bright">{solution.solution_id}@{solution.version}</code>
          </div>
          <button type="button" aria-label={i18n.t("manager.common.close")} onClick={onClose}
            className="rounded-md px-sm py-xs text-text-muted transition hover:bg-surface hover:text-text-primary">✕</button>
        </div>

        {solution.tags && solution.tags.length > 0 && (
          <div className="mb-md flex flex-wrap gap-xs">
            {solution.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-gold/15 px-sm py-xs text-xs text-gold-bright">{tag}</span>
            ))}
          </div>
        )}

        {experts.length > 0 && (
          <div className="mb-lg">
            <h3 className="mb-sm text-xs font-semibold text-text-secondary">{i18n.t("manager.experts.detail_experts")}</h3>
            <div className="flex flex-col gap-sm">
              {experts.map((e) => (
                <div key={`${e.template_id}@${e.version}`} className="rounded-md border border-gold/15 px-md py-sm">
                  <div className="flex items-center gap-sm">
                    <span className="font-medium text-sm text-text-primary">{e.display_name}</span>
                    {e.category && (
                      <span className="text-xs text-text-muted">{e.category}</span>
                    )}
                  </div>
                  {e.persona && <p className="m-0 mt-xs text-xs text-text-secondary">{e.persona}</p>}
                </div>
              ))}
            </div>
          </div>
        )}
        {experts.length === 0 && (
          <p className="mb-lg text-sm text-text-muted">{i18n.t("manager.experts.detail_no_experts")}</p>
        )}

        {solution.knowledge_refs && solution.knowledge_refs.length > 0 && (
          <div className="mb-lg">
            <h3 className="mb-xs text-xs font-semibold text-text-secondary">{i18n.t("manager.experts.detail_knowledge_refs")}</h3>
            <div className="flex flex-wrap gap-xs">
              {solution.knowledge_refs.map((k) => (
                <code key={k} className="rounded bg-surface px-sm py-xs text-xs text-gold-bright">{k}</code>
              ))}
            </div>
          </div>
        )}

        {solution.skill_refs && solution.skill_refs.length > 0 && (
          <div className="mb-lg">
            <h3 className="mb-xs text-xs font-semibold text-text-secondary">{i18n.t("manager.experts.detail_skill_refs")}</h3>
            <div className="flex flex-wrap gap-xs">
              {solution.skill_refs.map((s) => (
                <code key={s} className="rounded bg-surface px-sm py-xs text-xs text-gold-bright">{s}</code>
              ))}
            </div>
          </div>
        )}

        {(solution.planner_prompt || solution.subtask_prompt || solution.aggregate_prompt) && (
          <div className="mb-lg flex flex-col gap-md">
            <h3 className="text-xs font-semibold text-text-secondary">{i18n.t("manager.experts.planner_prompt")}</h3>
            {solution.planner_prompt && (
              <div>
                <p className="m-0 mb-xs text-xs font-medium text-text-primary">{i18n.t("manager.experts.planner_prompt")}</p>
                <p className="m-0 whitespace-pre-wrap rounded-md bg-surface px-md py-sm text-xs text-text-secondary">{solution.planner_prompt}</p>
              </div>
            )}
            {solution.subtask_prompt && (
              <div>
                <p className="m-0 mb-xs text-xs font-medium text-text-primary">{i18n.t("manager.experts.subtask_prompt")}</p>
                <p className="m-0 whitespace-pre-wrap rounded-md bg-surface px-md py-sm text-xs text-text-secondary">{solution.subtask_prompt}</p>
              </div>
            )}
            {solution.aggregate_prompt && (
              <div>
                <p className="m-0 mb-xs text-xs font-medium text-text-primary">{i18n.t("manager.experts.aggregate_prompt")}</p>
                <p className="m-0 whitespace-pre-wrap rounded-md bg-surface px-md py-sm text-xs text-text-secondary">{solution.aggregate_prompt}</p>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-sm">
          <Button type="button" variant="ghost" onClick={onClose}>{i18n.t("manager.common.close")}</Button>
        </div>
      </GlassPanel>
    </div>
  );
}

function SolutionInstanceCard({ instance }: { instance: SolutionInstance }): ReactNode {
  const i18n = useI18n();
  return (
    <GlassPanel data-testid="solution-instance-card" className="rounded-window p-md">
      <div className="flex flex-wrap items-center gap-md mb-sm">
        <span className="font-semibold text-text-primary">{instance.display_name}</span>
        <code className="text-xs text-gold-bright">{instance.solution_id}@{instance.solution_version}</code>
        <span className={`text-xs px-sm py-xs rounded-full ${instance.status === "active" ? "bg-success/20 text-success" : "bg-text-muted/20 text-text-muted"}`}>
          {instance.status}
        </span>
      </div>
      <div className="text-xs text-text-secondary space-y-xs">
        <div>{i18n.t("manager.experts.expert_count")}: {instance.expert_employee_ids.length}</div>
        {instance.expert_employee_ids.length > 0 && (
          <div className="flex flex-wrap gap-xs">
            {instance.expert_employee_ids.map((eid) => (
              <code key={eid} className="text-xs bg-surface px-sm py-0.5 rounded">{eid}</code>
            ))}
          </div>
        )}
        <div>{i18n.t("manager.experts.solution_knowledge_refs")}: {instance.knowledge_refs.join(", ") || "-"}</div>
        <div>{i18n.t("manager.experts.solution_skill_refs")}: {instance.skill_refs.join(", ") || "-"}</div>
        {(instance.planner_prompt || instance.subtask_prompt || instance.aggregate_prompt) && (
          <div>{i18n.t("manager.experts.planner_prompt")}: {instance.planner_prompt?.slice(0, 40) || "-"}…</div>
        )}
      </div>
    </GlassPanel>
  );
}
