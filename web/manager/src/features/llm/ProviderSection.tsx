import { useMemo, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
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
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import type { LlmProvider } from "./types";

export interface ModelDraft {
  uid: string;
  name: string;
  ctx: string;
  inPrice: string;
  outPrice: string;
}

interface ProviderDraft {
  name: string;
  providerKey: string;
  baseUrl: string;
  isActive: boolean;
  initialModels: ModelDraft[];
}

export type ProviderEditor =
  | { mode: "closed" }
  | ({ mode: "create" } & ProviderDraft)
  | ({ mode: "edit"; providerId: string } & ProviderDraft);

type ProviderRow = LlmProvider & Record<string, unknown>;

interface ProviderSectionProps {
  providers: LlmProvider[];
  editor: ProviderEditor;
  working: boolean;
  onOpenCreate: () => void;
  onOpenEdit: (provider: LlmProvider) => void;
  onEditorChange: (patch: Partial<Exclude<ProviderEditor, { mode: "closed" }>>) => void;
  onAddInitialModel: () => void;
  onUpdateInitialModel: (index: number, patch: Partial<ModelDraft>) => void;
  onRemoveInitialModel: (index: number) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onDelete: (providerId: string) => void;
}

export function ProviderSection({
  providers,
  editor,
  working,
  onOpenCreate,
  onOpenEdit,
  onEditorChange,
  onAddInitialModel,
  onUpdateInitialModel,
  onRemoveInitialModel,
  onSubmit,
  onCancel,
  onDelete,
}: ProviderSectionProps): ReactNode {
  const columns = useMemo<TableColumn<ProviderRow>[]>(() => [
    {
      key: "name",
      header: "名称",
      width: proportional(1),
      renderCell: (provider) => <Text weight="bold" data-testid="provider-row">{provider.name}</Text>,
    },
    { key: "provider_key", header: "Key", width: proportional(1), renderCell: (provider) => <Code>{provider.provider_key}</Code> },
    { key: "base_url", header: "Base URL", width: proportional(1), renderCell: (provider) => provider.base_url ?? "—" },
    { key: "model_count", header: "模型数", width: pixel(90) },
    {
      key: "is_active",
      header: "状态",
      width: pixel(90),
      renderCell: (provider) => <Badge label={provider.is_active ? "启用" : "停用"} variant={provider.is_active ? "success" : "neutral"} />,
    },
    {
      key: "actions",
      header: "",
      width: pixel(180),
      align: "end",
      resizable: false,
      renderCell: (provider) => (
        <HStack gap={2} justify="end">
          <Button label="编辑" variant="ghost" size="sm" data-testid={`edit-${provider.provider_id}`} onClick={() => onOpenEdit(provider)} />
          <Button label="删除" variant="destructive" size="sm" data-testid={`delete-${provider.provider_id}`} isDisabled={working} onClick={() => onDelete(provider.provider_id)} />
        </HStack>
      ),
    },
  ], [onDelete, onOpenEdit, working]);

  const title = editor.mode === "create" ? "新增 Provider" : editor.mode === "edit" ? `编辑 Provider：${editor.providerKey}` : "";

  return (
    <VStack gap={4}>
      <HStack gap={3} align="center" justify="between" wrap="wrap">
        <Heading level={2}>Provider</Heading>
        <Button label="＋ 新增 Provider" variant="primary" size="sm" data-testid="open-create" onClick={onOpenCreate} />
      </HStack>
      <Card padding={0}>
        <Table
          aria-label="Provider 列表"
          tableProps={{ "aria-label": "Provider 列表" }}
          data={providers as ProviderRow[]}
          columns={columns}
          idKey="provider_id"
          hasHover
          emptyState={<EmptyState title="暂无 Provider" isCompact />}
        />
      </Card>

      {editor.mode !== "closed" && (
        <Dialog
          isOpen
          purpose="form"
          width={760}
          aria-label={title}
          onOpenChange={(isOpen) => { if (!isOpen && !working) onCancel(); }}
          data-testid={editor.mode === "create" ? "create-form" : "edit-form"}
        >
          <Layout
            height="auto"
            header={<DialogHeader title={title} onOpenChange={(isOpen) => { if (!isOpen && !working) onCancel(); }} />}
            content={
              <LayoutContent>
                <VStack gap={5}>
                  <FormLayout>
                    <TextInput label="Provider 名称" value={editor.name} onChange={(name) => onEditorChange({ name })} data-testid="field-name" isRequired isDisabled={working} />
                    <TextInput label="Provider Key" value={editor.providerKey} onChange={(providerKey) => onEditorChange({ providerKey })} data-testid="field-key" isRequired isDisabled={working || editor.mode === "edit"} />
                    <TextInput label="Base URL" value={editor.baseUrl} onChange={(baseUrl) => onEditorChange({ baseUrl })} data-testid="field-baseurl" isOptional isDisabled={working} />
                    {editor.mode === "edit" && (
                      <CheckboxInput label="启用" value={editor.isActive} onChange={(isActive) => onEditorChange({ isActive })} isDisabled={working} />
                    )}
                  </FormLayout>

                  {editor.mode === "create" && (
                    <VStack gap={3}>
                      <HStack gap={3} align="center" justify="between" wrap="wrap">
                        <VStack gap={1}>
                          <Heading level={3}>初始模型（可选）</Heading>
                          <Text color="secondary">创建 Provider 后按顺序创建这些模型。</Text>
                        </VStack>
                        <Button label="＋ 添加模型" variant="secondary" size="sm" data-testid="add-initial-model" isDisabled={working} onClick={onAddInitialModel} />
                      </HStack>
                      {editor.initialModels.length === 0 ? (
                        <EmptyState title="暂不添加初始模型" isCompact />
                      ) : editor.initialModels.map((draft, index) => (
                        <Card key={index} variant="muted" padding={3} data-testid={`initial-model-row-${index}`}>
                          <VStack gap={3}>
                            <HStack gap={3} align="center" justify="between">
                              <Text weight="bold">模型 {index + 1}</Text>
                              <Button label="移除" variant="destructive" size="sm" data-testid={`remove-initial-model-${index}`} isDisabled={working} onClick={() => onRemoveInitialModel(index)} />
                            </HStack>
                            <Grid columns={{ minWidth: 210, repeat: "fit" }} gap={3}>
                              <TextInput label={`模型标识 ${index + 1}`} value={draft.uid} onChange={(uid) => onUpdateInitialModel(index, { uid })} data-testid={`initial-model-uid-${index}`} placeholder="如 gpt-4" isRequired isDisabled={working} />
                              <TextInput label={`模型名称 ${index + 1}`} value={draft.name} onChange={(name) => onUpdateInitialModel(index, { name })} data-testid={`initial-model-name-${index}`} placeholder="如 GPT-4" isRequired isDisabled={working} />
                              <TextInput label={`上下文窗口 ${index + 1}`} value={draft.ctx} onChange={(ctx) => onUpdateInitialModel(index, { ctx })} data-testid={`initial-model-ctx-${index}`} placeholder="128000" isOptional isDisabled={working} />
                              <TextInput label={`输入价格 ${index + 1}`} value={draft.inPrice} onChange={(inPrice) => onUpdateInitialModel(index, { inPrice })} data-testid={`initial-model-in-price-${index}`} placeholder="0.001" isOptional isDisabled={working} />
                              <TextInput label={`输出价格 ${index + 1}`} value={draft.outPrice} onChange={(outPrice) => onUpdateInitialModel(index, { outPrice })} data-testid={`initial-model-out-price-${index}`} placeholder="0.002" isOptional isDisabled={working} />
                            </Grid>
                          </VStack>
                        </Card>
                      ))}
                    </VStack>
                  )}
                </VStack>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <HStack gap={2} justify="between" wrap="wrap">
                  {editor.mode === "edit" ? (
                    <Button label="删除 Provider" variant="destructive" size="sm" data-testid="delete-provider" isDisabled={working} onClick={() => onDelete(editor.providerId)} />
                  ) : <span />}
                  <HStack gap={2} justify="end">
                    <Button label="取消" variant="ghost" isDisabled={working} onClick={onCancel} />
                    <Button label={editor.mode === "create" ? "创建" : "保存"} variant="primary" data-testid="submit-form" isLoading={working} onClick={onSubmit} />
                  </HStack>
                </HStack>
              </LayoutFooter>
            }
          />
        </Dialog>
      )}
    </VStack>
  );
}
