/**
 * 成员账号页（W-M.2，08 §12.1）。
 *
 * owner/enterprise_admin 可写（建/改/停启用/删）；其余角色只读列表（03 §9.4B 鉴权在后端兜底）。
 * 红线：初始凭据仅在创建成功后**一次性**展示（管理员当场录入的明文），不回显、不缓存、
 * 不写 localStorage——后端 MemberOut 本就不含凭据，刷新即不可见。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useMembersApi } from "./useMembersApi";
import type { CreateMemberInput, Department, Member } from "./types";

const ASSIGNABLE_ROLES = [
  EnterpriseRole.MEMBER,
  EnterpriseRole.FINANCE_ADMIN,
  EnterpriseRole.ENTERPRISE_ADMIN,
  EnterpriseRole.OWNER,
];

export function MembersPage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);

  const api = useMembersApi();
  const [members, setMembers] = useState<Member[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // 创建成功后一次性展示的凭据（account + 管理员录入的明文）；刷新/再操作即清空。
  const [createdCredential, setCreatedCredential] = useState<{ account: string; password: string } | null>(null);

  const deptName = useMemo(() => {
    const m = new Map(departments.map((d) => [d.id, d.display_name]));
    return (id: string) => m.get(id) ?? id;
  }, [departments]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [m, d] = await Promise.all([api.listMembers(), api.listDepartments()]);
      setMembers(m);
      setDepartments(d);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.members.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = useCallback(
    async (input: CreateMemberInput) => {
      setActionError(null);
      try {
        await api.createMember(input);
        setCreatedCredential({ account: input.account, password: input.initial_password });
        await load();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : i18n.t("manager.members.action_error"));
      }
    },
    [api, load, i18n],
  );

  const handleToggleStatus = useCallback(
    async (member: Member) => {
      setActionError(null);
      const next = member.status === "active" ? "disabled" : "active";
      try {
        await api.updateMember(member.id, { status: next });
        await load();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : i18n.t("manager.members.action_error"));
      }
    },
    [api, load, i18n],
  );

  return (
    <section className="members-page">
      <h1>{i18n.t("manager.nav.members")}</h1>

      {createdCredential && (
        <div className="members-credential" role="status">
          <p>{i18n.t("manager.members.credential_once")}</p>
          <p>
            <strong>{i18n.t("manager.members.account")}</strong>：{createdCredential.account}
          </p>
          <p>
            <strong>{i18n.t("manager.members.initial_password")}</strong>：
            <code>{createdCredential.password}</code>
          </p>
          <button type="button" onClick={() => setCreatedCredential(null)}>
            {i18n.t("manager.members.credential_dismiss")}
          </button>
        </div>
      )}

      {canWrite && (
        <CreateMemberForm departments={departments} onCreate={handleCreate} />
      )}

      {actionError && <p className="members-error">{actionError}</p>}
      {error && <p className="members-error">{error}</p>}
      {loading ? (
        <p>{i18n.t("manager.members.loading")}</p>
      ) : (
        <table className="members-table">
          <thead>
            <tr>
              <th>{i18n.t("manager.members.col_name")}</th>
              <th>{i18n.t("manager.members.col_status")}</th>
              <th>{i18n.t("manager.members.col_roles")}</th>
              <th>{i18n.t("manager.members.col_departments")}</th>
              {canWrite && <th>{i18n.t("manager.members.col_actions")}</th>}
            </tr>
          </thead>
          <tbody>
            {members.length === 0 ? (
              <tr>
                <td colSpan={canWrite ? 5 : 4}>{i18n.t("manager.members.empty")}</td>
              </tr>
            ) : (
              members.map((m) => (
                <tr key={m.id} data-testid="member-row">
                  <td>{m.display_name || m.id}</td>
                  <td>{m.status}</td>
                  <td>{m.roles.join(", ")}</td>
                  <td>{m.department_ids.map(deptName).join(", ")}</td>
                  {canWrite && (
                    <td>
                      <button type="button" onClick={() => void handleToggleStatus(m)}>
                        {m.status === "active"
                          ? i18n.t("manager.members.disable")
                          : i18n.t("manager.members.enable")}
                      </button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface CreateFormProps {
  departments: Department[];
  onCreate: (input: CreateMemberInput) => void | Promise<void>;
}

function CreateMemberForm({ departments, onCreate }: CreateFormProps): ReactNode {
  const i18n = useI18n();
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<string>(EnterpriseRole.MEMBER);
  const [deptIds, setDeptIds] = useState<string[]>([]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!account.trim() || !password.trim()) return;
    void onCreate({
      account: account.trim(),
      initial_password: password,
      display_name: displayName.trim(),
      roles: [role],
      department_ids: deptIds,
    });
    setAccount("");
    setPassword("");
    setDisplayName("");
    setRole(EnterpriseRole.MEMBER);
    setDeptIds([]);
  }

  return (
    <form className="members-create" onSubmit={submit}>
      <h2>{i18n.t("manager.members.create_title")}</h2>
      <label>
        {i18n.t("manager.members.account")}
        <input value={account} onChange={(e) => setAccount(e.target.value)} required />
      </label>
      <label>
        {i18n.t("manager.members.initial_password")}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <label>
        {i18n.t("manager.members.display_name")}
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label>
        {i18n.t("manager.members.role")}
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {ASSIGNABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      {departments.length > 0 && (
        <label>
          {i18n.t("manager.members.col_departments")}
          <select
            multiple
            value={deptIds}
            onChange={(e) =>
              setDeptIds(Array.from(e.target.selectedOptions, (o) => o.value))
            }
          >
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.display_name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit">{i18n.t("manager.members.create_submit")}</button>
    </form>
  );
}
