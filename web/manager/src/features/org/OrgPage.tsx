/** P07 组织架构页 — 树形展示 + 员工部门分配（GH#343）。 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Button, Field, GlassPanel, Select } from "@aiteam/shared/ui";
import { useI18n } from "../../i18n/context";
import { useOrgApi } from "./useOrgApi";
import type { OrgTreeNode } from "./types";

interface DepartmentOption {
  id: string;
  name: string;
}

/** 收集树中全部部门（用于分配下拉）。 */
function collectDepartments(node: OrgTreeNode, out: DepartmentOption[]): void {
  if (node.type === "department") out.push({ id: node.id, name: node.name });
  node.children?.forEach((c) => collectDepartments(c, out));
}

interface EmployeeNodeProps {
  node: OrgTreeNode;
  depth: number;
  departments: DepartmentOption[];
  onAssign: (employee: OrgTreeNode) => void;
}

function EmployeeNode({ node, depth, departments, onAssign }: EmployeeNodeProps): ReactNode {
  const i18n = useI18n();
  const canAssign = departments.length > 0;
  return (
    <div style={{ paddingLeft: `${depth * 24}px` }} data-testid="org-node">
      <div className="flex items-center gap-sm py-xs">
        <span className="text-text-primary">👤</span>
        <span className="text-sm text-text-primary">{node.name}</span>
        {node.status && (
          <span className={`text-xs ${node.status === "online" ? "text-success" : "text-text-muted"}`}>
            ●{node.status}
          </span>
        )}
        {canAssign && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-xs"
            onClick={() => onAssign(node)}
            data-testid={`assign-trigger-${node.id}`}
          >
            {i18n.t("manager.org.assign")}
          </Button>
        )}
      </div>
    </div>
  );
}

interface NodeViewProps {
  node: OrgTreeNode;
  depth: number;
  departments: DepartmentOption[];
  onAssign: (employee: OrgTreeNode) => void;
}

function NodeView({ node, depth, departments, onAssign }: NodeViewProps): ReactNode {
  if (node.type === "employee") {
    return <EmployeeNode node={node} depth={depth} departments={departments} onAssign={onAssign} />;
  }
  return (
    <div style={{ paddingLeft: `${depth * 24}px` }} data-testid="org-node">
      <div className="flex items-center gap-sm py-xs">
        <span className="text-gold-bright">📁</span>
        <span className="text-sm text-text-primary">{node.name}</span>
      </div>
      {node.children?.map((c) => (
        <NodeView key={c.id} node={c} depth={depth + 1} departments={departments} onAssign={onAssign} />
      ))}
    </div>
  );
}

interface AssignModalProps {
  employee: OrgTreeNode;
  departments: DepartmentOption[];
  onClose: () => void;
  onAssigned: () => void;
}

function AssignModal({ employee, departments, onClose, onAssigned }: AssignModalProps): ReactNode {
  const i18n = useI18n();
  const api = useOrgApi();
  const [departmentId, setDepartmentId] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!departmentId) return;
      setPending(true);
      setError(null);
      try {
        await api.assignDepartment(employee.id, departmentId);
        setDone(true);
        onAssigned();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : i18n.t("manager.org.assign_error"));
      } finally {
        setPending(false);
      }
    },
    [api, employee.id, departmentId, onAssigned, i18n],
  );

  return (
    <div
      className="fixed inset-0 z-[1300] flex items-center justify-center px-md"
      role="dialog"
      aria-modal="true"
      aria-label={i18n.t("manager.org.assign_title")}
    >
      <div className="absolute inset-0 bg-bg-canvas/70" onClick={onClose} />
      <GlassPanel
        className="relative z-[1301] w-full max-w-md rounded-window p-lg"
        role="document"
        data-testid="assign-modal"
      >
        <form className="flex flex-col gap-md" onSubmit={submit}>
          <h2 className="m-0 text-base font-semibold text-text-primary">
            {i18n.t("manager.org.assign_title")}
          </h2>
          <p className="m-0 text-sm text-text-secondary">{employee.name}</p>

          <Field label={i18n.t("manager.org.department_pick")}>
            <Select
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              disabled={pending || done}
              data-testid="assign-department-select"
              required
            >
              <option value="" disabled>
                {i18n.t("manager.org.department_pick")}
              </option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>

          {error && <p className="m-0 text-sm text-danger">{error}</p>}
          {done && (
            <p className="m-0 text-sm text-success" data-testid="assign-success">
              {i18n.t("manager.org.assign_ok")}
            </p>
          )}

          <div className="flex items-center gap-sm justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={pending}>
              {i18n.t("common.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={pending || done || !departmentId}>
              {pending
                ? i18n.t("manager.org.assign_pending")
                : done
                  ? i18n.t("manager.org.assign_ok")
                  : i18n.t("manager.org.assign_submit")}
            </Button>
          </div>
        </form>
      </GlassPanel>
    </div>
  );
}

export function OrgPage(): ReactNode {
  const i18n = useI18n();
  const api = useOrgApi();
  const [tree, setTree] = useState<OrgTreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<OrgTreeNode | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTree(await api.getTree());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.members.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => {
    void load();
  }, [load]);

  const departments = useMemo(() => {
    if (!tree) return [];
    const out: DepartmentOption[] = [];
    collectDepartments(tree, out);
    return out;
  }, [tree]);

  if (loading) {
    return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>;
  }

  return (
    <section className="flex flex-col gap-md">
      <h1 className="m-0 text-xl font-bold text-text-primary">组织架构</h1>
      {error && <GlassPanel className="rounded-window p-md text-sm text-danger">{error}</GlassPanel>}
      <GlassPanel className="rounded-window p-md">
        {tree ? (
          <NodeView node={tree} depth={0} departments={departments} onAssign={setAssignTarget} />
        ) : (
          <p className="text-sm text-text-secondary">暂无数据</p>
        )}
      </GlassPanel>

      {assignTarget && (
        <AssignModal
          employee={assignTarget}
          departments={departments}
          onClose={() => setAssignTarget(null)}
          onAssigned={() => void load()}
        />
      )}
    </section>
  );
}
