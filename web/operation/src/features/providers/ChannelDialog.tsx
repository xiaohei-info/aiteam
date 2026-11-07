import { useMemo, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { CapabilitiesFields } from "./CapabilitiesFields";
import {
  addModelRows,
  capabilitiesToForm,
  channelToForm,
  connectionError,
  emptyChannelForm,
  formatTokens,
  formToCapabilitiesInput,
  formToChannelInput,
  mergeModelRows,
  type CapabilitiesForm,
  type ChannelForm,
  type ModelRow,
} from "./channelForm";
import type { GatewayChannel, GatewayChannelInput, GatewayChannelType, ModelCapabilitiesInput, PlatformModel, UpstreamModelPreviewInput } from "./types";

type Step = "connect" | "models" | "params";

const STEP_TITLES: Record<Step, string> = { connect: "① 连接上游", models: "② 选择模型", params: "③ 模型参数" };

interface Props {
  channel: GatewayChannel | null;
  types: GatewayChannelType[];
  /** Platform models after the latest reload; step 3 edits the ones this channel offers. */
  models: PlatformModel[];
  busy: boolean;
  onClose: () => void;
  onSave: (input: GatewayChannelInput) => Promise<void>;
  onFetchModels: (input: UpstreamModelPreviewInput) => Promise<string[]>;
  onSaveCapabilities: (modelId: string, input: ModelCapabilitiesInput) => Promise<void>;
}

/**
 * Create or edit one upstream channel in three steps: connect and fetch the upstream
 * model list, pick the models the platform offers, then tune each model's parameters.
 * The stored API key is never shown; blank keeps it.
 */
export function ChannelDialog({ channel, types, models, busy, onClose, onSave, onFetchModels, onSaveCapabilities }: Props) {
  const isNew = channel === null;
  const [step, setStep] = useState<Step>("connect");
  const [form, setForm] = useState<ChannelForm>(() => (channel ? channelToForm(channel) : emptyChannelForm()));
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState("");
  const [savedModels, setSavedModels] = useState<string[]>([]);
  const [params, setParams] = useState<Record<string, CapabilitiesForm>>({});
  const [savingParams, setSavingParams] = useState(false);
  const set = (patch: Partial<ChannelForm>) => setForm((current) => ({ ...current, ...patch }));
  const setRows = (update: (rows: ModelRow[]) => ModelRow[]) => setForm((current) => ({ ...current, rows: update(current.rows) }));

  const typeOptions = types.map((item) => ({ value: String(item.channel_type), label: item.label }));
  if (channel && !typeOptions.some((item) => item.value === String(channel.channel_type))) {
    typeOptions.push({ value: String(channel.channel_type), label: channel.channel_type_label });
  }

  const keyword = search.trim().toLowerCase();
  const visible = useMemo(
    () => form.rows.filter((row) => !keyword || row.upstream.toLowerCase().includes(keyword) || row.name.toLowerCase().includes(keyword)),
    [form.rows, keyword],
  );
  const selectedCount = form.rows.filter((row) => row.selected).length;
  const close = () => { if (!busy && !savingParams) onClose(); };

  function goToModels() {
    const problem = connectionError(form, { isNew });
    if (problem) { setError(problem); return; }
    setError(null);
    setStep("models");
  }

  async function fetchAndContinue() {
    const problem = connectionError(form, { isNew });
    if (problem) { setError(problem); return; }
    setError(null);
    setFetching(true);
    try {
      const input: UpstreamModelPreviewInput = channel && !form.key.trim()
        ? { channel_id: channel.id }
        : { channel_type: Number(form.channelType), base_url: form.baseUrl.trim(), key: form.key.trim(), ...(channel ? { channel_id: channel.id } : {}) };
      const fetched = await onFetchModels(input);
      if (!fetched.length) { setError("上游没有返回模型，可跳过获取并手动添加模型名"); return; }
      setRows((rows) => mergeModelRows(rows, fetched));
      setStep("models");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "获取模型列表失败");
    } finally {
      setFetching(false);
    }
  }

  function selectVisible(selected: boolean) {
    const names = new Set(visible.map((row) => row.upstream));
    setRows((rows) => rows.map((row) => (names.has(row.upstream) ? { ...row, selected } : row)));
  }

  function updateRow(upstream: string, patch: Partial<ModelRow>) {
    setRows((rows) => rows.map((row) => (row.upstream === upstream ? { ...row, ...patch } : row)));
  }

  function addManual() {
    if (!manual.trim()) return;
    setRows((rows) => addModelRows(rows, manual));
    setManual("");
  }

  async function saveChannel() {
    const result = formToChannelInput(form, { isNew });
    if (!result.ok) { setError(result.error); return; }
    setError(null);
    try {
      await onSave(result.value);
      setSavedModels(result.value.models);
      setStep("params");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    }
  }

  const modelById = new Map(models.map((model) => [model.model_id, model]));
  const paramForm = (model: PlatformModel) => params[model.model_id] ?? capabilitiesToForm(model);

  async function saveParams() {
    const inputs: [string, ModelCapabilitiesInput][] = [];
    for (const [modelId, value] of Object.entries(params)) {
      const result = formToCapabilitiesInput(value);
      if (!result.ok) { setError(`${modelId}：${result.error}`); return; }
      inputs.push([modelId, result.value]);
    }
    setError(null);
    setSavingParams(true);
    try {
      for (const [modelId, input] of inputs) await onSaveCapabilities(modelId, input);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存模型参数失败");
    } finally {
      setSavingParams(false);
    }
  }

  const title = isNew ? "新增上游渠道" : `编辑渠道 · ${channel.name}`;

  return (
    <Dialog isOpen purpose="form" width={720} aria-label={isNew ? "新增上游渠道" : "编辑上游渠道"} onOpenChange={(open) => { if (!open) close(); }}>
      <Layout
        header={<DialogHeader title={title} subtitle={STEP_TITLES[step]} onOpenChange={(open) => { if (!open) close(); }} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              {error && <Banner status="error" title={error} />}
              {step === "connect" && <>
                <TextInput label="渠道名称" value={form.name} onChange={(name) => set({ name })} isRequired />
                <Selector label="接口类型" options={typeOptions} value={form.channelType} onChange={(channelType) => set({ channelType })} isDisabled={!isNew} description={isNew ? undefined : "已保存渠道不能修改类型"} />
                <TextInput label="上游地址" value={form.baseUrl} onChange={(baseUrl) => set({ baseUrl })} placeholder="https://api.example.com" description="留空使用该类型的官方地址" isOptional />
                <TextInput
                  label="API Key"
                  type="password"
                  value={form.key}
                  onChange={(key) => set({ key })}
                  isRequired={isNew}
                  isOptional={!isNew}
                  description={isNew ? "只保存在 LLM 网关，保存后不再显示" : "已保存的 Key 不显示；留空表示不修改"}
                />
              </>}
              {step === "models" && <>
                <Text type="supporting">勾选平台要提供的模型；平台模型名是企业端和员工看到的名称，与上游名不同时会自动写入模型映射。{isNew ? "" : "取消勾选即从该渠道移除。"}</Text>
                <HStack gap={2} align="end">
                  <TextInput label="搜索模型" isLabelHidden value={search} onChange={setSearch} placeholder="搜索模型" width="100%" />
                  <Button label="全选" size="sm" variant="secondary" onClick={() => selectVisible(true)} isDisabled={!visible.length} />
                  <Button label="全不选" size="sm" variant="ghost" onClick={() => selectVisible(false)} isDisabled={!visible.length} />
                </HStack>
                <Text type="supporting">已选 {selectedCount} / 共 {form.rows.length} 个</Text>
                {form.rows.length === 0 && <Text type="supporting">还没有模型：返回上一步获取上游模型，或在下方手动添加。</Text>}
                <VStack gap={1}>
                  {visible.map((row) => (
                    <HStack key={row.upstream} gap={2} align="center">
                      <CheckboxInput label={row.upstream} value={row.selected} onChange={(selected) => updateRow(row.upstream, { selected })} />
                      {row.selected && (
                        <TextInput label={`${row.upstream} 平台模型名`} isLabelHidden value={row.name} onChange={(name) => updateRow(row.upstream, { name })} placeholder="平台模型名" />
                      )}
                    </HStack>
                  ))}
                </VStack>
                <HStack gap={2} align="end">
                  <TextInput label="手动添加模型" value={manual} onChange={setManual} placeholder="上游模型名，多个用逗号分隔" description="上游列表里没有的模型可在这里补充" isOptional width="100%" />
                  <Button label="添加" size="sm" variant="secondary" onClick={addManual} isDisabled={!manual.trim()} />
                </HStack>
                <TextInput label="测试模型" value={form.testModel} onChange={(testModel) => set({ testModel })} description="测试连接时使用；留空用第一个模型" isOptional />
                <Collapsible trigger={<Text weight="semibold">高级设置</Text>}>
                  <VStack gap={3}>
                    <TextArea label="自定义请求头" value={form.headerOverride} onChange={(headerOverride) => set({ headerOverride })} rows={3} placeholder={'{"X-Custom": "value"}'} description="敏感请求头显示为 ********，保持不变即沿用原值" isOptional />
                    <TextArea label="参数覆盖" value={form.paramOverride} onChange={(paramOverride) => set({ paramOverride })} rows={3} placeholder={'{"temperature": 0.7}'} description="覆盖发给上游的请求体参数" isOptional />
                    <HStack gap={2}>
                      <TextInput label="分组" value={form.group} onChange={(group) => set({ group })} />
                      <NumberInput label="优先级" value={form.priority} onChange={(priority) => set({ priority })} step={1} />
                      <NumberInput label="权重" value={form.weight} onChange={(weight) => set({ weight })} min={0} step={1} />
                    </HStack>
                  </VStack>
                </Collapsible>
              </>}
              {step === "params" && <>
                <Text type="supporting">渠道已保存。下面的参数已按公开目录预填，可逐个调整；不需要改可直接完成。保存后员工下次同步配置时生效。</Text>
                {savedModels.map((modelId) => {
                  const model = modelById.get(modelId);
                  if (!model) return <Text key={modelId} type="supporting">{modelId}：模型同步中，稍后可在「模型能力」中配置。</Text>;
                  const value = paramForm(model);
                  return (
                    <Collapsible
                      key={modelId}
                      trigger={<Text weight="semibold">{`${modelId} · 上下文 ${formatTokens(value.contextWindow)} · 最大输出 ${formatTokens(value.maxTokens)} · ${value.reasoning ? "支持思考" : "不思考"}`}</Text>}
                    >
                      <CapabilitiesFields modelId={modelId} form={value} onChange={(patch) => setParams((current) => ({ ...current, [modelId]: { ...paramForm(model), ...patch } }))} />
                    </Collapsible>
                  );
                })}
              </>}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              {step === "connect" && <>
                <Button label="取消" variant="ghost" onClick={close} isDisabled={busy || fetching} />
                <Button label={isNew ? "跳过获取，手动添加" : "下一步"} variant="secondary" onClick={goToModels} isDisabled={fetching} />
                <Button label="获取模型并继续" variant="primary" onClick={() => void fetchAndContinue()} isLoading={fetching} />
              </>}
              {step === "models" && <>
                <Button label="上一步" variant="ghost" onClick={() => { setError(null); setStep("connect"); }} isDisabled={busy} />
                <Button label="保存并继续" variant="primary" onClick={() => void saveChannel()} isLoading={busy} />
              </>}
              {step === "params" && <>
                <Button label={Object.keys(params).length ? "放弃参数修改" : "完成"} variant="ghost" onClick={onClose} isDisabled={savingParams} />
                {Object.keys(params).length > 0 && <Button label="保存参数" variant="primary" onClick={() => void saveParams()} isLoading={savingParams} />}
              </>}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
