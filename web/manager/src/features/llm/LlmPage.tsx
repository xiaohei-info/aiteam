/** LLM Provider/Model 管理页（B01）：Provider 增删改/启用禁用 + Model 增删查。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Button, Field, GlassPanel, Input, Select } from "@aiteam/shared/ui";
import { useLlmApi } from "./useLlmApi";
import type { LlmProvider, LlmModel } from "./types";

type Mode = "idle" | "create" | "edit";
type ModelMode = "idle" | "create";

export function LlmPage(): ReactNode {
  const api = useLlmApi();
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Provider 表单状态
  const [mode, setMode] = useState<Mode>("idle");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formKey, setFormKey] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formIsActive, setFormIsActive] = useState(true);

  // Model 表单状态
  const [mMode, setMMode] = useState<ModelMode>("idle");
  const [mProviderId, setMProviderId] = useState("");
  const [mUid, setMUid] = useState("");
  const [mName, setMName] = useState("");
  const [mCtx, setMCtx] = useState("");
  const [mInPrice, setMInPrice] = useState("");
  const [mOutPrice, setMOutPrice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, m] = await Promise.all([api.listProviders(), api.listModels()]);
      setProviders(p);
      setModels(m);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "LLM 数据加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = useCallback(() => {
    setFormName("");
    setFormKey("");
    setFormBaseUrl("");
    setFormIsActive(true);
    setMode("idle");
    setEditingId(null);
  }, []);

  const openCreate = useCallback(() => {
    resetForm();
    setMode("create");
    setActionError(null);
  }, [resetForm]);

  const openEdit = useCallback((p: LlmProvider) => {
    setFormName(p.name);
    setFormKey(p.provider_key); // 仅展示，提交时不改动
    setFormBaseUrl(p.base_url ?? "");
    setFormIsActive(p.is_active);
    setEditingId(p.provider_id);
    setMode("edit");
    setActionError(null);
  }, []);

  const submit = useCallback(async () => {
    if (!formName) return;
    setActionError(null);
    try {
      if (mode === "create") {
        if (!formKey) return;
        await api.createProvider({ name: formName, provider_key: formKey, base_url: formBaseUrl || undefined });
      } else if (mode === "edit" && editingId) {
        await api.patchProvider(editingId, { name: formName, base_url: formBaseUrl || undefined, is_active: formIsActive });
      } else {
        return;
      }
      resetForm();
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "保存失败，请重试");
    }
  }, [api, mode, editingId, formName, formKey, formBaseUrl, formIsActive, resetForm, load]);

  const handleDelete = useCallback(async (id: string) => {
    setActionError(null);
    try {
      await api.deleteProvider(id);
      if (editingId === id) resetForm();
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "删除失败，请重试");
    }
  }, [api, editingId, resetForm, load]);

  // ---- Model 表单 ----
  const resetModelForm = useCallback(() => {
    setMMode("idle");
    setMProviderId("");
    setMUid("");
    setMName("");
    setMCtx("");
    setMInPrice("");
    setMOutPrice("");
  }, []);

  const openModelCreate = useCallback(() => {
    resetModelForm();
    // 默认选中第一个 Provider
    setMProviderId(providers[0]?.provider_id ?? "");
    setMMode("create");
    setActionError(null);
  }, [providers, resetModelForm]);

  const submitModel = useCallback(async () => {
    if (!mProviderId || !mUid || !mName) return;
    setActionError(null);
    try {
      await api.createModel(mProviderId, {
        model_uid: mUid,
        model_name: mName,
        context_window: mCtx ? Number(mCtx) : undefined,
        input_price: mInPrice || undefined,
        output_price: mOutPrice || undefined,
      });
      resetModelForm();
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "模型保存失败，请重试");
    }
  }, [api, mProviderId, mUid, mName, mCtx, mInPrice, mOutPrice, resetModelForm, load]);

  const handleDeleteModel = useCallback(async (id: string) => {
    setActionError(null);
    try {
      await api.deleteModel(id);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "模型删除失败，请重试");
    }
  }, [api, load]);

  const isActiveLabel = (active: boolean) =>
    active ? <span className="text-success">启用</span> : <span className="text-danger">停用</span>;

  const editingProvider = editingId ? providers.find((p) => p.provider_id === editingId) ?? null : null;
  const providerName = (pid: string) => providers.find((p) => p.provider_id === pid)?.name ?? pid;

  return (
    <section className="flex flex-col gap-md">
      <div className="flex items-center justify-between">
        <h1 className="m-0 text-xl font-bold text-text-primary">LLM 管理</h1>
        {mode === "idle" && (
          <Button variant="metal" size="sm" data-testid="open-create" onClick={openCreate}>+ 新增 Provider</Button>
        )}
      </div>

      {error && <GlassPanel className="rounded-window p-md text-sm text-danger">{error}</GlassPanel>}
      {actionError && <GlassPanel className="rounded-window p-md text-sm text-danger" data-testid="action-error">{actionError}</GlassPanel>}

      {mode !== "idle" && (
        <GlassPanel className="rounded-window p-md" data-testid={mode === "create" ? "create-form" : "edit-form"}>
          <h2 className="m-0 mb-sm text-sm font-bold text-text-primary">{mode === "create" ? "新增 Provider" : `编辑 Provider：${editingProvider?.provider_key ?? ""}`}</h2>
          <Field label="Provider 名称"><Input value={formName} onChange={(e) => setFormName((e.target as HTMLInputElement).value)} data-testid="field-name" /></Field>
          {mode === "create" ? (
            <Field label="Provider Key"><Input value={formKey} onChange={(e) => setFormKey((e.target as HTMLInputElement).value)} data-testid="field-key" /></Field>
          ) : (
            <Field label="Provider Key"><Input value={formKey} disabled data-testid="field-key" /></Field>
          )}
          <Field label="Base URL"><Input value={formBaseUrl} onChange={(e) => setFormBaseUrl((e.target as HTMLInputElement).value)} data-testid="field-baseurl" /></Field>
          {mode === "edit" && (
            <Field label="启用">
              <label className="flex items-center gap-sm text-sm text-text-primary">
                <input type="checkbox" checked={formIsActive} onChange={(e) => setFormIsActive(e.target.checked)} data-testid="field-is-active" />
                <span>{formIsActive ? "启用" : "停用"}</span>
              </label>
            </Field>
          )}
          <div className="mt-sm flex gap-sm">
            <Button variant="metal" size="sm" data-testid="submit-form" onClick={() => void submit()}>{mode === "create" ? "创建" : "保存"}</Button>
            <Button variant="ghost" size="sm" onClick={resetForm}>取消</Button>
            {mode === "edit" && editingId && (
              <Button variant="danger" size="sm" data-testid="delete-provider" onClick={() => void handleDelete(editingId)}>删除</Button>
            )}
          </div>
        </GlassPanel>
      )}

      {loading ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>
      ) : (
        <>
          <GlassPanel className="rounded-window p-md">
            <h2 className="m-0 mb-sm text-sm font-bold text-text-primary">Providers</h2>
            {providers.length === 0 ? (
              <p className="text-sm text-text-secondary">暂无 Provider</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gold/15 text-left text-xs text-text-muted">
                    <th className="pb-sm">名称</th>
                    <th className="pb-sm">Key</th>
                    <th className="pb-sm">Base URL</th>
                    <th className="pb-sm">模型数</th>
                    <th className="pb-sm">状态</th>
                    <th className="pb-sm">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map((p) => (
                    <tr key={p.provider_id} className="border-b border-gold/5" data-testid="provider-row">
                      <td className="py-sm text-text-primary">{p.name}</td>
                      <td className="py-sm text-text-secondary">{p.provider_key}</td>
                      <td className="py-sm text-text-secondary">{p.base_url ?? "—"}</td>
                      <td className="py-sm text-text-secondary">{p.model_count}</td>
                      <td className="py-sm">{isActiveLabel(p.is_active)}</td>
                      <td className="py-sm">
                        <div className="flex gap-sm">
                          <Button variant="ghost" size="sm" data-testid={`edit-${p.provider_id}`} onClick={() => openEdit(p)}>编辑</Button>
                          <Button variant="danger" size="sm" data-testid={`delete-${p.provider_id}`} onClick={() => void handleDelete(p.provider_id)}>删除</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </GlassPanel>

          <GlassPanel className="rounded-window p-md">
            <div className="mb-sm flex items-center justify-between">
              <h2 className="m-0 text-sm font-bold text-text-primary">Models</h2>
              {mMode === "idle" && providers.length > 0 && (
                <Button variant="metal" size="sm" data-testid="open-create-model" onClick={openModelCreate}>+ 新增模型</Button>
              )}
            </div>

            {mMode === "create" && (
              <div className="mb-md rounded-window border border-gold/15 p-md" data-testid="model-create-form">
                <h3 className="m-0 mb-sm text-sm font-bold text-text-primary">新增模型</h3>
                <Field label="关联 Provider">
                  <Select value={mProviderId} onChange={(e) => setMProviderId((e.target as HTMLSelectElement).value)} data-testid="m-field-provider">
                    {providers.map((p) => (
                      <option key={p.provider_id} value={p.provider_id}>{p.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Model UID"><Input value={mUid} onChange={(e) => setMUid((e.target as HTMLInputElement).value)} data-testid="m-field-uid" /></Field>
                <Field label="Model 名称"><Input value={mName} onChange={(e) => setMName((e.target as HTMLInputElement).value)} data-testid="m-field-name" /></Field>
                <Field label="上下文窗口"><Input value={mCtx} type="number" onChange={(e) => setMCtx((e.target as HTMLInputElement).value)} data-testid="m-field-ctx" /></Field>
                <Field label="输入价格"><Input value={mInPrice} onChange={(e) => setMInPrice((e.target as HTMLInputElement).value)} data-testid="m-field-in-price" placeholder="如 0.001" /></Field>
                <Field label="输出价格"><Input value={mOutPrice} onChange={(e) => setMOutPrice((e.target as HTMLInputElement).value)} data-testid="m-field-out-price" placeholder="如 0.002" /></Field>
                <div className="mt-sm flex gap-sm">
                  <Button variant="metal" size="sm" data-testid="submit-model" onClick={() => void submitModel()}>创建</Button>
                  <Button variant="ghost" size="sm" onClick={resetModelForm}>取消</Button>
                </div>
              </div>
            )}

            {models.length === 0 ? (
              <p className="text-sm text-text-secondary">暂无模型</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gold/15 text-left text-xs text-text-muted">
                    <th className="pb-sm">Model UID</th>
                    <th className="pb-sm">名称</th>
                    <th className="pb-sm">Provider</th>
                    <th className="pb-sm">上下文窗口</th>
                    <th className="pb-sm">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.model_id} className="border-b border-gold/5" data-testid="model-row">
                      <td className="py-sm text-text-primary">{m.model_uid}</td>
                      <td className="py-sm text-text-secondary">{m.model_name}</td>
                      <td className="py-sm text-text-secondary">{providerName(m.provider_id)}</td>
                      <td className="py-sm text-text-secondary">{m.context_window ?? "—"}</td>
                      <td className="py-sm">
                        <Button variant="danger" size="sm" data-testid={`delete-model-${m.model_id}`} onClick={() => void handleDeleteModel(m.model_id)}>删除</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </GlassPanel>
        </>
      )}
    </section>
  );
}
