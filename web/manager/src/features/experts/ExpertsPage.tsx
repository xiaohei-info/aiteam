/**
 * 招募专家页（W-M.3，08 §12.1）。
 *
 * 三段：可招募专家模板（浏览 Operator 目录 → 招募为本 tenant 实例）、可应用行业方案（浏览 → 应用）、
 * 已招募专家实例（列出 + 查看/编辑配置）。owner/enterprise_admin 可写，其余只读（后端鉴权兜底）。
 * 编辑：PUT 全量替换，仅改 display_name/persona，保全其余配置字段（其余只读展示）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Button, Field, GlassPanel, Input } from "@aiteam/shared/ui";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useExpertsApi } from "./useExpertsApi";
import type { EmployeeConfig, ExpertTemplate, SolutionPackage } from "./types";

const textareaCls =
  "min-h-[80px] rounded-md border border-gold/20 bg-surface px-md py-sm text-sm text-text-primary " +
  "outline-none transition placeholder:text-text-muted focus:border-gold/50 focus:ring-2 focus:ring-gold";

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
    <section className="flex flex-col gap-lg">
      <h1 className="m-0 text-xl font-bold text-text-primary">{i18n.t("manager.nav.experts")}</h1>
      {notice && (
        <p className="m-0 text-sm text-success" role="status">
          {notice}
        </p>
      )}
      {actionError && <p className="m-0 text-sm text-danger">{actionError}</p>}
      {error && <p className="m-0 text-sm text-danger">{error}</p>}
      {loading && <p className="m-0 text-sm text-text-secondary">{i18n.t("manager.experts.loading")}</p>}

      <Catalog title={i18n.t("manager.experts.templates_title")}>
        {templates.length === 0 ? (
          <EmptyRow>{i18n.t("manager.experts.templates_empty")}</EmptyRow>
        ) : (
          templates.map((t) => (
            <CatalogRow key={`${t.template_id}@${t.version}`} testId="template-row">
              <span className="font-medium text-text-primary">{t.display_name}</span>
              <code className="text-xs text-gold-bright">{t.template_id}</code>
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
            </CatalogRow>
          ))
        )}
      </Catalog>

      <Catalog title={i18n.t("manager.experts.solutions_title")}>
        {solutions.length === 0 ? (
          <EmptyRow>{i18n.t("manager.experts.solutions_empty")}</EmptyRow>
        ) : (
          solutions.map((s) => (
            <CatalogRow key={`${s.solution_id}@${s.version}`} testId="solution-row">
              <span className="font-medium text-text-primary">{s.display_name}</span>
              <code className="text-xs text-gold-bright">{s.solution_id}</code>
              {canWrite && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() =>
                    void runAction(
                      () => api.applySolution({ solution_id: s.solution_id }),
                      "manager.experts.apply_ok",
                    )
                  }
                >
                  {i18n.t("manager.experts.apply")}
                </Button>
              )}
            </CatalogRow>
          ))
        )}
      </Catalog>

      <div className="flex flex-col gap-md">
        <h2 className="m-0 text-base font-semibold text-text-primary">
          {i18n.t("manager.experts.instances_title")}
        </h2>
        {employees.length === 0 ? (
          <GlassPanel className="rounded-window p-lg text-sm text-text-muted">
            {i18n.t("manager.experts.instances_empty")}
          </GlassPanel>
        ) : (
          employees.map((emp) => (
            <EmployeeInstance
              key={emp.employee_id}
              employee={emp}
              canWrite={canWrite}
              onSave={(updated) =>
                runAction(() => api.updateEmployee(emp.employee_id, updated), "manager.experts.save_ok")
              }
            />
          ))
        )}
      </div>
    </section>
  );
}

/** 目录卡片：标题 + 行容器（模板/方案共用）。 */
function Catalog({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-md">
      <h2 className="m-0 text-base font-semibold text-text-primary">{title}</h2>
      <GlassPanel className="flex flex-col divide-y divide-gold/10 overflow-hidden rounded-window">
        {children}
      </GlassPanel>
    </div>
  );
}

function CatalogRow({ testId, children }: { testId: string; children: ReactNode }): ReactNode {
  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-sm px-lg py-md">
      {children}
    </div>
  );
}

function EmptyRow({ children }: { children: ReactNode }): ReactNode {
  return <div className="px-lg py-md text-sm text-text-muted">{children}</div>;
}

function RecruitInline({ onRecruit }: { onRecruit: (slug: string) => void }): ReactNode {
  const i18n = useI18n();
  const [slug, setSlug] = useState("");
  return (
    <span className="ml-auto flex items-center gap-sm">
      <Input
        className="h-8 py-1"
        aria-label={i18n.t("manager.experts.slug")}
        placeholder={i18n.t("manager.experts.slug")}
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
      />
      <Button
        type="button"
        size="sm"
        disabled={!slug.trim()}
        onClick={() => {
          onRecruit(slug.trim());
          setSlug("");
        }}
      >
        {i18n.t("manager.experts.recruit")}
      </Button>
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
    <GlassPanel data-testid="instance-row" className="flex flex-col gap-sm rounded-window p-lg">
      <div className="flex flex-wrap items-baseline gap-sm">
        <strong className="text-text-primary">{employee.display_name || employee.employee_slug}</strong>
        <code className="text-xs text-gold-bright">{employee.employee_slug}</code>
        <span className="text-xs text-text-muted">· v{employee.version}</span>
      </div>
      {!editing ? (
        <>
          <p className="m-0 text-sm text-text-secondary">
            {employee.persona || i18n.t("manager.experts.no_persona")}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-md gap-y-xs text-sm">
            <dt className="text-text-muted">{i18n.t("manager.experts.model")}</dt>
            <dd className="m-0 text-text-primary">{employee.model_policy.model}</dd>
            <dt className="text-text-muted">{i18n.t("manager.experts.runtime")}</dt>
            <dd className="m-0 text-text-primary">{employee.runtime_policy.runtime_binding ?? "-"}</dd>
            <dt className="text-text-muted">{i18n.t("manager.experts.skills")}</dt>
            <dd className="m-0 text-text-primary">{employee.skills.join(", ") || "-"}</dd>
          </dl>
          {canWrite && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setEditing(true)}
            >
              {i18n.t("manager.experts.edit")}
            </Button>
          )}
        </>
      ) : (
        <form
          className="flex flex-col gap-md"
          onSubmit={(e) => {
            e.preventDefault();
            onSave({ ...employee, display_name: displayName.trim(), persona });
            setEditing(false);
          }}
        >
          <Field label={i18n.t("manager.experts.display_name")}>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label={i18n.t("manager.experts.persona")}>
            <textarea
              className={textareaCls}
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
            />
          </Field>
          <div className="flex gap-sm">
            <Button type="submit" size="sm">
              {i18n.t("manager.experts.save")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDisplayName(employee.display_name);
                setPersona(employee.persona ?? "");
                setEditing(false);
              }}
            >
              {i18n.t("manager.experts.cancel")}
            </Button>
          </div>
        </form>
      )}
    </GlassPanel>
  );
}
