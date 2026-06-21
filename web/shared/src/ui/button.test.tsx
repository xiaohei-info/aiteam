import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./button.js";

describe("Button", () => {
  it("默认 metal 变体可点击并触发 onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>发送</Button>);
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("disabled 时不触发 onClick", async () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>发送</Button>);
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("danger 变体带对应类", () => {
    render(<Button variant="danger">删除</Button>);
    expect(screen.getByRole("button").className).toContain("bg-danger");
  });
});
