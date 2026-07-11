import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Selector } from "@astryxdesign/core/Selector";
import { Table, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { VStack } from "@astryxdesign/core/VStack";
import type { CatalogItem } from "../types";

type TeamMemberRow = CatalogItem & Record<string, unknown>;

export interface TeamMemberSelectorProps {
  options: CatalogItem[];
  selectedIds: string[];
  plannerTemplateId: string;
  disabled: boolean;
  selectionError?: string;
  plannerError?: string;
  onSelectionChange: (ids: string[]) => void;
  onPlannerChange: (templateId: string) => void;
}

export function TeamMemberSelector({
  options,
  selectedIds,
  plannerTemplateId,
  disabled,
  selectionError,
  plannerError,
  onSelectionChange,
  onPlannerChange,
}: TeamMemberSelectorProps) {
  const selected = selectedIds
    .map((templateId) => options.find((option) => option.template_id === templateId))
    .filter((option): option is CatalogItem => Boolean(option));

  const columns: TableColumn<TeamMemberRow>[] = [
    { key: "display_name", header: "专家", width: proportional(2) },
    { key: "template_id", header: "模板 ID", width: proportional(2) },
    {
      key: "planner",
      header: "Planner",
      width: proportional(1),
      renderCell: (member) => (
        <CheckboxInput
          label={`设 ${member.display_name} 为 Planner`}
          value={plannerTemplateId === member.template_id}
          onChange={(checked) => {
            if (checked) onPlannerChange(member.template_id);
          }}
          isDisabled={disabled}
        />
      ),
    },
  ];

  return (
    <VStack gap={4}>
      <MultiSelector
        label="配置专家模板"
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
        <>
          <Selector
            label="Planner"
            value={plannerTemplateId || undefined}
            onChange={onPlannerChange}
            options={selected.map((member) => ({
              value: member.template_id,
              label: member.display_name,
            }))}
            placeholder="选择 Planner"
            isDisabled={disabled}
            status={plannerError ? { type: "error", message: plannerError } : undefined}
          />
          <Table
            aria-label="已选专家"
            tableProps={{ "aria-label": "已选专家" }}
            data={selected as TeamMemberRow[]}
            columns={columns}
            idKey="template_id"
          />
        </>
      )}
    </VStack>
  );
}
