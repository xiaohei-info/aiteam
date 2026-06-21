/**
 * 招募专家页（W-M.3，08 §12.1）。
 *
 * 三段：可招募专家模板（浏览 Operator 目录 → 招募为本 tenant 实例）、可应用行业方案（浏览 → 应用）、
 * 已招募专家实例（列出 + 查看/编辑配置）。owner/enterprise_admin 可写，其余只读（后端鉴权兜底）。
 * 编辑：PUT 全量替换，仅改 display_name/persona，保全其余配置字段（其余只读展示）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useExpertsApi } from "./useExpertsApi";
import type { EmployeeConfig, ExpertTemplate, SolutionPackage } from "./types";

export function ExpertsPage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useExpertsApi();

  const [templates, setTemplates] = useState<ExpertTemplate[]>([]);
  const [solutions, setSolutions] = useState<SolutionPackage[]>([]);
  const [employees, setEmployees] = useState<EmployeeConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, s, e] = await Promise.all([
        api.listTemplates(),
        api.listSolutions(),
        api.listEmployees(),
      ]);
      setTemplates(t);
      setSolutions(s);
      setEmployees(e);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.experts.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => {
    void load();
  }, [load]);

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
    <section className="experts-page">
      <h1>{i18n.t("manager.nav.experts")}</h1>
      {notice && <p className="experts-notice" role="status">{notice}</p>}
      {actionError && <p className="experts-error">{actionError}</p>}
      {error && <p className="experts-error">{error}</p>}
      {loading && <p>{i18n.t("manager.experts.loading")}</p>}

      <h2>{i18n.t("manager.experts.templates_title")}</h2>
      <ul className="experts-templates">
        {templates.length === 0 ? (
          <li>{i18n.t("manager.experts.templates_empty")}</li>
        ) : (
          templates.map((t) => (
            <li key={`${t.template_id}@${t.version}`} data-testid="template-row">
              <span>{t.display_name}</span>{" "}
              <code>{t.template_id}</code>
              {canWrite && (
                <RecruitInline
                  onRecruit={(slug) =>
                    runAction(
                      () => api.recruitExpert({ template_id: t.template_id, employee_slug: slug }),
                      "manager.experts.recruit_ok",
                    )
                  }
                />
              )}
            </li>
          ))
        )}
      </ul>

      <h2>{i18n.t("manager.experts.solutions_title")}</h2>
      <ul className="experts-solutions">
        {solutions.length === 0 ? (
          <li>{i18n.t("manager.experts.solutions_empty")}</li>
        ) : (
          solutions.map((s) => (
            <li key={`${s.solution_id}@${s.version}`} data-testid="solution-row">
              <span>{s.display_name}</span>{" "}
              <code>{s.solution_id}</code>
              {canWrite && (
                <button
                  type="button"
                  onClick={() =>
                    void runAction(
                      () => api.applySolution({ solution_id: s.solution_id }),
                      "manager.experts.apply_ok",
                    )
                  }
                >
                  {i18n.t("manager.experts.apply")}
                </button>
              )}
            </li>
          ))
        )}
      </ul>

      <h2>{i18n.t("manager.experts.instances_title")}</h2>
      <ul className="experts-instances">
        {employees.length === 0 ? (
          <li>{i18n.t("manager.experts.instances_empty")}</li>
        ) : (
          employees.map((emp) => (
            <EmployeeInstance
              key={emp.employee_id}
              employee={emp}
              canWrite={canWrite}
              onSave={(updated) =>
                runAction(
                  () => api.updateEmployee(emp.employee_id, updated),
                  "manager.experts.save_ok",
                )
              }
            />
          ))
        )}
      </ul>
    </section>
  );
}

function RecruitInline({ onRecruit }: { onRecruit: (slug: string) => void }): ReactNode {
  const i18n = useI18n();
  const [slug, setSlug] = useState("");
  return (
    <span className="recruit-inline">
      <input
        aria-label={i18n.t("manager.experts.slug")}
        placeholder={i18n.t("manager.experts.slug")}
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
      />
      <button
        type="button"
        disabled={!slug.trim()}
        onClick={() => {
          onRecruit(slug.trim());
          setSlug("");
        }}
      >
        {i18n.t("manager.experts.recruit")}
      </button>
    </span>
  );
}

interface InstanceProps {
  employee: EmployeeConfig;
  canWrite: boolean;
  onSave: (updated: EmployeeConfig) => void;
}

function EmployeeInstance({ employee, canWrite, onSave }: InstanceProps): ReactNode {
  const i18n = useI18n();
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(employee.display_name);
  const [persona, setPersona] = useState(employee.persona ?? "");

  return (
    <li className="experts-instance" data-testid="instance-row">
      <div>
        <strong>{employee.display_name || employee.employee_slug}</strong>{" "}
        <code>{employee.employee_slug}</code> · v{employee.version}
      </div>
      {!editing ? (
        <>
          <p>{employee.persona || i18n.t("manager.experts.no_persona")}</p>
          <dl className="experts-config-readonly">
            <dt>{i18n.t("manager.experts.model")}</dt>
            <dd>{employee.model_policy.model}</dd>
            <dt>{i18n.t("manager.experts.runtime")}</dt>
            <dd>{employee.runtime_policy.runtime_binding ?? "-"}</dd>
            <dt>{i18n.t("manager.experts.skills")}</dt>
            <dd>{employee.skills.join(", ") || "-"}</dd>
          </dl>
          {canWrite && (
            <button type="button" onClick={() => setEditing(true)}>
              {i18n.t("manager.experts.edit")}
            </button>
          )}
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave({ ...employee, display_name: displayName.trim(), persona });
            setEditing(false);
          }}
        >
          <label>
            {i18n.t("manager.experts.display_name")}
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
          <label>
            {i18n.t("manager.experts.persona")}
            <textarea value={persona} onChange={(e) => setPersona(e.target.value)} />
          </label>
          <button type="submit">{i18n.t("manager.experts.save")}</button>
          <button
            type="button"
            onClick={() => {
              setDisplayName(employee.display_name);
              setPersona(employee.persona ?? "");
              setEditing(false);
            }}
          >
            {i18n.t("manager.experts.cancel")}
          </button>
        </form>
      )}
    </li>
  );
}
