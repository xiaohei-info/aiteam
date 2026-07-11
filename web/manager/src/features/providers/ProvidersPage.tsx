/**
 * Provider 凭据管理页（W-M.6 M5, AITEAM-681）。
 * 红线（D18）：不展示/缓存明文 secret；只回 provider_ref + 非敏感元数据。
 * 支持在创建时声明 supported_models 能力目录，供招募时按 default_model 自动匹配 provider_ref。
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Code } from "@astryxdesign/core/CodeBlock";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { useProvidersApi } from "./useProvidersApi";
import type { ProviderCredential, CreateProviderInput } from "./types";
import type { ProviderModelCapability } from "./types";

type ProviderRow = ProviderCredential & Record<string, unknown>;

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
  const [models, setModels] = useState<ProviderModelCapability[]>([]);

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
      await api.create({ ...form, supported_models: models.filter((m) => m.model.trim() !== "") });
      setForm({ provider_ref: "", secret: "" });
      setModels([]);
      setShowForm(false);
      void load();
    } catch (err) { setFormError(err instanceof ApiError ? err.message : "创建失败"); }
    finally { setSubmitting(false); }
  }

  const columns = useMemo<TableColumn<ProviderRow>[]>(() => {
    const base: TableColumn<ProviderRow>[] = [
      {
        key: "provider_ref",
        header: "Provider Ref",
        width: proportional(1),
        renderCell: (provider) => <Code>{provider.provider_ref}</Code>,
      },
      { key: "display_name", header: "名称", width: proportional(1), renderCell: (provider) => provider.display_name || "—" },
      { key: "mode", header: "模式", width: pixel(110) },
      { key: "visibility", header: "可见性", width: pixel(110) },
      { key: "version", header: "版本", width: pixel(80) },
    ];
    if (!canWrite) return base;
    return [
      ...base,
      {
        key: "actions",
        header: "操作",
        width: pixel(100),
        align: "end",
        resizable: false,
        renderCell: (provider) => (
          <Button
            label="删除"
            variant="destructive"
            size="sm"
            clickAction={async () => {
              await api.del(provider.credential_id);
              await load();
            }}
          />
        ),
      },
    ];
  }, [api, canWrite, load]);

  return (
    <VStack as="section" gap={6}>
      <HStack justify="between" align="center" wrap="wrap" gap={3}>
        <Heading level={1}>Provider 凭据</Heading>
        {canWrite && (
          <Button label="新增凭据" variant="primary" onClick={() => setShowForm(true)} />
        )}
      </HStack>

      {showForm && (
        <Dialog
          isOpen
          purpose="form"
          width={760}
          maxHeight="90vh"
          aria-label="新增凭据"
          onOpenChange={(isOpen) => { if (!isOpen && !submitting) setShowForm(false); }}
        >
          <Layout
            height="auto"
            header={
              <DialogHeader
                title="新增凭据"
                subtitle="Secret 明文仅用于此次提交，服务端加密存储后不再回显。"
                onOpenChange={(isOpen) => { if (!isOpen && !submitting) setShowForm(false); }}
              />
            }
            content={
              <LayoutContent>
                <form id="provider-create-form" onSubmit={handleCreate}>
                  <VStack gap={5}>
                    {formError && <Banner status="error" title={formError} />}
                    <FormLayout>
                      <TextInput
                        label="Provider Ref"
                        value={form.provider_ref}
                        onChange={(value) => setForm((previous) => ({ ...previous, provider_ref: value }))}
                        placeholder="my-openai-key"
                        isDisabled={submitting}
                        isRequired
                      />
                      <TextInput
                        label="显示名称（可选）"
                        value={form.display_name ?? ""}
                        onChange={(value) => setForm((previous) => ({ ...previous, display_name: value }))}
                        placeholder="OpenAI Key"
                        isDisabled={submitting}
                        isOptional
                      />
                      <TextInput
                        label="Secret（明文，仅本次）"
                        type="password"
                        value={form.secret}
                        onChange={(value) => setForm((previous) => ({ ...previous, secret: value }))}
                        placeholder="sk-..."
                        isDisabled={submitting}
                        isRequired
                      />
                    </FormLayout>

                    <VStack gap={3}>
                      <VStack gap={1}>
                        <Heading level={3}>能力目录（supported_models）</Heading>
                        <Text color="secondary">声明本 Provider 支持的模型；招募时按专家 default_model 自动匹配。</Text>
                      </VStack>
              {models.map((m, idx) => (
                        <Card key={idx} variant="muted" padding={3}>
                          <VStack gap={3}>
                            <Grid columns={{ minWidth: 220, repeat: "fit" }} gap={3}>
                              <TextInput
                                label={`模型标识 ${idx + 1}`}
                                isLabelHidden
                                value={m.model}
                                onChange={(value) => setModels((previous) => previous.map((item, index) => index === idx ? { ...item, model: value } : item))}
                                placeholder="模型标识，如 gpt-4o"
                                isDisabled={submitting}
                              />
                              <TextInput
                                label={`模型显示名 ${idx + 1}`}
                                isLabelHidden
                                value={m.display_name ?? ""}
                                onChange={(value) => setModels((previous) => previous.map((item, index) => index === idx ? { ...item, display_name: value } : item))}
                                placeholder="显示名（可选）"
                                isDisabled={submitting}
                              />
                            </Grid>
                            <HStack gap={3} align="center" justify="between" wrap="wrap">
                              <CheckboxInput
                                label="启用"
                                value={m.enabled !== false}
                                onChange={(checked) => setModels((previous) => previous.map((item, index) => index === idx ? { ...item, enabled: checked } : item))}
                                isDisabled={submitting}
                              />
                              <Button
                                label="移除"
                                variant="destructive"
                                size="sm"
                                isDisabled={submitting}
                                onClick={() => setModels((previous) => previous.filter((_, index) => index !== idx))}
                              />
                            </HStack>
                          </VStack>
                        </Card>
              ))}
                      <Button
                        label="＋ 添加模型"
                        variant="secondary"
                        size="sm"
                        isDisabled={submitting}
                        onClick={() => setModels((previous) => [...previous, { model: "", display_name: "", enabled: true }])}
                      />
                    </VStack>
                  </VStack>
                </form>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <HStack gap={2} justify="end">
                  <Button label="取消" variant="ghost" isDisabled={submitting} onClick={() => setShowForm(false)} />
                  <Button
                    label="创建"
                    variant="primary"
                    type="submit"
                    form="provider-create-form"
                    isLoading={submitting}
                  />
                </HStack>
              </LayoutFooter>
            }
          />
        </Dialog>
      )}
      {error && <Banner status="error" title={error} />}
      {loading ? (
        <Card role="status" aria-label="Provider 凭据加载中">
          <VStack gap={2}><Text color="secondary">加载中…</Text><Skeleton height={36} /><Skeleton height={36} index={1} /></VStack>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState headingLevel={2} title="暂无 Provider 凭据。" />
      ) : (
        <Card padding={0}>
          <Table
            aria-label="Provider 凭据"
            tableProps={{ "aria-label": "Provider 凭据" }}
            data={items as ProviderRow[]}
            columns={columns}
            idKey="credential_id"
            hasHover
            textOverflow="truncate"
          />
        </Card>
      )}
    </VStack>
  );
}
