/**
 * 方案目录页（AITEAM-290 / GH#404）。
 *
 * 独立的行业方案入口：方案目录浏览 + 应用 + 已应用方案实例查看/编辑配置。
 * 参照旧架构 admin-solutions 行业方案功能形态（仅功能参考）。
 *
 * 注意：本入口与旧 /experts 页的方案段平行；/solutions 专注方案目录 + 应用 + 实例配置，
 * 旧 /experts 仍保留专家招募与员工管理的超集（向后兼容）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Button, Field, GlassPanel, Input } from "@aiteam/shared/ui";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useExpertsApi } from "../experts/useExpertsApi";
import type { SolutionInstance, SolutionInstanceUpdateInput, SolutionPackage } from "../experts/types";

const textareaCls =
  "min-h-[80px] rounded-md border border-gold/20 bg-surface px-md py-sm text-sm text-text-primary " +
  "outline-none transition placeholder:text-text-muted focus:border-gold/50 focus:ring-2 focus:ring-gold";

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
      {notice && <p className="m-0 text-sm text-success" role="status">{notice}</p>}
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
                {canWrite && (
                  <Button type="button" variant="ghost" size="sm" className="ml-auto"
                    onClick={() => void runAction(() => api.applySolution({ solution_id: s.solution_id }), "manager.experts.apply_ok")}>
                    {i18n.t("manager.experts.apply")}
                  </Button>
                )}
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
            <SolutionInstanceCard key={si.id} instance={si} canWrite={canWrite}
              onSave={(update) => runAction(() => api.updateSolutionInstance(si.id, update), "manager.experts.solution_save_ok")} />
          ))
        )}
      </div>
    </section>
  );
}

function parseList(value: string): string[] {
  return value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

function SolutionInstanceCard({ instance, canWrite, onSave }: {
  instance: SolutionInstance; canWrite: boolean; onSave: (update: SolutionInstanceUpdateInput) => void;
}): ReactNode {
  const i18n = useI18n();
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(instance.display_name);
  const [expertIds, setExpertIds] = useState(instance.expert_employee_ids.join("\n"));
  const [knowledgeRefs, setKnowledgeRefs] = useState(instance.knowledge_refs.join("\n"));
  const [skillRefs, setSkillRefs] = useState(instance.skill_refs.join("\n"));
  const [plannerPrompt, setPlannerPrompt] = useState(instance.planner_prompt ?? "");
  const [subtaskPrompt, setSubtaskPrompt] = useState(instance.subtask_prompt ?? "");
  const [aggregatePrompt, setAggregatePrompt] = useState(instance.aggregate_prompt ?? "");

  const resetEditing = useCallback(() => {
    setDisplayName(instance.display_name);
    setExpertIds(instance.expert_employee_ids.join("\n"));
    setKnowledgeRefs(instance.knowledge_refs.join("\n"));
    setSkillRefs(instance.skill_refs.join("\n"));
    setPlannerPrompt(instance.planner_prompt ?? "");
    setSubtaskPrompt(instance.subtask_prompt ?? "");
    setAggregatePrompt(instance.aggregate_prompt ?? "");
    setEditing(false);
  }, [instance]);

  return (
    <GlassPanel data-testid="solution-instance-card" className="rounded-window p-md">
      <div className="flex flex-wrap items-center gap-md mb-sm">
        <span className="font-semibold text-text-primary">{instance.display_name}</span>
        <code className="text-xs text-gold-bright">{instance.solution_id}@{instance.solution_version}</code>
        <span className={`text-xs px-sm py-xs rounded-full ${instance.status === "active" ? "bg-success/20 text-success" : "bg-text-muted/20 text-text-muted"}`}>
          {instance.status}
        </span>
      </div>
      {!editing ? (
        <>
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
          {canWrite && (
            <Button type="button" variant="ghost" size="sm" className="mt-sm" onClick={() => setEditing(true)}>
              {i18n.t("manager.experts.edit_solution")}
            </Button>
          )}
        </>
      ) : (
        <form className="flex flex-col gap-md" onSubmit={(e) => {
          e.preventDefault();
          onSave({
            display_name: displayName.trim(),
            expert_employee_ids: parseList(expertIds),
            knowledge_refs: parseList(knowledgeRefs),
            skill_refs: parseList(skillRefs),
            planner_prompt: plannerPrompt,
            subtask_prompt: subtaskPrompt,
            aggregate_prompt: aggregatePrompt,
          });
          setEditing(false);
        }}>
          <fieldset className="flex flex-col gap-md">
            <legend className="mb-xs text-xs font-semibold text-text-secondary">{i18n.t("manager.experts.section_solution")}</legend>
            <Field label={i18n.t("manager.experts.display_name")}>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
            <Field label={i18n.t("manager.experts.solution_expert_ids")}>
              <textarea className={textareaCls} value={expertIds} onChange={(e) => setExpertIds(e.target.value)} rows={3} />
            </Field>
            <Field label={i18n.t("manager.experts.solution_knowledge_refs")}>
              <textarea className={textareaCls} value={knowledgeRefs} onChange={(e) => setKnowledgeRefs(e.target.value)} rows={3} />
            </Field>
            <Field label={i18n.t("manager.experts.solution_skill_refs")}>
              <textarea className={textareaCls} value={skillRefs} onChange={(e) => setSkillRefs(e.target.value)} rows={3} />
            </Field>
          </fieldset>
          <fieldset className="flex flex-col gap-md">
            <legend className="mb-xs text-xs font-semibold text-text-secondary">{i18n.t("manager.experts.planner_prompt")}</legend>
            <p className="m-0 text-xs text-text-muted">{i18n.t("manager.experts.solution_prompts_hint")}</p>
            <Field label={i18n.t("manager.experts.planner_prompt")}>
              <textarea className={textareaCls} value={plannerPrompt} onChange={(e) => setPlannerPrompt(e.target.value)} rows={3} />
            </Field>
            <Field label={i18n.t("manager.experts.subtask_prompt")}>
              <textarea className={textareaCls} value={subtaskPrompt} onChange={(e) => setSubtaskPrompt(e.target.value)} rows={3} />
            </Field>
            <Field label={i18n.t("manager.experts.aggregate_prompt")}>
              <textarea className={textareaCls} value={aggregatePrompt} onChange={(e) => setAggregatePrompt(e.target.value)} rows={3} />
            </Field>
          </fieldset>
          <div className="flex gap-sm">
            <Button type="submit" size="sm">{i18n.t("manager.experts.save")}</Button>
            <Button type="button" variant="ghost" size="sm" onClick={resetEditing}>{i18n.t("manager.experts.cancel")}</Button>
          </div>
        </form>
      )}
    </GlassPanel>
  );
}
