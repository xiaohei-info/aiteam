import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TopBar, enterpriseLabel } from "../TopBar";
import type { Me } from "../useMe";

const policy = { min_length: 8, require_upper: true, require_lower: true, require_digit: true, require_symbol: true, max_age_days: 90 };
function me(over: Partial<Me> = {}): Me {
  return {
    enterprise_name: "星河科技", enterprise_code: "acme", account_masked: "138****5678",
    roles: ["member"], has_password: true, password_policy: policy, ...over,
  };
}

describe("enterpriseLabel", () => {
  it("优先企业名，其次企业代码，最后兜底", () => {
    expect(enterpriseLabel(me())).toBe("星河科技");
    expect(enterpriseLabel(me({ enterprise_name: null }))).toBe("acme");
    expect(enterpriseLabel(me({ enterprise_name: null, enterprise_code: null }))).toBe("企业端");
    expect(enterpriseLabel(null)).toBe("企业端");
  });
});

describe("TopBar", () => {
  it("顶栏显示企业名和脱敏账号", () => {
    render(<TopBar me={me()} onSignOut={() => {}} />);
    expect(screen.getByText("星河科技")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /138\*\*\*\*5678/ })).toBeInTheDocument();
  });

  it("账号菜单：有密码显示设置新密码，退出登录可用", () => {
    const signOut = vi.fn();
    const change = vi.fn();
    render(<TopBar me={me()} onSignOut={signOut} onChangePassword={change} />);
    fireEvent.click(screen.getByRole("button", { name: /138\*\*\*\*5678/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "设置新密码" }));
    expect(change).toHaveBeenCalled();
  });

  it("仅第三方登录的账号不显示设置新密码", () => {
    render(<TopBar me={me({ has_password: false })} onSignOut={() => {}} onChangePassword={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /138\*\*\*\*5678/ }));
    expect(screen.queryByRole("menuitem", { name: "设置新密码" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "退出登录" })).toBeInTheDocument();
  });

  it("管理员且企业名未设置：提示并给出去设置入口；非管理员不给", () => {
    const toSettings = vi.fn();
    const { unmount } = render(<TopBar me={me({ enterprise_name: null })} onSignOut={() => {}} onSetEnterpriseName={toSettings} />);
    expect(screen.getByText("尚未设置企业名称")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /138\*\*\*\*5678/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "去设置企业名称" }));
    expect(toSettings).toHaveBeenCalled();
    unmount();
    render(<TopBar me={me({ enterprise_name: null })} onSignOut={() => {}} />);
    expect(screen.queryByText("尚未设置企业名称")).not.toBeInTheDocument();
  });

  it("读取失败（me 为空）时仍可退出登录", () => {
    render(<TopBar me={null} onSignOut={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "账号" }));
    expect(screen.getByRole("menuitem", { name: "退出登录" })).toBeInTheDocument();
  });
});
