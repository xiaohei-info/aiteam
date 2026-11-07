import { useState, type FormEvent } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { THINKING_LEVELS, thinkingLabel, type ThinkingLevel } from "../catalog/register/thinking";
import { capabilitiesToForm, formToCapabilitiesInput, type CapabilitiesForm } from "./channelForm";
import type { ModelCapabilitiesInput, PlatformModel, ThinkingMode } from "./types";

const MODE_OPTIONS = [
  { value: "effort", label: "按档位（reasoning effort）" },
  { value: "toggle", label: "开关（只有开/关）" },
  { value: "budget", label: "按思考预算（token）" },
];

interface Props {
  model: PlatformModel;
  busy: boolean;
  onClose: () => void;
  onSave: (input: ModelCapabilitiesInput) => Promise<void>;
}

/** Context window, output cap, thinking levels and image input that the local Pi runtime uses for this model. */
export function CapabilitiesDialog({ model, busy, onClose, onSave }: Props) {
  const [form, setForm] = useState<CapabilitiesForm>(() => capabilitiesToForm(model));
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<CapabilitiesForm>) => setForm((current) => ({ ...current, ...patch }));
  const toggleLevel = (level: ThinkingLevel, on: boolean) =>
    set({ levels: on ? [...form.levels, level] : form.levels.filter((item) => item !== level) });

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = formToCapabilitiesInput(form);
    if (!result.ok) { setError(result.error); return; }
    setError(null);
    void onSave(result.value).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "保存失败"));
  }

  return (
    <Dialog isOpen purpose="form" width={600} aria-label="模型配置" onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <form onSubmit={submit}>
        <VStack gap={3}>
          <Heading level={2}>{model.model_id} · 模型配置</Heading>
          {error && <Banner status="error" title={error} />}
          <TextInput label="显示名称" value={form.displayName} onChange={(displayName) => set({ displayName })} isOptional />
          <HStack gap={2}>
            <NumberInput label="上下文窗口（tokens）" value={form.contextWindow} hasClear onChange={(contextWindow) => set({ contextWindow })} min={1024} step={1} description="留空按 128K 处理" isOptional />
            <NumberInput label="最大输出（tokens）" value={form.maxTokens} hasClear onChange={(maxTokens) => set({ maxTokens })} min={1} step={1} description="留空由运行时决定" isOptional />
          </HStack>
          <CheckboxInput label="支持图片输入" value={form.image} onChange={(image) => set({ image })} />
          <Switch label="支持思考" value={form.reasoning} onChange={(reasoning) => set({ reasoning, thinkingMode: reasoning && form.thinkingMode === "none" ? "effort" : form.thinkingMode })} />
          {form.reasoning && <>
            <Selector label="思考方式" options={MODE_OPTIONS} value={form.thinkingMode === "none" ? "effort" : form.thinkingMode} onChange={(value) => set({ thinkingMode: value as ThinkingMode })} />
            <VStack gap={1}>
              <Text weight="semibold">思考档位与上游取值</Text>
              <Text type="supporting">勾选员工可选的档位；右侧填写发给上游的值，留空沿用档位名。</Text>
              {THINKING_LEVELS.map((level) => {
                const enabled = level === "off" || form.levels.includes(level);
                return (
                  <HStack key={level} gap={2} align="center">
                    <CheckboxInput label={thinkingLabel(level, { thinking_mode: form.thinkingMode })} value={enabled} isDisabled={level === "off"} onChange={(on) => toggleLevel(level, on)} />
                    {enabled && (
                      <TextInput
                        label={`${level} 上游取值`}
                        isLabelHidden
                        value={form.levelMap[level] ?? ""}
                        onChange={(value) => set({ levelMap: { ...form.levelMap, [level]: value } })}
                        placeholder={level === "off" ? "none" : level}
                      />
                    )}
                  </HStack>
                );
              })}
            </VStack>
          </>}
          <Text type="supporting">保存后，员工下次同步配置时生效；已冻结的快照不受影响。</Text>
          <HStack justify="end" gap={2}>
            <Button label="取消" onClick={onClose} isDisabled={busy} />
            <Button label="保存配置" type="submit" variant="primary" isLoading={busy} />
          </HStack>
        </VStack>
      </form>
    </Dialog>
  );
}
