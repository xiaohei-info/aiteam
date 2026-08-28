import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Selector } from "@astryxdesign/core/Selector";
import { VStack } from "@astryxdesign/core/VStack";
import type { CatalogItem } from "../types";

export interface TeamMemberSelectorProps {
  options: CatalogItem[];
  selectedIds: string[];
  coordinatorTemplateId: string;
  disabled: boolean;
  selectionError?: string;
  coordinatorError?: string;
  onSelectionChange: (ids: string[]) => void;
  onCoordinatorChange: (templateId: string) => void;
}

export function TeamMemberSelector({
  options,
  selectedIds,
  coordinatorTemplateId,
  disabled,
  selectionError,
  coordinatorError,
  onSelectionChange,
  onCoordinatorChange,
}: TeamMemberSelectorProps) {
  const selected = selectedIds
    .map((templateId) => options.find((option) => option.template_id === templateId))
    .filter((option): option is CatalogItem => Boolean(option));

  return (
    <VStack gap={4}>
      <MultiSelector
        label="配置专家团队"
        description="选择参与方案协作的专家模板"
        options={options.map((option) => ({
          value: option.template_id,
          label: `${option.display_name} #${option.template_id}`,
        }))}
        value={selectedIds}
        onChange={onSelectionChange}
        placeholder="选择专家模板"
        triggerDisplay="labels"
        isDisabled={disabled}
        status={selectionError ? { type: "error", message: selectionError } : undefined}
      />
      {selected.length > 0 && (
        <Selector
          label="协调专家"
          value={coordinatorTemplateId || undefined}
          onChange={onCoordinatorChange}
          options={selected.map((member) => ({
            value: member.template_id,
            label: member.display_name,
          }))}
          placeholder="选择负责协调群聊的专家"
          isDisabled={disabled}
          status={coordinatorError ? { type: "error", message: coordinatorError } : undefined}
        />
      )}
    </VStack>
  );
}
