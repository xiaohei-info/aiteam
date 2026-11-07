import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { HStack } from "@astryxdesign/core/HStack";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { THINKING_LEVELS, thinkingLabel, type ThinkingLevel } from "../catalog/register/thinking";
import type { CapabilitiesForm } from "./channelForm";
import type { ThinkingMode } from "./types";

const MODE_OPTIONS = [
  { value: "effort", label: "按档位（reasoning effort）" },
  { value: "toggle", label: "开关（只有开/关）" },
  { value: "budget", label: "按思考预算（token）" },
];

interface Props {
  /** Prefix for accessible labels when several models are edited on one screen. */
  modelId: string;
  form: CapabilitiesForm;
  onChange: (patch: Partial<CapabilitiesForm>) => void;
}

/** Context window, output cap, image input and thinking levels of one model. */
export function CapabilitiesFields({ modelId, form, onChange }: Props) {
  const toggleLevel = (level: ThinkingLevel, on: boolean) =>
    onChange({ levels: on ? [...form.levels, level] : form.levels.filter((item) => item !== level) });

  return (
    <VStack gap={3}>
      <TextInput label="显示名称" value={form.displayName} onChange={(displayName) => onChange({ displayName })} isOptional />
      <HStack gap={2}>
        <NumberInput label="上下文窗口（tokens）" value={form.contextWindow} hasClear onChange={(contextWindow) => onChange({ contextWindow })} min={1024} step={1} description="留空按 128K 处理" isOptional />
        <NumberInput label="最大输出（tokens）" value={form.maxTokens} hasClear onChange={(maxTokens) => onChange({ maxTokens })} min={1} step={1} description="留空由运行时决定" isOptional />
      </HStack>
      <CheckboxInput label="支持图片输入" value={form.image} onChange={(image) => onChange({ image })} />
      <Switch label="支持思考" value={form.reasoning} onChange={(reasoning) => onChange({ reasoning, thinkingMode: reasoning && form.thinkingMode === "none" ? "effort" : form.thinkingMode })} />
      {form.reasoning && <>
        <Selector label="思考方式" options={MODE_OPTIONS} value={form.thinkingMode === "none" ? "effort" : form.thinkingMode} onChange={(value) => onChange({ thinkingMode: value as ThinkingMode })} />
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
                    label={`${modelId} ${level} 上游取值`}
                    isLabelHidden
                    value={form.levelMap[level] ?? ""}
                    onChange={(value) => onChange({ levelMap: { ...form.levelMap, [level]: value } })}
                    placeholder={level === "off" ? "none" : level}
                  />
                )}
              </HStack>
            );
          })}
        </VStack>
      </>}
    </VStack>
  );
}
