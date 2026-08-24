import { FormLayout } from "@astryxdesign/core/FormLayout";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";

export interface ExpertTemplateFieldsProps {
  avatarUrl: string;
  systemPrompt: string;
  defaultModel: string;
  description: string;
  disabled: boolean;
  systemPromptError?: string;
  defaultModelError?: string;
  descriptionError?: string;
  onAvatarUrlChange: (value: string) => void;
  onSystemPromptChange: (value: string) => void;
  onDefaultModelChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
}

export function ExpertTemplateFields({
  avatarUrl,
  systemPrompt,
  defaultModel,
  description,
  disabled,
  systemPromptError,
  defaultModelError,
  descriptionError,
  onAvatarUrlChange,
  onSystemPromptChange,
  onDefaultModelChange,
  onDescriptionChange,
}: ExpertTemplateFieldsProps) {
  return (
    <FormLayout>
      <TextInput
        label="头像 (avatar_url)"
        value={avatarUrl}
        onChange={onAvatarUrlChange}
        placeholder="https://..."
        isOptional
        isDisabled={disabled}
      />
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
      <TextInput
        label="默认模型 (default_model)"
        value={defaultModel}
        onChange={onDefaultModelChange}
        placeholder="如 gpt-5 / claude-opus-4-8 / deepseek"
        isRequired
        isDisabled={disabled}
        status={defaultModelError ? { type: "error", message: defaultModelError } : undefined}
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
