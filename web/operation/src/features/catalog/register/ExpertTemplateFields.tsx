import { FormLayout } from "@astryxdesign/core/FormLayout";
import { TextArea } from "@astryxdesign/core/TextArea";
import { AvatarFileInput } from "../AvatarFileInput";

export interface ExpertTemplateFieldsProps {
  avatarUrl: string;
  systemPrompt: string;
  description: string;
  disabled: boolean;
  systemPromptError?: string;
  descriptionError?: string;
  onAvatarUrlChange: (value: string) => void;
  onSystemPromptChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
}

export function ExpertTemplateFields({
  avatarUrl,
  systemPrompt,
  description,
  disabled,
  systemPromptError,
  descriptionError,
  onAvatarUrlChange,
  onSystemPromptChange,
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
