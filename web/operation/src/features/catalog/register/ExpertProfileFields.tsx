import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { HStack } from "@astryxdesign/core/HStack";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import {
  BILLING_PERIODS,
  BILLING_PERIOD_LABELS,
  OUTPUT_TYPES,
  OUTPUT_TYPE_LABELS,
  PRICING_MODES,
  PRICING_MODE_LABELS,
  PROFILE_LIMITS,
  UNIT_PRICE_HINTS,
  type BillingPeriod,
  type ExpertTemplateProfile,
  type OutputType,
  type PricingMode,
  type ProfileErrors,
} from "../profile";

export interface ExpertProfileFieldsProps {
  value: ExpertTemplateProfile;
  disabled: boolean;
  errors?: ProfileErrors;
  onChange: (next: ExpertTemplateProfile) => void;
}

function errorStatus(message?: string) {
  return message ? { type: "error" as const, message } : undefined;
}

const OUTPUT_TYPE_OPTIONS = OUTPUT_TYPES.map((type) => ({ value: type, label: OUTPUT_TYPE_LABELS[type] }));
const NO_PRICING = "none";
const PRICING_OPTIONS = [
  { value: NO_PRICING, label: "不展示计价" },
  ...PRICING_MODES.map((mode) => ({ value: mode, label: PRICING_MODE_LABELS[mode] })),
];
const BILLING_PERIOD_OPTIONS = BILLING_PERIODS.map((period) => ({ value: period, label: BILLING_PERIOD_LABELS[period] }));

/** 每行一条。保存原始行（含空行），提交时由 profilePayload 去空白，避免输入换行时被吞掉。 */
function LinesField({ label, description, value, rows = 3, disabled, error, onChange }: {
  label: string;
  description: string;
  value: string[];
  rows?: number;
  disabled: boolean;
  error?: string;
  onChange: (lines: string[]) => void;
}) {
  return (
    <TextArea
      label={label}
      description={description}
      value={value.join("\n")}
      onChange={(text) => onChange(text.split("\n"))}
      rows={rows}
      isOptional
      isDisabled={disabled}
      status={errorStatus(error)}
    />
  );
}

/** 专家模板的人才市场展示字段；所有字段可选，旧模板不填也有效。 */
export function ExpertProfileFields({ value, disabled, errors = {}, onChange }: ExpertProfileFieldsProps) {
  const set = <K extends keyof ExpertTemplateProfile>(key: K, next: ExpertTemplateProfile[K]) => onChange({ ...value, [key]: next });
  const permissions = value.required_permissions ?? { full_access: false, local_directories: false };
  const outputs = value.sample_outputs;
  const updateOutput = (index: number, patch: Partial<(typeof outputs)[number]>) =>
    set("sample_outputs", outputs.map((output, i) => (i === index ? { ...output, ...patch } : output)));

  return (
    <VStack gap={4} data-testid="expert-profile-fields">
      <Text weight="bold">人才市场展示</Text>
      <FormLayout>
        <TextInput
          label="一句话定位 (tagline)"
          description={`≤${PROFILE_LIMITS.tagline} 字；不填时市场卡片取岗位描述开头`}
          value={value.tagline}
          onChange={(tagline) => set("tagline", tagline)}
          isOptional
          isDisabled={disabled}
          status={errorStatus(errors.tagline)}
        />
        <LinesField
          label="适用场景 (use_cases)"
          description={`每行一条，每条 ≤${PROFILE_LIMITS.useCaseLength} 字，最多 ${PROFILE_LIMITS.useCases} 条`}
          value={value.use_cases}
          rows={4}
          disabled={disabled}
          error={errors.use_cases}
          onChange={(lines) => set("use_cases", lines)}
        />
        <LinesField
          label="不适用场景 (limitations)"
          description={`每行一条，最多 ${PROFILE_LIMITS.limitations} 条`}
          value={value.limitations}
          disabled={disabled}
          error={errors.limitations}
          onChange={(lines) => set("limitations", lines)}
        />
        <LinesField
          label="示例问题 (example_prompts)"
          description={`每行一条，最多 ${PROFILE_LIMITS.examplePrompts} 条`}
          value={value.example_prompts}
          disabled={disabled}
          error={errors.example_prompts}
          onChange={(lines) => set("example_prompts", lines)}
        />
        <MultiSelector
          label="产出类型 (output_types)"
          options={OUTPUT_TYPE_OPTIONS}
          value={value.output_types}
          onChange={(types) => set("output_types", types as OutputType[])}
          placeholder="选择交付物类型"
          triggerDisplay="labels"
          isOptional
          isDisabled={disabled}
        />
      </FormLayout>

      <VStack gap={2}>
        <Text type="supporting" color="secondary">示例产出 (sample_outputs，最多 {PROFILE_LIMITS.sampleOutputs} 个)</Text>
        {outputs.map((output, index) => (
          <HStack key={index} gap={2} align="end" wrap="wrap" data-testid="sample-output-row">
            <TextInput label="标题" value={output.title} onChange={(title) => updateOutput(index, { title })} isDisabled={disabled} />
            <Selector
              label="类型"
              options={OUTPUT_TYPE_OPTIONS}
              value={output.output_type}
              onChange={(type) => updateOutput(index, { output_type: type as OutputType })}
              isDisabled={disabled}
              width={160}
            />
            <TextInput label="预览链接" value={output.preview_url} onChange={(preview_url) => updateOutput(index, { preview_url })} placeholder="https://…（可选）" isDisabled={disabled} />
            <Button label="移除" variant="ghost" onClick={() => set("sample_outputs", outputs.filter((_, i) => i !== index))} isDisabled={disabled} />
          </HStack>
        ))}
        {errors.sample_outputs && <Banner status="error" title={errors.sample_outputs} />}
        {outputs.length < PROFILE_LIMITS.sampleOutputs && (
          <HStack>
            <Button
              label="添加示例产出"
              variant="secondary"
              onClick={() => set("sample_outputs", [...outputs, { title: "", output_type: "document", preview_url: "" }])}
              isDisabled={disabled}
            />
          </HStack>
        )}
      </VStack>

      <FormLayout>
        <LinesField
          label="必需的外部系统 (required_connectors)"
          description={`每行一个连接器标识，最多 ${PROFILE_LIMITS.connectors} 个`}
          value={value.required_connectors}
          disabled={disabled}
          error={errors.required_connectors}
          onChange={(lines) => set("required_connectors", lines)}
        />
        <LinesField
          label="可选的外部系统 (optional_connectors)"
          description={`每行一个连接器标识，最多 ${PROFILE_LIMITS.connectors} 个`}
          value={value.optional_connectors}
          disabled={disabled}
          error={errors.optional_connectors}
          onChange={(lines) => set("optional_connectors", lines)}
        />
        <LinesField
          label="推荐知识 (recommended_knowledge)"
          description="每行一个类别，例如「产品手册」；不是具体知识库"
          value={value.recommended_knowledge}
          disabled={disabled}
          error={errors.recommended_knowledge}
          onChange={(lines) => set("recommended_knowledge", lines)}
        />
      </FormLayout>

      <VStack gap={2}>
        <Text type="supporting" color="secondary">需要的权限 (required_permissions)；都不勾选表示无需额外权限</Text>
        <CheckboxInput
          label="需要完全访问"
          value={permissions.full_access}
          onChange={(full_access) => set("required_permissions", { ...permissions, full_access })}
          isDisabled={disabled}
        />
        <CheckboxInput
          label="需要本机目录"
          value={permissions.local_directories}
          onChange={(local_directories) => set("required_permissions", { ...permissions, local_directories })}
          isDisabled={disabled}
        />
      </VStack>

      <FormLayout direction="horizontal">
        <Selector
          label="计价方式 (pricing)"
          options={PRICING_OPTIONS}
          value={value.pricing?.mode ?? NO_PRICING}
          onChange={(mode) => set("pricing", mode === NO_PRICING ? null : { mode: mode as PricingMode, unit_price: value.pricing?.unit_price ?? "", currency: "USD" })}
          isDisabled={disabled}
          data-testid="pricing-mode-select"
        />
        {value.pricing?.mode === "subscription" && (
          <Selector
            label="套餐周期 (billing_period)"
            options={BILLING_PERIOD_OPTIONS}
            value={value.pricing.billing_period ?? ""}
            placeholder="请选择"
            onChange={(period) => value.pricing && set("pricing", { ...value.pricing, billing_period: period as BillingPeriod })}
            isDisabled={disabled}
            status={errorStatus(errors.billing_period)}
            data-testid="billing-period-select"
          />
        )}
        <TextInput
          label="参考单价 (USD)"
          description={value.pricing ? UNIT_PRICE_HINTS[value.pricing.mode] : "先选择计价方式"}
          value={value.pricing?.unit_price ?? ""}
          onChange={(unit_price) => value.pricing && set("pricing", { ...value.pricing, unit_price })}
          isDisabled={disabled || !value.pricing}
          status={errorStatus(errors.pricing)}
        />
      </FormLayout>

      <FormLayout>
        <TextArea
          label="记忆策略说明 (memory_policy_summary)"
          description={`≤${PROFILE_LIMITS.memoryPolicySummary} 字，例如是否保存对话记忆`}
          value={value.memory_policy_summary}
          onChange={(memory_policy_summary) => set("memory_policy_summary", memory_policy_summary)}
          rows={2}
          maxLength={PROFILE_LIMITS.memoryPolicySummary}
          isOptional
          isDisabled={disabled}
          status={errorStatus(errors.memory_policy_summary)}
        />
        <TextInput
          label="发布者 (publisher)"
          description={`≤${PROFILE_LIMITS.publisher} 字`}
          value={value.publisher}
          onChange={(publisher) => set("publisher", publisher)}
          isOptional
          isDisabled={disabled}
          status={errorStatus(errors.publisher)}
        />
        <TextInput
          label="更新说明链接 (changelog_url)"
          description="仅支持 http/https"
          value={value.changelog_url}
          onChange={(changelog_url) => set("changelog_url", changelog_url)}
          isOptional
          isDisabled={disabled}
          status={errorStatus(errors.changelog_url)}
        />
      </FormLayout>
    </VStack>
  );
}
