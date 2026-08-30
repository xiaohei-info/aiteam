import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import type { Department } from "./types";

/** Stable UI-only value for the explicit no-department choice. */
export const UNASSIGNED_DEPARTMENT_ID = "__unassigned__";

export interface DepartmentSelectorProps {
  departments: Department[];
  value: string[];
  onChange: (value: string[]) => void;
  label?: string;
  isDisabled?: boolean;
  isLoading?: boolean;
  dataTestId?: string;
}

/**
 * Department assignment selector. The sentinel is never returned to callers:
 * an explicit “未设置” choice is represented by an empty department_ids list.
 */
export function DepartmentSelector({
  departments,
  value,
  onChange,
  label = "所属部门",
  isDisabled = false,
  isLoading = false,
  dataTestId,
}: DepartmentSelectorProps) {
  const selected = value.length > 0 ? value : [UNASSIGNED_DEPARTMENT_ID];
  const options = [
    { value: UNASSIGNED_DEPARTMENT_ID, label: "未设置" },
    ...departments.map((department) => ({ value: department.id, label: department.display_name || "未命名部门" })),
  ];

  function handleChange(next: string[]): void {
    if (!next.includes(UNASSIGNED_DEPARTMENT_ID)) {
      onChange(next);
      return;
    }
    // The sentinel behaves as an exclusive choice. Selecting a real department
    // while it is selected removes the sentinel; selecting it afterwards clears
    // all real departments.
    onChange(value.length === 0 ? next.filter((id) => id !== UNASSIGNED_DEPARTMENT_ID) : []);
  }

  return (
    <MultiSelector
      label={label}
      description="可选择一个或多个部门；不归属部门请选择“未设置”。"
      options={options}
      value={selected}
      onChange={handleChange}
      triggerDisplay="labels"
      isDisabled={isDisabled}
      isLoading={isLoading}
      data-testid={dataTestId}
    />
  );
}
