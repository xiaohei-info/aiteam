import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./app-shell.js";

const nav = [
  { id: "a", label: "工作台", path: "/workspace", active: true },
  { id: "b", label: "私聊", path: "/chat", active: false },
];

function renderShell() {
  return render(
    <AppShell
      brand={<span>AI Team</span>}
      nav={nav}
      renderLink={(item, className) => (
        <a href={item.path} className={className} data-testid={`nav-${item.id}`}>
          {item.label}
        </a>
      )}
    >
      <div>主区内容</div>
    </AppShell>,
  );
}

describe("AppShell", () => {
  it("渲染品牌、导航项（经 renderLink）与主区", () => {
    renderShell();
    expect(screen.getByText("AI Team")).toBeInTheDocument();
    expect(screen.getByTestId("nav-a")).toHaveTextContent("工作台");
    expect(screen.getByText("主区内容")).toBeInTheDocument();
  });

  it("激活项带激活样式类", () => {
    renderShell();
    expect(screen.getByTestId("nav-a").className).toContain("text-gold");
    expect(screen.getByTestId("nav-b").className).not.toContain("text-gold");
  });

  it("窄屏菜单按钮切换侧栏展开（aria-expanded 翻转）", async () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: /菜单|menu/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("展开后点击遮罩收起侧栏（点击外部关闭闭环）", async () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: /菜单|menu/i });
    await userEvent.click(toggle);
    expect(screen.getByTestId("shell-backdrop")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("shell-backdrop"));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("shell-backdrop")).toBeNull();
  });

  it("点击导航项后收起侧栏（窄屏导航跳转即收起）", async () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: /菜单|menu/i });
    await userEvent.click(toggle);
    await userEvent.click(screen.getByTestId("nav-b"));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
