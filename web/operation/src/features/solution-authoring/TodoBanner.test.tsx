import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TodoBanner } from "./TodoBanner";
import type { ChecklistRow } from "./workflow";

const row = (key: ChecklistRow["key"], label: string, ok: boolean, anchor: string): ChecklistRow => ({ key, label, ok, reason: "原因说明", anchor });

describe("TodoBanner", () => {
  it("列出未完成事项，点「去处理」滚动到对应分区", () => {
    const target = document.createElement("div");
    target.id = "section-team";
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);
    render(<TodoBanner rows={[row("findings", "敏感项已全部处理", true, "section-findings"), row("orchestration", "群主与编排规则已确认", false, "section-team")]} />);
    expect(screen.getByText("还有 1 件事需要你处理，完成后才能提交审核")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "去处理：群主与编排规则已确认" }));
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    target.remove();
  });
  it("全部满足时给出可以提交的提示", () => {
    render(<TodoBanner rows={[row("findings", "敏感项已全部处理", true, "section-findings")]} />);
    expect(screen.getByText(/都已满足，可以在右侧/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
