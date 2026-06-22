/**
 * 成员级授权页（W-M.4，08 §12.1，D12）。
 *
 * 配置 member_grant：把 专家(employee 实例)/方案(实例) 授权给 部门/成员；增删查。
 * owner/enterprise_admin 可写，其余只读（后端鉴权兜底，见 #117）。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Button, Field, GlassPanel, Select, Table } from "@aiteam/shared/ui";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useGrantsApi } from "./useGrantsApi";
import type {
  Department,
  ExpertOption,
  Grant,
  GrantResourceType,
  Member,
  SolutionOption,
} from "./types";

export function GrantsPage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useGrantsApi();

  const [grants, setGrants] = useState<Grant[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [experts, setExperts] = useState<ExpertOption[]>([]);
  const [solutions, setSolutions] = useState<SolutionOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const nameOf = useMemo(() => {
    const mem = new Map(members.map((m) => [m.id, m.display_name]));
    const dep = new Map(departments.map((d) => [d.id, d.display_name]));
    return {
      member: (id: string) => mem.get(id) ?? id,
      dept: (id: string) => dep.get(id) ?? id,
    };
  }, [members, departments]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [g, m, d, e, s] = await Promise.all([
        api.listGrants(),
        api.listMembers(),
        api.listDepartments(),
        api.listExperts(),
        api.listSolutions(),
      ]);
      setGrants(g);
      setMembers(m);
      setDepartments(d);
      setExperts(e);
      setSolutions(s);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.grants.load_error"));
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
        setActionError(err instanceof ApiError ? err.message : i18n.t("manager.grants.action_error"));
      }
    },
    [i18n, load],
  );

  return (
    <section className="flex flex-col gap-lg">
      <h1 className="m-0 text-xl font-bold text-text-primary">{i18n.t("manager.nav.grants")}</h1>
      {actionError && <p className="m-0 text-sm text-danger">{actionError}</p>}
      {error && <p className="m-0 text-sm text-danger">{error}</p>}
      {loading && <p className="m-0 text-sm text-text-secondary">{i18n.t("manager.grants.loading")}</p>}

      {canWrite && (
        <GrantForm
          experts={experts}
          solutions={solutions}
          members={members}
          departments={departments}
          onCreate={(input) => runAction(() => api.createGrant(input))}
        />
      )}

      <GlassPanel className="overflow-hidden rounded-window">
        <Table>
          <thead>
            <tr>
              <th>{i18n.t("manager.grants.col_resource")}</th>
              <th>{i18n.t("manager.grants.col_members")}</th>
              <th>{i18n.t("manager.grants.col_departments")}</th>
              {canWrite && <th>{i18n.t("manager.grants.col_actions")}</th>}
            </tr>
          </thead>
          <tbody>
            {grants.length === 0 ? (
              <tr>
                <td colSpan={canWrite ? 4 : 3} className="text-text-muted">
                  {i18n.t("manager.grants.empty")}
                </td>
              </tr>
            ) : (
              grants.map((g) => (
                <tr key={g.id} data-testid="grant-row">
                  <td>
                    {g.resource_type} · <code className="text-gold-bright">{g.resource_id}</code>
                  </td>
                  <td>{g.member_ids.map(nameOf.member).join(", ") || "-"}</td>
                  <td>{g.department_ids.map(nameOf.dept).join(", ") || "-"}</td>
                  {canWrite && (
                    <td>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void runAction(() => api.deleteGrant(g.id))}
                      >
                        {i18n.t("manager.grants.revoke")}
                      </Button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </GlassPanel>
    </section>
  );
}

interface FormProps {
  experts: ExpertOption[];
  solutions: SolutionOption[];
  members: Member[];
  departments: Department[];
  onCreate: (input: {
    resource_type: GrantResourceType;
    resource_id: string;
    member_ids: string[];
    department_ids: string[];
  }) => void | Promise<void>;
}

function GrantForm({ experts, solutions, members, departments, onCreate }: FormProps): ReactNode {
  const i18n = useI18n();
  const [resourceType, setResourceType] = useState<GrantResourceType>("expert");
  const [resourceId, setResourceId] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [deptIds, setDeptIds] = useState<string[]>([]);

  const resourceOptions =
    resourceType === "expert"
      ? experts.map((e) => ({ value: e.employee_id, label: e.display_name }))
      : solutions.map((s) => ({ value: s.id, label: s.display_name }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!resourceId || (memberIds.length === 0 && deptIds.length === 0)) return;
    void onCreate({
      resource_type: resourceType,
      resource_id: resourceId,
      member_ids: memberIds,
      department_ids: deptIds,
    });
    setResourceId("");
    setMemberIds([]);
    setDeptIds([]);
  }

  function selected(e: React.ChangeEvent<HTMLSelectElement>): string[] {
    return Array.from(e.target.selectedOptions, (o) => o.value);
  }

  return (
    <GlassPanel className="rounded-window p-lg">
      <form className="flex flex-col gap-md" onSubmit={submit}>
        <h2 className="m-0 text-base font-semibold text-text-primary">
          {i18n.t("manager.grants.create_title")}
        </h2>
        <div className="grid grid-cols-1 gap-md md:grid-cols-2">
          <Field label={i18n.t("manager.grants.resource_type")}>
            <Select
              value={resourceType}
              onChange={(e) => {
                setResourceType(e.target.value as GrantResourceType);
                setResourceId("");
              }}
            >
              <option value="expert">{i18n.t("manager.grants.type_expert")}</option>
              <option value="solution">{i18n.t("manager.grants.type_solution")}</option>
            </Select>
          </Field>
          <Field label={i18n.t("manager.grants.resource")}>
            <Select value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
              <option value="">{i18n.t("manager.grants.resource_pick")}</option>
              {resourceOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={i18n.t("manager.grants.col_members")}>
            <Select multiple value={memberIds} onChange={(e) => setMemberIds(selected(e))}>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={i18n.t("manager.grants.col_departments")}>
            <Select multiple value={deptIds} onChange={(e) => setDeptIds(selected(e))}>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.display_name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button type="submit" size="sm" className="self-start">
          {i18n.t("manager.grants.create_submit")}
        </Button>
      </form>
    </GlassPanel>
  );
}
