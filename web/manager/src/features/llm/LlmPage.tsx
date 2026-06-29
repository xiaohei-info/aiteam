/** LLM Provider/Model 管理页。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Field, GlassPanel, Input } from "@aiteam/shared/ui";
import { useLlmApi } from "./useLlmApi";
import type { LlmProvider, LlmModel } from "./types";

export function LlmPage(): ReactNode {
  const api = useLlmApi();
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKey, setNewKey] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try { const [p, m] = await Promise.all([api.listProviders(), api.listModels()]); setProviders(p); setModels(m); } catch { /* ignore */ } finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="flex flex-col gap-md">
      <div className="flex items-center justify-between">
        <h1 className="m-0 text-xl font-bold text-text-primary">LLM 管理</h1>
        <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>+ 新增 Provider</Button>
      </div>

      {showForm && (
        <GlassPanel className="rounded-window p-md">
          <Field label="Provider 名称"><Input value={newName} onChange={(e) => setNewName((e.target as HTMLInputElement).value)} /></Field>
          <Field label="Provider Key"><Input value={newKey} onChange={(e) => setNewKey((e.target as HTMLInputElement).value)} /></Field>
          <div className="mt-sm"><Button variant="primary" size="sm" onClick={async () => { if (newName && newKey) { await api.createProvider({ name: newName, provider_key: newKey }); setNewName(""); setNewKey(""); setShowForm(false); await load(); } }}>创建</Button><Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>取消</Button></div>
        </GlassPanel>
      )}

      {loading ? <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel> : (
        <>
          <GlassPanel className="rounded-window p-md">
            <h2 className="m-0 mb-sm text-sm font-bold text-text-primary">Providers</h2>
            {providers.length === 0 ? <p className="text-sm text-text-secondary">暂无 Provider</p> : (
              <table className="w-full text-sm"><thead><tr className="border-b border-gold/15 text-left text-xs text-text-muted"><th className="pb-sm">名称</th><th className="pb-sm">Key</th><th className="pb-sm">模型数</th><th className="pb-sm">状态</th></tr></thead>
                <tbody>{providers.map((p) => (<tr key={p.provider_id} className="border-b border-gold/5"><td className="py-sm text-text-primary">{p.name}</td><td className="py-sm text-text-secondary">{p.provider_key}</td><td className="py-sm text-text-secondary">{p.model_count}</td><td className="py-sm">{p.is_active ? <span className="text-success">启用</span> : <span className="text-danger">停用</span>}</td></tr>))}</tbody>
              </table>
            )}
          </GlassPanel>
          <GlassPanel className="rounded-window p-md">
            <h2 className="m-0 mb-sm text-sm font-bold text-text-primary">Models</h2>
            {models.length === 0 ? <p className="text-sm text-text-secondary">暂无模型</p> : (
              <table className="w-full text-sm"><thead><tr className="border-b border-gold/15 text-left text-xs text-text-muted"><th className="pb-sm">Model UID</th><th className="pb-sm">名称</th><th className="pb-sm">上下文窗口</th></tr></thead>
                <tbody>{models.map((m) => (<tr key={m.model_id} className="border-b border-gold/5"><td className="py-sm text-text-primary">{m.model_uid}</td><td className="py-sm text-text-secondary">{m.model_name}</td><td className="py-sm text-text-secondary">{m.context_window ?? "—"}</td></tr>))}</tbody>
              </table>
            )}
          </GlassPanel>
        </>
      )}
    </section>
  );
}
