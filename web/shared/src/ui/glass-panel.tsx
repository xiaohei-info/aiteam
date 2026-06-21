import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "./cn.js";

/**
 * 毛玻璃面板。质感与降级在 design-system 的 `.glass` 基样（@supports 自动退实色），
 * 本组件只负责挂类与透传属性——表现与逻辑分离、可测。
 */
export const GlassPanel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function GlassPanel({ className, ...rest }, ref) {
    return <div ref={ref} className={cn("glass", className)} {...rest} />;
  },
);
