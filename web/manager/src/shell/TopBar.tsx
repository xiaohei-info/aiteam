/** 顶栏：左侧显示企业名称（未设置时回退企业代码），右侧账号菜单。 */
import type { ReactNode } from "react";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { Text } from "@astryxdesign/core/Text";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import type { Me } from "./useMe";

export function enterpriseLabel(me: Me | null): string {
  return me?.enterprise_name || me?.enterprise_code || "企业端";
}

interface TopBarProps {
  me: Me | null;
  onSignOut: () => void;
  /** 有本地密码的账号才显示"设置新密码"。 */
  onChangePassword?: () => void;
  /** 管理员且企业名未设置时，引导去设置。 */
  onSetEnterpriseName?: () => void;
}

export function TopBar({ me, onSignOut, onChangePassword, onSetEnterpriseName }: TopBarProps): ReactNode {
  const showSetName = Boolean(onSetEnterpriseName) && me !== null && !me.enterprise_name;
  return (
    <TopNav
      label="企业端顶栏"
      heading={<TopNavHeading heading={enterpriseLabel(me)} />}
      startContent={showSetName ? (
        <Text color="secondary">尚未设置企业名称</Text>
      ) : undefined}
      endContent={(
        <DropdownMenu
          button={{ label: me?.account_masked || "账号", variant: "ghost", size: "sm" }}
          data-testid="account-menu"
          menuWidth={200}
        >
          {showSetName && <DropdownMenuItem label="去设置企业名称" onClick={onSetEnterpriseName} />}
          {me?.has_password && onChangePassword && <DropdownMenuItem label="设置新密码" onClick={onChangePassword} />}
          <DropdownMenuItem label="退出登录" onClick={onSignOut} />
        </DropdownMenu>
      )}
    />
  );
}
