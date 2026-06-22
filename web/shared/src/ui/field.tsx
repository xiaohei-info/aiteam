import { type ReactNode } from "react";
import { cn } from "./cn.js";

export interface FieldProps {
  /** 字段标签文本；同时是控件的可访问名（label 包裹控件，getByLabelText 据此关联）。 */
  label: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * 表单字段：`<label>` 包裹标签与控件，保证可访问名与 getByLabelText 关联。
 * 表现统一在此收口，消除各表单各写 fieldCls 的重复。
 */
export function Field({ label, className, children }: FieldProps): ReactNode {
  return (
    <label className={cn("flex flex-col gap-xs", className)}>
      <span className="text-xs text-text-secondary">{label}</span>
      {children}
    </label>
  );
}
