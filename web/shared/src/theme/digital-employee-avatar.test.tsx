import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DigitalEmployeeAvatar } from "./digital-employee-avatar.js";

describe("DigitalEmployeeAvatar", () => {
  it("uses a stable seed while producing varied illustrated identities", () => {
    const { container } = render(
      <>
        <DigitalEmployeeAvatar name="Alice" />
        <DigitalEmployeeAvatar name="Alice" />
        <DigitalEmployeeAvatar name="Bob" />
        <DigitalEmployeeAvatar name="Carol" />
      </>,
    );
    const avatars = [...container.querySelectorAll<HTMLElement>('[data-aiteam-avatar="true"]')];
    const styles = avatars.map((avatar) => avatar.dataset.aiteamAvatarStyle);

    expect(styles[0]).toBe(styles[1]);
    expect(new Set(styles).size).toBeGreaterThan(1);
    expect(avatars.every((avatar) => avatar.querySelector("svg"))).toBe(true);
  });

  it("allows an explicit seed to distinguish duplicate display names", () => {
    const { container } = render(
      <>
        <DigitalEmployeeAvatar name="同名员工" seed="employee-a" />
        <DigitalEmployeeAvatar name="同名员工" seed="employee-b" />
      </>,
    );
    const styles = [...container.querySelectorAll<HTMLElement>('[data-aiteam-avatar="true"]')]
      .map((avatar) => avatar.dataset.aiteamAvatarStyle);

    expect(styles[0]).not.toBe(styles[1]);
  });

  it("rejects external images and keeps same-origin images opt-in", () => {
    const { container: external } = render(<DigitalEmployeeAvatar name="外部头像" src="https://example.com/avatar.png" />);
    expect(external.querySelector("img")).toBeNull();
    expect(external.querySelector("svg")).toBeTruthy();

    const { container: local } = render(<DigitalEmployeeAvatar name="本地头像" src="/avatars/avatar.png" />);
    expect(local.querySelector("img")).toHaveAttribute("src", "/avatars/avatar.png");
    expect(local.querySelector("svg")).toBeNull();

    const inline = "data:image/png;base64,iVBORw0KGgo=";
    const { container: uploaded } = render(<DigitalEmployeeAvatar name="上传头像" src={inline} />);
    expect(uploaded.querySelector("img")).toHaveAttribute("src", inline);
    expect(uploaded.querySelector("svg")).toBeNull();
  });
});
