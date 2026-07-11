import { useMemo, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/CodeBlock";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import type { LlmModel, LlmProvider } from "./types";

interface ModelDraft {
  providerId: string;
  uid: string;
  name: string;
  ctx: string;
  inPrice: string;
  outPrice: string;
}

export type ModelEditor = { mode: "closed" } | ({ mode: "create" } & ModelDraft);
type ModelRow = LlmModel & Record<string, unknown>;

interface ModelSectionProps {
  providers: LlmProvider[];
  models: LlmModel[];
  editor: ModelEditor;
  working: boolean;
  onOpenCreate: () => void;
  onEditorChange: (patch: Partial<Exclude<ModelEditor, { mode: "closed" }>>) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onDelete: (modelId: string) => void;
}

export function ModelSection({ providers, models, editor, working, onOpenCreate, onEditorChange, onSubmit, onCancel, onDelete }: ModelSectionProps): ReactNode {
  const providerNames = useMemo(() => new Map(providers.map((provider) => [provider.provider_id, provider.name])), [providers]);
  const columns = useMemo<TableColumn<ModelRow>[]>(() => [
    { key: "model_uid", header: "模型标识", width: proportional(1), renderCell: (model) => <Code data-testid="model-row">{model.model_uid}</Code> },
    { key: "model_name", header: "名称", width: proportional(1), renderCell: (model) => <Text weight="bold">{model.model_name}</Text> },
    { key: "provider_id", header: "Provider", width: proportional(1), renderCell: (model) => providerNames.get(model.provider_id) ?? model.provider_id },
    { key: "context_window", header: "上下文窗口", width: pixel(130), renderCell: (model) => model.context_window ?? "—" },
    { key: "is_active", header: "状态", width: pixel(90), renderCell: (model) => <Badge label={model.is_active ? "启用" : "停用"} variant={model.is_active ? "success" : "neutral"} /> },
    {
      key: "actions",
      header: "",
      width: pixel(90),
      align: "end",
      resizable: false,
      renderCell: (model) => <Button label="删除" variant="destructive" size="sm" data-testid={`delete-model-${model.model_id}`} isDisabled={working} onClick={() => onDelete(model.model_id)} />,
    },
  ], [onDelete, providerNames, working]);

  return (
    <VStack gap={4}>
      <HStack gap={3} align="center" justify="between" wrap="wrap">
        <Heading level={2}>模型</Heading>
        {providers.length > 0 && <Button label="＋ 新增模型" variant="primary" size="sm" data-testid="open-create-model" onClick={onOpenCreate} />}
      </HStack>
      <Card padding={0}>
        <Table
          aria-label="模型列表"
          tableProps={{ "aria-label": "模型列表" }}
          data={models as ModelRow[]}
          columns={columns}
          idKey="model_id"
          hasHover
          emptyState={<EmptyState title="暂无模型" isCompact />}
        />
      </Card>

      {editor.mode === "create" && (
        <Dialog isOpen purpose="form" width={620} aria-label="新增模型" onOpenChange={(isOpen) => { if (!isOpen && !working) onCancel(); }} data-testid="model-create-form">
          <Layout
            height="auto"
            header={<DialogHeader title="新增模型" onOpenChange={(isOpen) => { if (!isOpen && !working) onCancel(); }} />}
            content={
              <LayoutContent>
                <FormLayout>
                  <Selector label="关联 Provider" options={providers.map((provider) => ({ value: provider.provider_id, label: provider.name }))} value={editor.providerId} onChange={(providerId) => onEditorChange({ providerId })} data-testid="m-field-provider" isRequired isDisabled={working} />
                  <TextInput label="模型标识" value={editor.uid} onChange={(uid) => onEditorChange({ uid })} data-testid="m-field-uid" placeholder="如 gpt-4" isRequired isDisabled={working} />
                  <TextInput label="模型名称" value={editor.name} onChange={(name) => onEditorChange({ name })} data-testid="m-field-name" placeholder="如 GPT-4" isRequired isDisabled={working} />
                  <TextInput label="上下文窗口" value={editor.ctx} onChange={(ctx) => onEditorChange({ ctx })} data-testid="m-field-ctx" placeholder="128000" isOptional isDisabled={working} />
                  <TextInput label="输入价格" value={editor.inPrice} onChange={(inPrice) => onEditorChange({ inPrice })} data-testid="m-field-in-price" placeholder="0.001" isOptional isDisabled={working} />
                  <TextInput label="输出价格" value={editor.outPrice} onChange={(outPrice) => onEditorChange({ outPrice })} data-testid="m-field-out-price" placeholder="0.002" isOptional isDisabled={working} />
                </FormLayout>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <HStack gap={2} justify="end">
                  <Button label="取消" variant="ghost" isDisabled={working} onClick={onCancel} />
                  <Button label="创建" variant="primary" data-testid="submit-model" isLoading={working} onClick={onSubmit} />
                </HStack>
              </LayoutFooter>
            }
          />
        </Dialog>
      )}
    </VStack>
  );
}
