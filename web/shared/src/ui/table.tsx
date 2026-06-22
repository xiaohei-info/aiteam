import { forwardRef, type TableHTMLAttributes } from "react";
import { cn } from "./cn.js";

/**
 * 黑金风格表格原语：只样式化 `<table>`，th/td/行 hover 用描述符变体统一收口，
 * 调用方照常写语义化 thead/tbody/tr/th/td（保留 colSpan、data-testid 等原生能力）。
 */
const tableCls =
  "w-full border-collapse text-sm " +
  "[&_th]:px-md [&_th]:py-sm [&_th]:text-left [&_th]:font-semibold [&_th]:text-text-secondary " +
  "[&_td]:px-md [&_td]:py-sm [&_td]:text-text-primary [&_td]:border-t [&_td]:border-gold/10 " +
  "[&_tbody_tr:hover]:bg-surface-raised/40";

export const Table = forwardRef<HTMLTableElement, TableHTMLAttributes<HTMLTableElement>>(
  function Table({ className, ...rest }, ref) {
    return <table ref={ref} className={cn(tableCls, className)} {...rest} />;
  },
);
