/**
 * Provider 凭据管理页（W-M.6 M5）。
 * 红线（D18）：不展示/缓存明文 secret；只回 provider_ref + 非敏感元数据。
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Button, Field, GlassPanel, Input, Table } from "@aiteam/shared/ui";
import { useSession } from "../../auth/session";
import { useProvidersApi } from "./useProvidersApi";
import type { ProviderCredential, CreateProviderInput } from "./types";

export function ProvidersPage(): ReactNode {
  const { session } = useSession();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useProvidersApi();
  const [items, setItems] = useState<ProviderCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CreateProviderInput>({ provider_ref: "", secret: "" });
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
    e.preventDefault();
    setFormError(null);
    if (!form.provider_ref.trim() || !form.secret.trim()) {
      setFormError("provider_ref 和 secret 为必填"); return;
    }
    setSubmitting(true);
    try {
      await api.create(form);
      setForm({ provider_ref: "", secret: "" });
      setShowForm(false);
      void load();
    } catch (err) { setFormError(err instanceof ApiError ? err.message : "创建失败"); }
    finally { setSubmitting(false); }
  }

  return (
    <section className="flex flex-col gap-lg">
      <h1 className="m-0 text-xl font-bold text-text-primary">Provider 凭据</h1>
      {canWrite && !showForm && (
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setShowForm(true)}>
          新增凭据
        </Button>
      )}
      {showForm && (
        <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
          <h2 className="m-0 text-base font-semibold text-text-primary">新增凭据</h2>
          <p className="m-0 text-xs text-warning">⚠️ secret 明文仅在此次提交中使用，服务端加密存储后不再回显。</p>
          <form className="flex flex-col gap-md" onSubmit={handleCreate}>
            <Field label="Provider Ref"><Input type="text" value={form.provider_ref}
              onChange={(e) => setForm((p) => ({ ...p, provider_ref: e.target.value }))} placeholder="my-openai-key" disabled={submitting} /></Field>
            <Field label="显示名称（可选）"><Input type="text" value={form.display_name ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, display_name: e.target.value }))} placeholder="OpenAI Key" disabled={submitting} /></Field>
            <Field label="Secret（明文，仅本次）"><Input type="password" value={form.secret}
              onChange={(e) => setForm((p) => ({ ...p, secret: e.target.value }))} placeholder="sk-..." disabled={submitting} /></Field>
            {formError && <p className="m-0 text-sm text-danger">{formError}</p>}
            <div className="flex gap-sm">
              <Button type="submit" disabled={submitting} className="self-start">{submitting ? "提交中…" : "创建"}</Button>
              <Button type="button" variant="ghost" disabled={submitting} onClick={() => setShowForm(false)}>取消</Button>
            </div>
          </form>
        </GlassPanel>
      )}
      {error && <GlassPanel className="rounded-window border border-danger/30 p-md text-sm text-danger">{error}</GlassPanel>}
      {loading ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>
      ) : items.length === 0 ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">暂无 Provider 凭据。</GlassPanel>
      ) : (
        <GlassPanel className="overflow-hidden rounded-window">
          <Table>
            <thead><tr><th>Provider Ref</th><th>名称</th><th>模式</th><th>可见性</th><th>版本</th>{canWrite && <th>操作</th>}</tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.credential_id}>
                  <td><code className="text-gold-bright">{c.provider_ref}</code></td>
                  <td>{c.display_name || "—"}</td>
                  <td>{c.mode}</td>
                  <td>{c.visibility}</td>
                  <td>{c.version}</td>
                  {canWrite && (
                    <td>
                      <Button type="button" variant="danger" size="sm"
                        onClick={async () => { await api.del(c.credential_id); void load(); }}>
                        删除
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        </GlassPanel>
      )}
    </section>
  );
}
