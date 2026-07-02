import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Button, Field, GlassPanel, Input, Select, Table } from "@aiteam/shared/ui";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import { useKnowledgeApi } from "./useKnowledgeApi";
import type { KnowledgeBinding, KnowledgeSpace } from "./types";
import { DocumentsPanel } from "./DocumentsPanel";

interface ResourceOption { id: string; label: string; }

/** 知识空间绑定资源类型（对齐后端 routes_knowledge_space + BindingCreate 口径）。 */
type BindResourceType = "expert" | "department" | "member";
const BIND_RESOURCE_TYPES: BindResourceType[] = ["expert", "department", "member"];
const RESOURCE_TYPE_LABEL: Record<BindResourceType, string> = {
  expert: "专家",
  department: "部门",
  member: "成员",
};
function resourceTypeLabel(t: string): string {
  return (RESOURCE_TYPE_LABEL as Record<string, string>)[t] ?? t;
}

export function KnowledgePage(): ReactNode {
  const { session, token, onUnauthorized } = useSession();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useKnowledgeApi();
  const [items, setItems] = useState<KnowledgeSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newId, setNewId] = useState(""); const [newName, setNewName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 文档管理抽屉：当前打开文档面板的知识空间（null=关闭）。
  const [docSpaceId, setDocSpaceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setItems(await api.list()); }
    catch (err) { setError(err instanceof ApiError ? err.message : "加载失败"); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  async function handleCreate(e: FormEvent): Promise<void> {
    e.preventDefault(); setFormError(null);
    if (!newId.trim()) { setFormError("知识空间 ID 不能为空"); return; }
    setSubmitting(true);
    try {
      await api.create({ knowledge_space_id: newId.trim(), display_name: newName.trim() || undefined });
      setNewId(""); setNewName(""); setShowForm(false); void load();
    } catch (err) { setFormError(err instanceof ApiError ? err.message : "创建失败"); }
    finally { setSubmitting(false); }
  }

  // ---- 绑定面板（选一个知识空间展示/管理其绑定） ----
  const [bindingSpaceId, setBindingSpaceId] = useState<string | null>(null);
  const bindingSpace = useMemo(
    () => items.find((s) => s.knowledge_space_id === bindingSpaceId) ?? null,
    [items, bindingSpaceId],
  );
  const [bindings, setBindings] = useState<KnowledgeBinding[]>([]);
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [bindingsError, setBindingsError] = useState<string | null>(null);

  const [experts, setExperts] = useState<ResourceOption[]>([]);
  const [departments, setDepartments] = useState<ResourceOption[]>([]);
  const [members, setMembers] = useState<ResourceOption[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);

  const [bindType, setBindType] = useState<BindResourceType>("expert");
  const [bindResourceId, setBindResourceId] = useState("");
  const [bindError, setBindError] = useState<string | null>(null);
  const [bindNotice, setBindNotice] = useState<string | null>(null);
  const [bindSubmitting, setBindSubmitting] = useState(false);

  const reloadBindings = useCallback(async (id: string) => {
    setBindingsLoading(true); setBindingsError(null);
    try { setBindings(await api.listBindings(id)); }
    catch (err) { setBindingsError(err instanceof ApiError ? err.message : "加载绑定失败"); setBindings([]); }
    finally { setBindingsLoading(false); }
  }, [api]);

  const openBindings = useCallback(
    async (id: string) => {
      setBindingSpaceId(id);
      setBindError(null); setBindNotice(null); setBindResourceId(""); setBindType("expert");
      setCandidatesLoading(true);
      const c = createManagerApiClient({ getToken: () => token, onUnauthorized });
      try {
        const [emp, dep, mem] = await Promise.all([
          c.listGet<{ employee_id?: string; display_name?: string }>("/api/manager/employees"),
          c.listGet<{ id: string; display_name: string }>("/api/manager/departments"),
          c.listGet<{ id: string; display_name: string }>("/api/manager/members"),
        ]);
        setExperts((emp.items ?? []).map((e) => ({ id: e.employee_id ?? "", label: e.display_name ?? e.employee_id ?? "" })));
        setDepartments((dep.items ?? []).map((d) => ({ id: d.id, label: d.display_name })));
        setMembers((mem.items ?? []).map((m) => ({ id: m.id, label: m.display_name })));
        await reloadBindings(id);
      } catch (err) {
        setBindingsError(err instanceof ApiError ? err.message : "加载候选资源失败");
      } finally {
        setCandidatesLoading(false);
      }
    },
    [token, onUnauthorized, reloadBindings],
  );

  const closeBindings = useCallback(() => {
    setBindingSpaceId(null); setBindings([]); setExperts([]); setDepartments([]); setMembers([]);
    setBindError(null); setBindNotice(null); setBindResourceId("");
  }, []);

  const resourceOptions: ResourceOption[] = useMemo(() => {
    if (bindType === "expert") return experts;
    if (bindType === "department") return departments;
    return members;
  }, [bindType, experts, departments, members]);

  async function handleBind(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!bindingSpaceId || !bindResourceId) { setBindError("请选择要绑定的目标"); return; }
    setBindSubmitting(true); setBindError(null); setBindNotice(null);
    try {
      await api.bind(bindingSpaceId, { resource_type: bindType, resource_id: bindResourceId });
      setBindNotice("绑定成功");
      setBindResourceId("");
      await reloadBindings(bindingSpaceId);
      void load();
    } catch (err) {
      setBindError(err instanceof ApiError ? err.message : "绑定失败");
    } finally {
      setBindSubmitting(false);
    }
  }

  async function handleUnbind(target: KnowledgeBinding): Promise<void> {
    if (!bindingSpaceId) return;
    setBindError(null); setBindNotice(null);
    try {
      await api.unbind(bindingSpaceId, target.resource_type, target.resource_id);
      setBindNotice("已解绑");
      await reloadBindings(bindingSpaceId);
      void load();
    } catch (err) {
      setBindError(err instanceof ApiError ? err.message : "解绑失败");
    }
  }

  const resolveResourceLabel = useCallback(
    (b: KnowledgeBinding): string => {
      const list = b.resource_type === "expert" ? experts : b.resource_type === "department" ? departments : members;
      const hit = list.find((o) => o.id === b.resource_id);
      return hit ? hit.label : b.resource_id;
    },
    [experts, departments, members],
  );

  return (
    <section className="flex flex-col gap-lg">
      <h1 className="m-0 text-xl font-bold text-text-primary">企业 RAG 知识库</h1>
      {canWrite && !showForm && (
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setShowForm(true)}>新建知识空间</Button>
      )}
      {showForm && (
        <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
          <h2 className="m-0 text-base font-semibold text-text-primary">新建知识空间</h2>
          <form className="flex flex-col gap-md" onSubmit={handleCreate}>
            <Field label="知识空间 ID"><Input type="text" value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="ks-sales" disabled={submitting} /></Field>
            <Field label="显示名称（可选）"><Input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="销售知识库" disabled={submitting} /></Field>
            {formError && <p className="m-0 text-sm text-danger">{formError}</p>}
            <div className="flex gap-sm">
              <Button type="submit" disabled={submitting} className="self-start">{submitting ? "创建中…" : "创建"}</Button>
              <Button type="button" variant="ghost" disabled={submitting} onClick={() => setShowForm(false)}>取消</Button>
            </div>
          </form>
        </GlassPanel>
      )}
      {error && <GlassPanel className="rounded-window border border-danger/30 p-md text-sm text-danger">{error}</GlassPanel>}
      {loading ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>
      ) : items.length === 0 ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">暂无知识空间。</GlassPanel>
      ) : (
        <>
          <GlassPanel className="overflow-hidden rounded-window">
            <Table>
              <thead><tr><th>ID</th><th>名称</th><th>Workspace</th>{canWrite && <th>操作</th>}</tr></thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.knowledge_space_id}>
                    <td>{s.knowledge_space_id}</td><td>{s.display_name || "—"}</td><td><code className="text-xs text-gold-bright">{s.workspace}</code></td>
                    {canWrite && (
                      <td className="flex gap-sm">
                        <Button type="button" variant="ghost" size="sm" onClick={() => setDocSpaceId(s.knowledge_space_id)}>文档</Button>
                         <Button type="button" variant="ghost" size="sm" onClick={() => void openBindings(s.knowledge_space_id)}>绑定</Button>
                        <Button type="button" variant="danger" size="sm" onClick={async () => { await api.del(s.knowledge_space_id); void load(); }}>删除</Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          </GlassPanel>
        </>
      )}

      {bindingSpace && (
        <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-base font-semibold text-text-primary">
              绑定管理 · {bindingSpace.display_name || bindingSpace.knowledge_space_id}
            </h2>
            <Button type="button" variant="ghost" size="sm" onClick={closeBindings}>关闭</Button>
          </div>

          {bindNotice && <p className="m-0 text-sm text-success" role="status">{bindNotice}</p>}
          {bindingsError && <p className="m-0 text-sm text-danger">{bindingsError}</p>}
          {bindError && <p className="m-0 text-sm text-danger">{bindError}</p>}

          {candidatesLoading || bindingsLoading ? (
            <p className="m-0 text-sm text-text-secondary">加载中…</p>
          ) : (
            <>
              <div className="flex flex-col gap-sm">
                <span className="text-xs text-text-secondary">当前绑定</span>
                {bindings.length === 0 ? (
                  <p className="m-0 text-sm text-text-muted">暂无绑定。</p>
                ) : (
                  <Table>
                    <thead><tr><th>类型</th><th>对象</th><th></th></tr></thead>
                    <tbody>
                      {bindings.map((b) => (
                        <tr key={b.id}>
                          <td>{resourceTypeLabel(b.resource_type)}</td>
                          <td>{resolveResourceLabel(b)}</td>
                          <td>
                            <Button type="button" variant="danger" size="sm" onClick={() => void handleUnbind(b)}>解绑</Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </div>

              <form className="flex flex-col gap-md" onSubmit={handleBind}>
                <span className="text-xs text-text-secondary">新增绑定</span>
                <div className="flex flex-wrap items-end gap-md">
                  <Field label="绑定类型">
                    <Select value={bindType} onChange={(e) => { setBindType(e.target.value as BindResourceType); setBindResourceId(""); }}>
                      {BIND_RESOURCE_TYPES.map((t) => <option key={t} value={t}>{RESOURCE_TYPE_LABEL[t]}</option>)}
                    </Select>
                  </Field>
                  <Field label="绑定对象">
                    <Select value={bindResourceId} onChange={(e) => setBindResourceId(e.target.value)} disabled={resourceOptions.length === 0}>
                      <option value="">{resourceOptions.length === 0 ? "无可用目标" : "请选择"}</option>
                      {resourceOptions.map((o) => <option key={o.id} value={o.id}>{o.label || o.id}</option>)}
                    </Select>
                  </Field>
                  <Button type="submit" disabled={bindSubmitting || !bindResourceId} className="self-start">
                    {bindSubmitting ? "绑定中…" : "绑定"}
                  </Button>
                </div>
              </form>
            </>
          )}
        </GlassPanel>
      )}

      {docSpaceId && (
        <DocumentsPanel
          spaceId={docSpaceId}
          canWrite={canWrite}
          onClose={() => setDocSpaceId(null)}
        />
      )}
    </section>
  );
}
