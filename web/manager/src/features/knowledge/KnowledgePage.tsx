import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Button, Field, GlassPanel, Input, Table } from "@aiteam/shared/ui";
import { useSession } from "../../auth/session";
import { useKnowledgeApi } from "./useKnowledgeApi";
import type { KnowledgeSpace } from "./types";

export function KnowledgePage(): ReactNode {
  const { session } = useSession();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useKnowledgeApi();
  const [items, setItems] = useState<KnowledgeSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newId, setNewId] = useState(""); const [newName, setNewName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
        <GlassPanel className="overflow-hidden rounded-window">
          <Table>
            <thead><tr><th>ID</th><th>名称</th><th>Workspace</th>{canWrite && <th>操作</th>}</tr></thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.knowledge_space_id}>
                  <td>{s.knowledge_space_id}</td><td>{s.display_name || "—"}</td><td><code className="text-xs text-gold-bright">{s.workspace}</code></td>
                  {canWrite && <td><Button type="button" variant="danger" size="sm" onClick={async () => { await api.del(s.knowledge_space_id); void load(); }}>删除</Button></td>}
                </tr>
              ))}
            </tbody>
          </Table>
        </GlassPanel>
      )}
    </section>
  );
}
