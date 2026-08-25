import { FormLayout } from "@astryxdesign/core/FormLayout";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";

export interface SolutionTemplateFieldsProps {
  description: string;
  icon: string;
  coordinatorInstructions: string;
  tagsText: string;
  disabled: boolean;
  onDescriptionChange: (value: string) => void;
  onIconChange: (value: string) => void;
  onCoordinatorInstructionsChange: (value: string) => void;
  onTagsChange: (value: string) => void;
}

export function SolutionTemplateFields({
  description,
  icon,
  coordinatorInstructions,
  tagsText,
  disabled,
  onDescriptionChange,
  onIconChange,
  onCoordinatorInstructionsChange,
  onTagsChange,
}: SolutionTemplateFieldsProps) {
  return (
    <FormLayout>
      <TextArea
        label="描述 (description)"
        value={description}
        onChange={onDescriptionChange}
        placeholder="方案描述"
        rows={4}
        isDisabled={disabled}
      />
      <TextInput
        label="图标 (icon)"
        value={icon}
        onChange={onIconChange}
        placeholder="图标 URL 或标识"
        isDisabled={disabled}
      />
      <TextArea
        label="协作说明 (coordinator_instructions)"
        value={coordinatorInstructions}
        onChange={onCoordinatorInstructionsChange}
        placeholder="可选：说明团队目标、分工原则和预期交付物；不需要编写执行步骤。"
        rows={5}
        isDisabled={disabled}
      />
      <TextArea
        label="方案标签 (每行或逗号分隔)"
        value={tagsText}
        onChange={onTagsChange}
        placeholder="零售\n经营分析"
        rows={3}
        isDisabled={disabled}
      />
    </FormLayout>
  );
}
