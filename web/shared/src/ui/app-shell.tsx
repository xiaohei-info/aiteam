/**
 * AppShell — 黑金玻璃应用壳（08 §12.2 / page-shell）。
 * 玻璃侧栏（品牌+导航+footer）+ 主区；桌面侧栏常驻，<768px 经菜单按钮收起/展开（overlay）。
 * 表现-only、router-agnostic（链接经 renderLink 注入），三端复用、可测。
 */
import { useState, type ReactNode } from "react";
import { cn } from "./cn.js";

export interface AppShellNavItem {
  id: string;
  label: string;
  path: string;
  active: boolean;
}

export interface AppShellProps {
  brand: ReactNode;
  nav: AppShellNavItem[];
  /** 由消费端注入链接组件（router-agnostic）；className 含激活态样式。 */
  renderLink: (item: AppShellNavItem, className: string) => ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

const itemBase = "block rounded-md px-md py-sm text-sm transition no-underline";
const itemIdle = "text-text-secondary hover:text-text-primary hover:bg-surface-raised";
const itemActive = "text-gold bg-surface-raised";

export function AppShell({ brand, nav, renderLink, footer, children }: AppShellProps): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-screen bg-bg-canvas text-text-primary">
      {/* 窄屏遮罩：展开时点击即收起（点击外部关闭闭环）。 */}
      {open ? (
        <div
          data-testid="shell-backdrop"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
        />
      ) : null}
      <aside
        className={cn(
          "glass z-40 flex w-60 flex-col gap-xs p-md",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:transition-transform",
          open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
        )}
      >
        <div className="mb-md px-xs text-lg font-bold text-gold">{brand}</div>
        {/* 点击任一导航项后在窄屏收起侧栏（事件冒泡）。 */}
        <nav className="flex flex-col gap-xs" onClick={() => setOpen(false)}>
          {nav.map((item) => (
            <span key={item.id}>
              {renderLink(item, cn(itemBase, item.active ? itemActive : itemIdle))}
            </span>
          ))}
        </nav>
        {footer ? <div className="mt-auto pt-md text-sm text-text-muted">{footer}</div> : null}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <button
          type="button"
          aria-label="菜单"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="glass m-sm h-9 w-9 shrink-0 rounded-md text-text-secondary md:hidden"
        >
          <span aria-hidden="true">☰</span>
        </button>
        <main className="min-h-0 flex-1 overflow-auto p-lg">{children}</main>
      </div>
    </div>
  );
}
