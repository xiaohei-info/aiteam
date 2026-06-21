import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "./cn.js";

type Variant = "metal" | "ghost" | "danger";
type Size = "sm" | "md";

const base =
  "inline-flex items-center justify-center font-semibold rounded-md transition " +
  "disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-gold";

const variants: Record<Variant, string> = {
  metal:
    "text-bg-canvas bg-gradient-to-br from-gold-bright via-gold to-gold-deep " +
    "shadow-[inset_0_1px_1px_rgba(255,255,255,0.5),0_6px_16px_rgba(196,150,60,0.3)]",
  ghost: "text-text-secondary hover:text-text-primary hover:bg-surface-raised",
  danger: "text-bg-canvas bg-danger hover:brightness-110",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-5 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** 渲染为子元素（如包裹链接），借 Radix Slot 合并属性。 */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "metal", size = "md", asChild = false, className, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  return <Comp ref={ref} className={cn(base, variants[variant], sizes[size], className)} {...rest} />;
});
