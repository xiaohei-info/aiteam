import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "./cn.js";

/**
 * 黑金风格下拉。刻意保留原生 `<select>`（支持 multiple、option/selected 语义），
 * 仅做样式封装——避免破坏依赖原生多选行为的调用方与测试。
 */
const selectCls =
  "rounded-md border border-gold/20 bg-surface px-md py-sm text-sm text-text-primary " +
  "outline-none transition focus:border-gold/50 focus:ring-2 focus:ring-gold disabled:opacity-50";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return <select ref={ref} className={cn(selectCls, className)} {...rest} />;
  },
);
