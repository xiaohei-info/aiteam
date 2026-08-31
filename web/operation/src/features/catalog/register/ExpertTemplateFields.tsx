import { FormLayout } from "@astryxdesign/core/FormLayout";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Selector } from "@astryxdesign/core/Selector";
import { AvatarFileInput } from "../AvatarFileInput";

export interface ExpertTemplateFieldsProps {
  avatarUrl: string;
  systemPrompt: string;
  defaultModel: string;
  modelOptions: Array<{ value: string; label: string }>;
  defaultThinkingLevel: string;
  thinkingOptions: Array<{ value: string; label: string }>;
  description: string;
  disabled: boolean;
  systemPromptError?: string;
  defaultModelError?: string;
  descriptionError?: string;
  onAvatarUrlChange: (value: string) => void;
  onSystemPromptChange: (value: string) => void;
  onDefaultModelChange: (value: string) => void;
  onDefaultThinkingLevelChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
}

export function ExpertTemplateFields({
  avatarUrl,
  systemPrompt,
  defaultModel,
  modelOptions,
  defaultThinkingLevel,
  thinkingOptions,
  description,
  disabled,
  systemPromptError,
  defaultModelError,
  descriptionError,
  onAvatarUrlChange,
  onSystemPromptChange,
  onDefaultModelChange,
  onDefaultThinkingLevelChange,
  onDescriptionChange,
}: ExpertTemplateFieldsProps) {
  return (
    <FormLayout>
      <AvatarFileInput value={avatarUrl} onChange={onAvatarUrlChange} disabled={disabled} />
      <TextArea
        label="系统提示词 (system_prompt)"
        value={systemPrompt}
        onChange={onSystemPromptChange}
        placeholder="岗位描述系统提示词（纯文本）"
        rows={5}
        isRequired
        isDisabled={disabled}
        status={systemPromptError ? { type: "error", message: systemPromptError } : undefined}
      />
      <Selector
        label="大模型服务 / 模型"
        options={modelOptions}
        value={defaultModel || undefined}
        onChange={onDefaultModelChange}
        placeholder="选择 Operator 已发布模型"
        data-testid="platform-model-select"
        isRequired
        isDisabled={disabled}
        status={defaultModelError ? { type: "error", message: defaultModelError } : undefined}
      />
      <Selector
        label="默认思考等级"
        options={thinkingOptions}
        value={defaultThinkingLevel || undefined}
        onChange={onDefaultThinkingLevelChange}
        placeholder="选择模型默认思考等级"
        data-testid="default-thinking-level-select"
        isRequired
        isDisabled={disabled || !defaultModel || thinkingOptions.length === 0}
      />
      <TextArea
        label="岗位描述 (description, ≤200字)"
        value={description}
        onChange={onDescriptionChange}
        placeholder="用户可见的岗位描述（不超过 200 字）"
        rows={4}
        maxLength={200}
        isRequired
        isDisabled={disabled}
        status={descriptionError ? { type: "error", message: descriptionError } : undefined}
      />
    </FormLayout>
  );
}
