import { useState, type FormEvent } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { channelToForm, emptyChannelForm, formToChannelInput, parseModelList, type ChannelForm } from "./channelForm";
import type { GatewayChannel, GatewayChannelInput, GatewayChannelType, UpstreamModelPreviewInput } from "./types";

interface Props {
  channel: GatewayChannel | null;
  types: GatewayChannelType[];
  busy: boolean;
  onClose: () => void;
  onSave: (input: GatewayChannelInput) => Promise<void>;
  onFetchModels: (input: UpstreamModelPreviewInput) => Promise<string[]>;
}

/** Create or edit one upstream channel. The stored API key is never shown; blank keeps it. */
export function ChannelDialog({ channel, types, busy, onClose, onSave, onFetchModels }: Props) {
  const isNew = channel === null;
  const [form, setForm] = useState<ChannelForm>(() => (channel ? channelToForm(channel) : emptyChannelForm()));
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(!isNew && Boolean(form.modelMapping || form.headerOverride || form.paramOverride));
  const set = (patch: Partial<ChannelForm>) => setForm((current) => ({ ...current, ...patch }));

  const typeOptions = types.map((item) => ({ value: String(item.channel_type), label: item.label }));
  if (channel && !typeOptions.some((item) => item.value === String(channel.channel_type))) {
    typeOptions.push({ value: String(channel.channel_type), label: channel.channel_type_label });
  }

  async function fetchModels() {
    setError(null);
    if (isNew && !form.key.trim()) { setError("获取模型列表需要先填写 API Key"); return; }
    setFetching(true);
    try {
      const input: UpstreamModelPreviewInput = channel && !form.key.trim()
        ? { channel_id: channel.id }
        : { channel_type: Number(form.channelType), base_url: form.baseUrl.trim(), key: form.key.trim(), ...(channel ? { channel_id: channel.id } : {}) };
      const fetched = await onFetchModels(input);
      if (!fetched.length) { setError("上游没有返回模型"); return; }
      set({ models: [...new Set([...parseModelList(form.models), ...fetched])].join("\n") });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "获取模型列表失败");
    } finally {
      setFetching(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = formToChannelInput(form, { isNew });
    if (!result.ok) { setError(result.error); return; }
    setError(null);
    void onSave(result.value).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "保存失败"));
  }

  return (
    <Dialog isOpen purpose="form" width={640} aria-label={isNew ? "新增上游渠道" : "编辑上游渠道"} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <form onSubmit={submit}>
        <VStack gap={3}>
          <Heading level={2}>{isNew ? "新增上游渠道" : `编辑渠道 · ${channel.name}`}</Heading>
          {error && <Banner status="error" title={error} />}
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
          <TextArea label="模型" value={form.models} onChange={(models) => set({ models })} rows={4} placeholder="每行一个模型名" description="对外提供的模型名，每行一个或用逗号分隔" isRequired />
          <HStack gap={2} align="center">
            <Button label="从上游获取模型" size="sm" variant="secondary" isLoading={fetching} isDisabled={busy} onClick={() => void fetchModels()} />
            <Text type="supporting">会合并到上面的模型列表</Text>
          </HStack>
          <TextInput label="测试模型" value={form.testModel} onChange={(testModel) => set({ testModel })} description="测试连接时使用；留空用第一个模型" isOptional />
          <Button label={showAdvanced ? "收起高级设置" : "高级设置"} size="sm" variant="ghost" onClick={() => setShowAdvanced((value) => !value)} />
          {showAdvanced && <>
            <TextArea label="模型映射" value={form.modelMapping} onChange={(modelMapping) => set({ modelMapping })} rows={3} placeholder={'{"对外模型名": "上游实际模型名"}'} isOptional />
            <TextArea label="自定义请求头" value={form.headerOverride} onChange={(headerOverride) => set({ headerOverride })} rows={3} placeholder={'{"X-Custom": "value"}'} description="敏感请求头显示为 ********，保持不变即沿用原值" isOptional />
            <TextArea label="参数覆盖" value={form.paramOverride} onChange={(paramOverride) => set({ paramOverride })} rows={3} placeholder={'{"temperature": 0.7}'} description="覆盖发给上游的请求体参数" isOptional />
            <HStack gap={2}>
              <TextInput label="分组" value={form.group} onChange={(group) => set({ group })} />
              <NumberInput label="优先级" value={form.priority} onChange={(priority) => set({ priority })} step={1} />
              <NumberInput label="权重" value={form.weight} onChange={(weight) => set({ weight })} min={0} step={1} />
            </HStack>
          </>}
          <HStack justify="end" gap={2}>
            <Button label="取消" onClick={onClose} isDisabled={busy} />
            <Button label="保存渠道" type="submit" variant="primary" isLoading={busy} />
          </HStack>
        </VStack>
      </form>
    </Dialog>
  );
}
