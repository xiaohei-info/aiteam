/**
 * 招募专家页（W-M.3，08 §12.1）。
 *
 * 三段：可招募专家模板（浏览 Operator 目录 → 招募为本 tenant 实例）、可应用行业方案（浏览 → 应用）、
 * 已招募专家实例（列出 + 查看/编辑配置：模型/运行时/能力/记忆策略，PUT 全量替换）。owner/enterprise_admin 可写，其余只读（后端鉴权兜底）。
 * 编辑：PUT 全量替换，可改 display_name/persona/模型配置/运行时/能力引用/记忆策略，未改字段保全原值。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Button, Field, GlassPanel, Input, Select } from "@aiteam/shared/ui";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useExpertsApi } from "./useExpertsApi";
import type { EmployeeConfig, ExpertTemplate, SolutionInstance, SolutionPackage } from "./types";

const textareaCls =
  "min-h-[80px] rounded-md border border-gold/20 bg-surface px-md py-sm text-sm text-text-primary " +
  "outline-none transition placeholder:text-text-muted focus:border-gold/50 focus:ring-2 focus:ring-gold";

export function ExpertsPage(): ReactNode {
  const { session, token } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useExpertsApi();

  const [templates, setTemplates] = useState<ExpertTemplate[]>([]);
  const [solutions, setSolutions] = useState<SolutionPackage[]>([]);
  const [employees, setEmployees] = useState<EmployeeConfig[]>([]);
  const [solutionInstances, setSolutionInstances] = useState<SolutionInstance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, s, e, si] = await Promise.all([
        api.listTemplates(),
        api.listSolutions(),
        api.listEmployees(),
        api.listSolutionInstances(),
      ]);
      setTemplates(t);
      setSolutions(s);
      setEmployees(e);
      setSolutionInstances(si);
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

  const handleExport = useCallback(async () => {
    try {
      // token is captured from useSession() above
      const resp = await fetch("/api/manager/employees/export/all", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) throw new Error("Export failed");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "employees.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // silently ignore export errors
    }
  }, [token]);

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
        <div className="flex items-center gap-md">
          <h2 className="m-0 text-base font-semibold text-text-primary">
            {i18n.t("manager.experts.instances_title")}
          </h2>
          {canWrite && employees.length > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={handleExport}>
              {i18n.t("manager.experts.export_csv")}
            </Button>
          )}
        </div>
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

      {/* 已应用方案实例 */}
      <div className="flex flex-col gap-md">
        <h2 className="m-0 text-base font-semibold text-text-primary">
          {i18n.t("manager.experts.solution_instances_title")}
        </h2>
        {solutionInstances.length === 0 ? (
          <GlassPanel className="rounded-window p-lg text-sm text-text-muted">
            {i18n.t("manager.experts.solution_instances_empty")}
          </GlassPanel>
        ) : (
          solutionInstances.map((si) => (
            <GlassPanel key={si.id} className="rounded-window p-md">
              <div className="flex items-center gap-md mb-sm">
                <span className="font-semibold text-text-primary">{si.display_name}</span>
                <code className="text-xs text-gold-bright">{si.solution_id}@{si.solution_version}</code>
                <span className={`text-xs px-sm py-xs rounded-full ${si.status === "active" ? "bg-success/20 text-success" : "bg-text-muted/20 text-text-muted"}`}>
                  {si.status}
                </span>
              </div>
              <div className="text-xs text-text-secondary space-y-xs">
                <div>{i18n.t("manager.experts.expert_count")}: {si.expert_employee_ids.length}</div>
                {si.expert_employee_ids.length > 0 && (
                  <div className="flex flex-wrap gap-xs">
                    {si.expert_employee_ids.map((eid) => (
                      <code key={eid} className="text-xs bg-surface px-sm py-0.5 rounded">{eid}</code>
                    ))}
                  </div>
                )}
              </div>
            </GlassPanel>
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

/** 列表/JSON 字段编辑：逗号或换行分隔输入 → 字符串数组。 */
function parseList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function EmployeeInstance({ employee, canWrite, onSave }: InstanceProps): ReactNode {
  const i18n = useI18n();
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(employee.display_name);
  const [persona, setPersona] = useState(employee.persona ?? "");
  const [model, setModel] = useState(employee.model_policy.model ?? "");
  const [providerRef, setProviderRef] = useState(employee.model_policy.provider_ref ?? "");
  const [thinkingLevel, setThinkingLevel] = useState(employee.model_policy.thinking_level ?? "");
  const [runtimeBinding, setRuntimeBinding] = useState(employee.runtime_policy.runtime_binding ?? "");
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    employee.runtime_policy.timeout_seconds != null ? String(employee.runtime_policy.timeout_seconds) : "",
  );
  const [tools, setTools] = useState(employee.tools.join("\n"));
  const [skills, setSkills] = useState(employee.skills.join("\n"));
  const [knowledgeRefs, setKnowledgeRefs] = useState(employee.knowledge_refs.join("\n"));
  const [connectorRefs, setConnectorRefs] = useState(employee.connector_refs.join("\n"));
  const [memoryPolicy, setMemoryPolicy] = useState(
    employee.memory_policy != null ? JSON.stringify(employee.memory_policy, null, 2) : "",
  );

  const resetEditing = useCallback(() => {
    setDisplayName(employee.display_name);
    setPersona(employee.persona ?? "");
    setModel(employee.model_policy.model ?? "");
    setProviderRef(employee.model_policy.provider_ref ?? "");
    setThinkingLevel(employee.model_policy.thinking_level ?? "");
    setRuntimeBinding(employee.runtime_policy.runtime_binding ?? "");
    setTimeoutSeconds(
      employee.runtime_policy.timeout_seconds != null ? String(employee.runtime_policy.timeout_seconds) : "",
    );
    setTools(employee.tools.join("\n"));
    setSkills(employee.skills.join("\n"));
    setKnowledgeRefs(employee.knowledge_refs.join("\n"));
    setConnectorRefs(employee.connector_refs.join("\n"));
    setMemoryPolicy(employee.memory_policy != null ? JSON.stringify(employee.memory_policy, null, 2) : "");
    setEditing(false);
  }, [employee]);

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
            <dd className="m-0 text-text-primary">{employee.model_policy.model || "-"}</dd>
            <dt className="text-text-muted">{i18n.t("manager.experts.provider_ref")}</dt>
            <dd className="m-0 text-text-primary">{employee.model_policy.provider_ref ?? "-"}</dd>
            <dt className="text-text-muted">{i18n.t("manager.experts.thinking_level")}</dt>
            <dd className="m-0 text-text-primary">{employee.model_policy.thinking_level ?? "-"}</dd>
            <dt className="text-text-muted">{i18n.t("manager.experts.runtime_binding")}</dt>
            <dd className="m-0 text-text-primary">{employee.runtime_policy.runtime_binding ?? "-"}</dd>
            <dt className="text-text-muted">{i18n.t("manager.experts.timeout_seconds")}</dt>
            <dd className="m-0 text-text-primary">
              {employee.runtime_policy.timeout_seconds != null ? String(employee.runtime_policy.timeout_seconds) : "-"}
            </dd>
            <dt className="text-text-muted">{i18n.t("manager.experts.tools")}</dt>
            <dd className="m-0 text-text-primary">{employee.tools.join(", ") || "-"}</dd>
            <dt className="text-text-muted">{i18n.t("manager.experts.skills")}</dt>
            <dd className="m-0 text-text-primary">{employee.skills.join(", ") || "-"}</dd>
            <dt className="text-text-muted">{i18n.t("manager.experts.knowledge_refs")}</dt>
            <dd className="m-0 text-text-primary">{employee.knowledge_refs.join(", ") || "-"}</dd>
            <dt className="text-text-muted">{i18n.t("manager.experts.connector_refs")}</dt>
            <dd className="m-0 text-text-primary">{employee.connector_refs.join(", ") || "-"}</dd>
            <dt className="text-text-muted">{i18n.t("manager.experts.memory_policy")}</dt>
            <dd className="m-0 text-text-primary">
              {employee.memory_policy != null ? JSON.stringify(employee.memory_policy) : "-"}
            </dd>
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
            const memoryParsed = memoryPolicy.trim() ? JSON.parse(memoryPolicy) : null;
            onSave({
              ...employee,
              display_name: displayName.trim(),
              persona,
              model_policy: {
                model: model.trim(),
                provider_ref: providerRef.trim() || null,
                thinking_level: thinkingLevel.trim() || null,
              },
              runtime_policy: {
                runtime_binding: runtimeBinding.trim() || null,
                timeout_seconds: timeoutSeconds.trim() ? Number(timeoutSeconds) : null,
              },
              tools: parseList(tools),
              skills: parseList(skills),
              knowledge_refs: parseList(knowledgeRefs),
              connector_refs: parseList(connectorRefs),
              memory_policy: memoryParsed,
            });
            setEditing(false);
          }}
        >
          <fieldset className="flex flex-col gap-md">
            <legend className="mb-xs text-xs font-semibold text-text-secondary">
              {i18n.t("manager.experts.section_prompt")}
            </legend>
            <Field label={i18n.t("manager.experts.display_name")}>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
            <Field label={i18n.t("manager.experts.persona")}>
              <textarea
                className={textareaCls}
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                rows={4}
              />
            </Field>
          </fieldset>

          <fieldset className="flex flex-col gap-md">
            <legend className="mb-xs text-xs font-semibold text-text-secondary">
              {i18n.t("manager.experts.section_model")}
            </legend>
            <Field label={i18n.t("manager.experts.model")}>
              <Input value={model} onChange={(e) => setModel(e.target.value)} />
            </Field>
            <Field label={i18n.t("manager.experts.provider_ref")}>
              <Input value={providerRef} onChange={(e) => setProviderRef(e.target.value)} />
            </Field>
            <Field label={i18n.t("manager.experts.thinking_level")}>
              <Select
                value={thinkingLevel}
                onChange={(e) => setThinkingLevel(e.target.value)}
              >
                <option value="">{i18n.t("manager.experts.thinking_none")}</option>
                <option value="basic">{i18n.t("manager.experts.thinking_basic")}</option>
                <option value="deep">{i18n.t("manager.experts.thinking_deep")}</option>
              </Select>
            </Field>
            <Field label={i18n.t("manager.experts.runtime_binding")}>
              <Input value={runtimeBinding} onChange={(e) => setRuntimeBinding(e.target.value)} />
            </Field>
            <Field label={i18n.t("manager.experts.timeout_seconds")}>
              <Input
                type="number"
                value={timeoutSeconds}
                onChange={(e) => setTimeoutSeconds(e.target.value)}
              />
            </Field>
          </fieldset>

          <fieldset className="flex flex-col gap-md">
            <legend className="mb-xs text-xs font-semibold text-text-secondary">
              {i18n.t("manager.experts.section_capabilities")}
            </legend>
            <Field label={i18n.t("manager.experts.tools")}>
              <textarea
                className={textareaCls}
                value={tools}
                onChange={(e) => setTools(e.target.value)}
                rows={3}
              />
            </Field>
            <Field label={i18n.t("manager.experts.skills")}>
              <textarea
                className={textareaCls}
                value={skills}
                onChange={(e) => setSkills(e.target.value)}
                rows={3}
              />
            </Field>
            <Field label={i18n.t("manager.experts.knowledge_refs")}>
              <textarea
                className={textareaCls}
                value={knowledgeRefs}
                onChange={(e) => setKnowledgeRefs(e.target.value)}
                rows={3}
              />
            </Field>
            <Field label={i18n.t("manager.experts.connector_refs")}>
              <textarea
                className={textareaCls}
                value={connectorRefs}
                onChange={(e) => setConnectorRefs(e.target.value)}
                rows={3}
              />
            </Field>
          </fieldset>

          <fieldset className="flex flex-col gap-md">
            <legend className="mb-xs text-xs font-semibold text-text-secondary">
              {i18n.t("manager.experts.section_memory")}
            </legend>
            <Field label={i18n.t("manager.experts.memory_policy")}>
              <textarea
                className={textareaCls}
                value={memoryPolicy}
                onChange={(e) => setMemoryPolicy(e.target.value)}
                rows={4}
              />
            </Field>
          </fieldset>

          <div className="flex gap-sm">
            <Button type="submit" size="sm">
              {i18n.t("manager.experts.save")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => resetEditing()}
            >
              {i18n.t("manager.experts.cancel")}
            </Button>
          </div>
        </form>
      )}
    </GlassPanel>
  );
}
