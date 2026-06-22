import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "./cn.js";

/** 黑金风格文本输入。表现与逻辑分离：只挂类 + 透传，受控状态由调用方持有。 */
const inputCls =
  "rounded-md border border-gold/20 bg-surface px-md py-sm text-sm text-text-primary " +
  "outline-none transition placeholder:text-text-muted " +
  "focus:border-gold/50 focus:ring-2 focus:ring-gold disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(inputCls, className)} {...rest} />;
  },
);
