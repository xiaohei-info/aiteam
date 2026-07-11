import { Collapsible } from "@astryxdesign/core/Collapsible";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";

export interface SolutionTemplateFieldsProps {
  description: string;
  icon: string;
  knowledgeRefsText: string;
  skillRefsText: string;
  plannerPrompt: string;
  subtaskPrompt: string;
  aggregatePrompt: string;
  defaultGrantsText: string;
  tagsText: string;
  isAdvancedOpen: boolean;
  disabled: boolean;
  plannerPromptError?: string;
  defaultGrantsError?: string;
  onDescriptionChange: (value: string) => void;
  onIconChange: (value: string) => void;
  onKnowledgeRefsChange: (value: string) => void;
  onSkillRefsChange: (value: string) => void;
  onPlannerPromptChange: (value: string) => void;
  onSubtaskPromptChange: (value: string) => void;
  onAggregatePromptChange: (value: string) => void;
  onDefaultGrantsChange: (value: string) => void;
  onTagsChange: (value: string) => void;
  onAdvancedOpenChange: (isOpen: boolean) => void;
}

export function SolutionTemplateFields({
  description,
  icon,
  knowledgeRefsText,
  skillRefsText,
  plannerPrompt,
  subtaskPrompt,
  aggregatePrompt,
  defaultGrantsText,
  tagsText,
  isAdvancedOpen,
  disabled,
  plannerPromptError,
  defaultGrantsError,
  onDescriptionChange,
  onIconChange,
  onKnowledgeRefsChange,
  onSkillRefsChange,
  onPlannerPromptChange,
  onSubtaskPromptChange,
  onAggregatePromptChange,
  onDefaultGrantsChange,
  onTagsChange,
  onAdvancedOpenChange,
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
        label="知识引用 (knowledge_refs, 每行或逗号分隔)"
        value={knowledgeRefsText}
        onChange={onKnowledgeRefsChange}
        placeholder={"kb_orders\nkb_finance"}
        rows={3}
        isDisabled={disabled}
      />
      <TextArea
        label="技能引用 (skill_refs, 每行或逗号分隔)"
        value={skillRefsText}
        onChange={onSkillRefsChange}
        placeholder={"skill_a\nskill_b"}
        rows={3}
        isDisabled={disabled}
      />
      <TextArea
        label="Planner 编排规则提示词 (planner_prompt, 必填)"
        value={plannerPrompt}
        onChange={onPlannerPromptChange}
        placeholder="方案级协作编排规则：planner 阶段 prompt。"
        rows={5}
        isRequired
        isDisabled={disabled}
        status={plannerPromptError ? { type: "error", message: plannerPromptError } : undefined}
      />
      <Collapsible
        trigger="高级配置（Subtask、Aggregate、Grants、Tags）"
        isOpen={isAdvancedOpen}
        onOpenChange={onAdvancedOpenChange}
      >
        <FormLayout>
          <TextArea label="Subtask Prompt" value={subtaskPrompt} onChange={onSubtaskPromptChange} rows={4} isDisabled={disabled} />
          <TextArea label="Aggregate Prompt" value={aggregatePrompt} onChange={onAggregatePromptChange} rows={4} isDisabled={disabled} />
          <TextArea
            label="默认 Grants (JSON)"
            value={defaultGrantsText}
            onChange={onDefaultGrantsChange}
            placeholder='{"max_concurrent_tasks": 5}'
            rows={4}
            isDisabled={disabled}
            status={defaultGrantsError ? { type: "error", message: defaultGrantsError } : undefined}
          />
          <TextArea label="方案标签 (每行或逗号分隔)" value={tagsText} onChange={onTagsChange} rows={3} isDisabled={disabled} />
        </FormLayout>
      </Collapsible>
    </FormLayout>
  );
}
