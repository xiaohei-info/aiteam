import { Collapsible } from "@astryxdesign/core/Collapsible";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { TextArea } from "@astryxdesign/core/TextArea";

export interface RuntimeConfigFieldsProps {
  skillIdsText: string;
  tagsText: string;
  initialMemoriesText: string;
  sortOrder: number | null;
  isOpen: boolean;
  disabled: boolean;
  initialMemoriesError?: string;
  onSkillIdsChange: (value: string) => void;
  onTagsChange: (value: string) => void;
  onInitialMemoriesChange: (value: string) => void;
  onSortOrderChange: (value: number | null) => void;
  onOpenChange: (isOpen: boolean) => void;
}

export function RuntimeConfigFields({
  skillIdsText,
  tagsText,
  initialMemoriesText,
  sortOrder,
  isOpen,
  disabled,
  initialMemoriesError,
  onSkillIdsChange,
  onTagsChange,
  onInitialMemoriesChange,
  onSortOrderChange,
  onOpenChange,
}: RuntimeConfigFieldsProps) {
  return (
    <Collapsible
      trigger="能力配置（技能、标签、记忆、排序）"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
    >
      <FormLayout>
        <TextArea
          label="预配置技能 (skill_ids, 每行或逗号分隔)"
          value={skillIdsText}
          onChange={onSkillIdsChange}
          placeholder={"skill_a\nskill_b"}
          rows={4}
          isDisabled={disabled}
        />
        <TextArea
          label="搜索标签 (tags, 每行或逗号分隔)"
          value={tagsText}
          onChange={onTagsChange}
          placeholder={"营销\n电商"}
          rows={4}
          isDisabled={disabled}
        />
        <TextArea
          label="预置记忆 (initial_memories, JSON 数组)"
          value={initialMemoriesText}
          onChange={onInitialMemoriesChange}
          placeholder={'[{"role":"user","content":"偏好 Slack"}]'}
          rows={4}
          isDisabled={disabled}
          status={initialMemoriesError ? { type: "error", message: initialMemoriesError } : undefined}
        />
        <NumberInput
          label="排序权重 (sort_order, 数值越小越靠前)"
          value={sortOrder}
          onChange={onSortOrderChange}
          hasClear
          placeholder="0"
          isIntegerOnly
          isDisabled={disabled}
        />
      </FormLayout>
    </Collapsible>
  );
}
