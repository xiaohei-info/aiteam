/** 招募 / 应用方案里的模型下拉：只有一个可用模型时自动选中，没有可用模型时给出明确提示。 */
import { useEffect, type ReactNode } from "react";
import { Selector } from "@astryxdesign/core/Selector";
import type { ModelChoice } from "./useRecruitModels";

export interface ModelPickerProps {
  label: string;
  choices: ModelChoice[];
  loading: boolean;
  /** 当前选中的 ModelChoice.key。 */
  value: string | undefined;
  onChange: (key: string | undefined) => void;
  isDisabled?: boolean;
  /** 校验失败时在下拉旁显示。 */
  errorText?: string;
  testId?: string;
  /** 只有一个可选项时自动选中（默认开启）。 */
  autoPickSingle?: boolean;
  /** 默认必填；已招募专家的"保持当前模型"选项传 false。 */
  isRequired?: boolean;
  placeholder?: string;
}

export function ModelPicker({
  label, choices, loading, value, onChange, isDisabled, errorText, testId, autoPickSingle = true,
  isRequired = true, placeholder,
}: ModelPickerProps): ReactNode {
  const only = choices.length === 1 ? choices[0] : undefined;
  useEffect(() => {
    if (autoPickSingle && only && value === undefined) onChange(only.key);
  }, [autoPickSingle, only, value, onChange]);

  return (
    <Selector
      label={label}
      options={choices.map((choice) => ({ value: choice.key, label: choice.label }))}
      value={choices.some((choice) => choice.key === value) ? value : undefined}
      placeholder={!loading && choices.length === 0 ? "暂无可用模型，请联系平台运营开通" : (placeholder ?? "请选择模型")}
      isDisabled={isDisabled || loading || choices.length === 0}
      isLoading={loading}
      isRequired={isRequired}
      status={errorText ? { type: "error", message: errorText } : undefined}
      data-testid={testId}
      onChange={(next) => onChange(next as string | undefined)}
    />
  );
}
