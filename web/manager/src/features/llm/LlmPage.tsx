/** LLM Provider/Model 管理页（B01）：保留 API 编排，渲染拆分到直接 Astryx 区块。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ModelSection, type ModelEditor } from "./ModelSection";
import { ProviderSection, type ModelDraft, type ProviderEditor } from "./ProviderSection";
import { useLlmApi } from "./useLlmApi";
import type { LlmModel, LlmProvider } from "./types";

const CLOSED_PROVIDER_EDITOR: ProviderEditor = { mode: "closed" };
const CLOSED_MODEL_EDITOR: ModelEditor = { mode: "closed" };

function emptyModelDraft(): ModelDraft {
  return { uid: "", name: "", ctx: "", inPrice: "", outPrice: "" };
}

export function LlmPage(): ReactNode {
  const api = useLlmApi();
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [providerEditor, setProviderEditor] = useState<ProviderEditor>(CLOSED_PROVIDER_EDITOR);
  const [modelEditor, setModelEditor] = useState<ModelEditor>(CLOSED_MODEL_EDITOR);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [providerItems, modelItems] = await Promise.all([api.listProviders(), api.listModels()]);
      setProviders(providerItems);
      setModels(modelItems);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "LLM 数据加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const openProviderCreate = useCallback(() => {
    setActionError(null);
    setProviderEditor({
      mode: "create",
      name: "",
      providerKey: "",
      baseUrl: "",
      isActive: true,
      initialModels: [],
    });
  }, []);

  const openProviderEdit = useCallback((provider: LlmProvider) => {
    setActionError(null);
    setProviderEditor({
      mode: "edit",
      providerId: provider.provider_id,
      name: provider.name,
      providerKey: provider.provider_key,
      baseUrl: provider.base_url ?? "",
      isActive: provider.is_active,
      initialModels: [],
    });
  }, []);

  const updateProviderEditor = useCallback((patch: Partial<Exclude<ProviderEditor, { mode: "closed" }>>) => {
    setProviderEditor((current) => current.mode === "closed" ? current : { ...current, ...patch } as ProviderEditor);
  }, []);

  const addInitialModel = useCallback(() => {
    setProviderEditor((current) => current.mode === "create"
      ? { ...current, initialModels: [...current.initialModels, emptyModelDraft()] }
      : current);
  }, []);

  const updateInitialModel = useCallback((index: number, patch: Partial<ModelDraft>) => {
    setProviderEditor((current) => current.mode === "create"
      ? {
          ...current,
          initialModels: current.initialModels.map((draft, itemIndex) =>
            itemIndex === index ? { ...draft, ...patch } : draft),
        }
      : current);
  }, []);

  const removeInitialModel = useCallback((index: number) => {
    setProviderEditor((current) => current.mode === "create"
      ? { ...current, initialModels: current.initialModels.filter((_, itemIndex) => itemIndex !== index) }
      : current);
  }, []);

  const submitProvider = useCallback(async () => {
    if (providerEditor.mode === "closed" || !providerEditor.name) return;
    if (providerEditor.mode === "create" && !providerEditor.providerKey) return;
    setWorking(true);
    setActionError(null);
    try {
      if (providerEditor.mode === "create") {
        const created = await api.createProvider({
          name: providerEditor.name,
          provider_key: providerEditor.providerKey,
          base_url: providerEditor.baseUrl || undefined,
        });
        if (created) {
          try {
            for (const draft of providerEditor.initialModels) {
              if (!draft.uid || !draft.name) continue;
              await api.createModel(created.provider_id, {
                model_uid: draft.uid,
                model_name: draft.name,
                context_window: draft.ctx ? Number(draft.ctx) : undefined,
                input_price: draft.inPrice || undefined,
                output_price: draft.outPrice || undefined,
              });
            }
          } catch (modelErr) {
            await load();
            const message = modelErr instanceof ApiError ? modelErr.message : "模型创建失败";
            setActionError(`Provider 已创建，但初始模型创建失败：${message}`);
            return;
          }
        }
      } else {
        await api.patchProvider(providerEditor.providerId, {
          name: providerEditor.name,
          base_url: providerEditor.baseUrl || undefined,
          is_active: providerEditor.isActive,
        });
      }
      setProviderEditor(CLOSED_PROVIDER_EDITOR);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "保存失败，请重试");
    } finally {
      setWorking(false);
    }
  }, [api, load, providerEditor]);

  const deleteProvider = useCallback(async (providerId: string) => {
    setWorking(true);
    setActionError(null);
    try {
      await api.deleteProvider(providerId);
      setProviderEditor((current) => current.mode === "edit" && current.providerId === providerId
        ? CLOSED_PROVIDER_EDITOR
        : current);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "删除失败，请重试");
    } finally {
      setWorking(false);
    }
  }, [api, load]);

  const openModelCreate = useCallback(() => {
    setActionError(null);
    setModelEditor({
      mode: "create",
      providerId: providers[0]?.provider_id ?? "",
      uid: "",
      name: "",
      ctx: "",
      inPrice: "",
      outPrice: "",
    });
  }, [providers]);

  const updateModelEditor = useCallback((patch: Partial<Exclude<ModelEditor, { mode: "closed" }>>) => {
    setModelEditor((current) => current.mode === "closed" ? current : { ...current, ...patch });
  }, []);

  const submitModel = useCallback(async () => {
    if (modelEditor.mode === "closed" || !modelEditor.providerId || !modelEditor.uid || !modelEditor.name) return;
    setWorking(true);
    setActionError(null);
    try {
      await api.createModel(modelEditor.providerId, {
        model_uid: modelEditor.uid,
        model_name: modelEditor.name,
        context_window: modelEditor.ctx ? Number(modelEditor.ctx) : undefined,
        input_price: modelEditor.inPrice || undefined,
        output_price: modelEditor.outPrice || undefined,
      });
      setModelEditor(CLOSED_MODEL_EDITOR);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "模型保存失败，请重试");
    } finally {
      setWorking(false);
    }
  }, [api, load, modelEditor]);

  const deleteModel = useCallback(async (modelId: string) => {
    setWorking(true);
    setActionError(null);
    try {
      await api.deleteModel(modelId);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "模型删除失败，请重试");
    } finally {
      setWorking(false);
    }
  }, [api, load]);

  return (
    <VStack as="section" gap={6}>
      <Heading level={1}>模型目录</Heading>
      <Banner
        status="info"
        title="这里只管理模型目录，不配置 Agent 运行凭据。"
        description="请在 Provider 凭据中填写 Secret 和 supported_models，再到已招募专家选择 Provider 与模型。"
        endContent={<Button label="前往 Provider 凭据" href="/providers" variant="ghost" size="sm" />}
      />
      {error && <Banner status="error" title={error} />}
      {actionError && <Banner status="error" title={actionError} data-testid="action-error" />}
      {loading ? (
        <Card role="status" aria-label="LLM 数据加载中">
          <VStack gap={2}>
            <Text color="secondary">加载中…</Text>
            <Skeleton height={36} />
            <Skeleton height={36} index={1} />
          </VStack>
        </Card>
      ) : (
        <>
          <ProviderSection
            providers={providers}
            editor={providerEditor}
            working={working}
            onOpenCreate={openProviderCreate}
            onOpenEdit={openProviderEdit}
            onEditorChange={updateProviderEditor}
            onAddInitialModel={addInitialModel}
            onUpdateInitialModel={updateInitialModel}
            onRemoveInitialModel={removeInitialModel}
            onSubmit={() => void submitProvider()}
            onCancel={() => setProviderEditor(CLOSED_PROVIDER_EDITOR)}
            onDelete={(providerId) => void deleteProvider(providerId)}
          />
          <ModelSection
            providers={providers}
            models={models}
            editor={modelEditor}
            working={working}
            onOpenCreate={openModelCreate}
            onEditorChange={updateModelEditor}
            onSubmit={() => void submitModel()}
            onCancel={() => setModelEditor(CLOSED_MODEL_EDITOR)}
            onDelete={(modelId) => void deleteModel(modelId)}
          />
        </>
      )}
    </VStack>
  );
}
