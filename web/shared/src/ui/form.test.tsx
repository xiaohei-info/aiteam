import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Input } from "./input.js";
import { Select } from "./select.js";
import { Field } from "./field.js";
import { Table } from "./table.js";

describe("Input", () => {
  it("透传属性并合并 className", () => {
    render(<Input placeholder="账号" className="extra" />);
    const el = screen.getByPlaceholderText("账号");
    expect(el.tagName).toBe("INPUT");
    expect(el.className).toContain("extra");
    expect(el.className).toContain("border-gold/20");
  });
});

describe("Select", () => {
  it("保留原生 multiple 与 option 语义", () => {
    render(
      <Select multiple aria-label="成员">
        <option value="m1">张三</option>
      </Select>,
    );
    const el = screen.getByLabelText("成员") as HTMLSelectElement;
    expect(el.tagName).toBe("SELECT");
    expect(el.multiple).toBe(true);
  });
});

describe("Field", () => {
  it("label 包裹控件，getByLabelText 可关联", () => {
    render(
      <Field label="账号（手机号）">
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText("账号（手机号）").tagName).toBe("INPUT");
  });
});

describe("Table", () => {
  it("渲染 children 并合并 className", () => {
    render(
      <Table className="extra">
        <tbody>
          <tr data-testid="row">
            <td>cell</td>
          </tr>
        </tbody>
      </Table>,
    );
    expect(screen.getByTestId("row")).toBeInTheDocument();
    expect(screen.getByText("cell").closest("table")!.className).toContain("extra");
  });
});
