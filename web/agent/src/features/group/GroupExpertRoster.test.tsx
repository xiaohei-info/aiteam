import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GroupExpertRoster } from "./GroupExpertRoster";

function expert(overrides: Partial<Parameters<typeof GroupExpertRoster>[0]["experts"][number]> = {}) {
  return {
    employee_id: "employee-1",
    handle: "alice",
    display_name: "Alice",
    avatar_url: null,
    role_title: null,
    model: null,
    available: true,
    ...overrides,
  };
}

describe("GroupExpertRoster", () => {
  it("renders the empty roster state", () => {
    render(<GroupExpertRoster experts={[]} />);

    expect(screen.getByRole("group", { name: "本会话专家" })).toHaveTextContent("专家（0）");
    expect(screen.getByText("本会话暂无固定成员")).toBeInTheDocument();
  });

  it("renders available members and emits a handle pick", () => {
    const onPickHandle = vi.fn();
    render(
      <GroupExpertRoster
        experts={[expert({ role_title: "研究员", model: "gpt-5.6" })]}
        onPickHandle={onPickHandle}
      />,
    );

    expect(screen.getByText("专家（1）· @提及触发")).toBeInTheDocument();
    expect(screen.getByText("研究员")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "@提及 Alice" }));
    expect(onPickHandle).toHaveBeenCalledWith("alice");
  });

  it("disables unavailable or handle-less members", () => {
    const onPickHandle = vi.fn();
    render(
      <GroupExpertRoster
        experts={[
          expert({ employee_id: "employee-2", handle: null, display_name: "No handle" }),
          expert({ employee_id: "employee-3", handle: "bob", display_name: "Bob", available: false }),
        ]}
        onPickHandle={onPickHandle}
      />,
    );

    expect(screen.getByRole("button", { name: "No handle当前不可用" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bob当前不可用" })).toBeDisabled();
    expect(screen.getByText("不可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bob当前不可用" }));
    expect(onPickHandle).not.toHaveBeenCalled();
  });
});
