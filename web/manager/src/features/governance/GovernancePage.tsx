/**
 * 企业治理页（W-M.5，08 §12.1，D13/D24）。
 *
 * 三段：计量汇总（脱敏聚合，只读）、审计事件摘要（只读）、软配额策略（CRUD + 评估治理动作）。
 * 配额写限 owner/enterprise_admin/finance_admin（对齐后端 _QUOTA_WRITE_ROLES）；其余只读。
 * 红线：只展示脱敏聚合摘要，绝不含会话内容（D13）；评估只产建议/告警，不阻断 run（D24）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useGovernanceApi } from "./useGovernanceApi";
import type {
  AuditSummary,
  CreateQuotaInput,
  EnforcementAction,
  QuotaPolicy,
  UsageRollup,
} from "./types";

export function GovernancePage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(
    session,
    EnterpriseRole.OWNER,
    EnterpriseRole.ENTERPRISE_ADMIN,
    EnterpriseRole.FINANCE_ADMIN,
  );
  const api = useGovernanceApi();

  const [rollups, setRollups] = useState<UsageRollup[]>([]);
  const [audits, setAudits] = useState<AuditSummary[]>([]);
  const [quotas, setQuotas] = useState<QuotaPolicy[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<EnforcementAction | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setEvaluation(null); // reload 时清旧评估结果，避免删除/变更后悬挂陈旧动作
    try {
      const [r, a, q] = await Promise.all([
        api.listUsageRollups(),
        api.listAudits(),
        api.listQuotas(),
      ]);
      setRollups(r);
      setAudits(a);
      setQuotas(q);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.gov.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await fn();
        await load();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : i18n.t("manager.gov.action_error"));
      }
    },
    [i18n, load],
  );

  const handleEvaluate = useCallback(
    async (q: QuotaPolicy) => {
      setActionError(null);
      setEvaluation(null);
      try {
        const result = await api.evaluateQuota(q.policy_id, q.window_start, q.window_end);
        setEvaluation(result);
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : i18n.t("manager.gov.action_error"));
      }
    },
    [api, i18n],
  );

  return (
    <section className="governance-page">
      <h1>{i18n.t("manager.nav.governance")}</h1>
      {actionError && <p className="gov-error">{actionError}</p>}
      {error && <p className="gov-error">{error}</p>}
      {loading && <p>{i18n.t("manager.gov.loading")}</p>}

      <h2>{i18n.t("manager.gov.usage_title")}</h2>
      <table className="gov-usage">
        <thead>
          <tr>
            <th>{i18n.t("manager.gov.window")}</th>
            <th>{i18n.t("manager.gov.runs")}</th>
            <th>{i18n.t("manager.gov.tokens")}</th>
            <th>{i18n.t("manager.gov.cost")}</th>
            <th>{i18n.t("manager.gov.errors")}</th>
          </tr>
        </thead>
        <tbody>
          {rollups.length === 0 ? (
            <tr>
              <td colSpan={5}>{i18n.t("manager.gov.usage_empty")}</td>
            </tr>
          ) : (
            rollups.map((r) => (
              <tr key={r.rollup_id} data-testid="rollup-row">
                <td>
                  {r.window_start} ~ {r.window_end}
                </td>
                <td>{r.run_count}</td>
                <td>{r.token_total}</td>
                <td>{String(r.cost_total)}</td>
                <td>{r.error_count}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <h2>{i18n.t("manager.gov.audit_title")}</h2>
      <table className="gov-audit">
        <thead>
          <tr>
            <th>{i18n.t("manager.gov.actor")}</th>
            <th>{i18n.t("manager.gov.action")}</th>
            <th>{i18n.t("manager.gov.resource")}</th>
            <th>{i18n.t("manager.gov.time")}</th>
          </tr>
        </thead>
        <tbody>
          {audits.length === 0 ? (
            <tr>
              <td colSpan={4}>{i18n.t("manager.gov.audit_empty")}</td>
            </tr>
          ) : (
            audits.map((a) => (
              <tr key={a.event_id} data-testid="audit-row">
                <td>{a.actor}</td>
                <td>{a.action}</td>
                <td>{a.resource_type ? `${a.resource_type}:${a.resource_id ?? ""}` : "-"}</td>
                <td>{a.occurred_at}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <h2>{i18n.t("manager.gov.quota_title")}</h2>
      {canWrite && <QuotaForm onCreate={(input) => runAction(() => api.createQuota(input))} />}
      {evaluation && (
        <div className="gov-evaluation" role="status">
          <strong>{evaluation.policy_slug}</strong> · {evaluation.severity} ·{" "}
          {evaluation.actions.join(", ")}
          {evaluation.detail ? ` · ${evaluation.detail}` : ""}
        </div>
      )}
      <ul className="gov-quotas">
        {quotas.length === 0 ? (
          <li>{i18n.t("manager.gov.quota_empty")}</li>
        ) : (
          quotas.map((q) => (
            <li key={q.policy_id} data-testid="quota-row">
              <span>
                <strong>{q.display_name || q.policy_slug}</strong> · {q.enforcement} · {q.status}
              </span>
              <button type="button" onClick={() => void handleEvaluate(q)}>
                {i18n.t("manager.gov.evaluate")}
              </button>
              {canWrite && (
                <button type="button" onClick={() => void runAction(() => api.deleteQuota(q.policy_id))}>
                  {i18n.t("manager.gov.delete")}
                </button>
              )}
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

function QuotaForm({ onCreate }: { onCreate: (input: CreateQuotaInput) => void | Promise<void> }): ReactNode {
  const i18n = useI18n();
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [enforcement, setEnforcement] = useState<"soft" | "hard">("soft");
  const [costCap, setCostCap] = useState("");
  const [runCap, setRunCap] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!slug.trim()) return;
    const dimensions: Record<string, number> = {};
    if (costCap.trim()) dimensions.cost_cap_usd = Number(costCap);
    if (runCap.trim()) dimensions.run_cap = Number(runCap);
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
    void onCreate({
      policy_slug: slug.trim(),
      display_name: displayName.trim(),
      scope: "tenant",
      window_start: now.toISOString(),
      window_end: end.toISOString(),
      dimensions,
      enforcement,
      status: "active",
    });
    setSlug("");
    setDisplayName("");
    setEnforcement("soft");
    setCostCap("");
    setRunCap("");
  }

  return (
    <form className="gov-quota-create" onSubmit={submit}>
      <h3>{i18n.t("manager.gov.quota_create")}</h3>
      <label>
        {i18n.t("manager.gov.slug")}
        <input value={slug} onChange={(e) => setSlug(e.target.value)} required />
      </label>
      <label>
        {i18n.t("manager.gov.display_name")}
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label>
        {i18n.t("manager.gov.enforcement")}
        <select value={enforcement} onChange={(e) => setEnforcement(e.target.value as "soft" | "hard")}>
          <option value="soft">soft</option>
          <option value="hard">hard</option>
        </select>
      </label>
      <label>
        {i18n.t("manager.gov.cost_cap")}
        <input type="number" value={costCap} onChange={(e) => setCostCap(e.target.value)} />
      </label>
      <label>
        {i18n.t("manager.gov.run_cap")}
        <input type="number" value={runCap} onChange={(e) => setRunCap(e.target.value)} />
      </label>
      <button type="submit">{i18n.t("manager.gov.quota_submit")}</button>
    </form>
  );
}
