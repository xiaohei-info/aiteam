/**
 * W-A.3 群聊专家 roster 展示（#68 / 06 §7.6）。
 *
 * 本会话显示固定 participant Session 的 stable handle，点击 handle 自动填入输入框。
 * 数据来自 Agent owner-scoped participant projection，不在此组件创建或持久化 roster。
 *
 * 不调任何端点（roster 由父组件加载）。展示态不入持久化主状态（D6）。
 */

import { DigitalEmployeeAvatar } from "@aiteam/shared";
import type { GroupExpert } from "./useGroupApi";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";

export interface GroupExpertRosterProps {
  experts: GroupExpert[];
  /** 点击某专家 handle 回调（父组件把 "@handle " 填入输入框）。 */
  onPickHandle?: (handle: string) => void;
}

export function GroupExpertRoster({ experts, onPickHandle }: GroupExpertRosterProps) {
  if (experts.length === 0) {
    return (
      <HStack gap={1} align="center" role="group" aria-label="本会话专家">
        <Text type="label">专家（0）</Text>
        <Text type="supporting">本会话暂无固定成员</Text>
      </HStack>
    );
  }

  return (
    <HStack gap={1} align="center" wrap="wrap" role="group" aria-label="本会话专家">
      <Text type="label">专家（{experts.length}）· @提及触发</Text>
      <HStack gap={1} wrap="wrap">
        {experts.map((expert) => {
          const name = expert.display_name || expert.handle || expert.employee_id || "群成员";
          const mentionable = Boolean(expert.handle && expert.available !== false);
          return (
            <HStack key={expert.employee_id || expert.handle || name} gap={1} align="center">
              <DigitalEmployeeAvatar name={name} seed={expert.employee_id || expert.handle || name} src={expert.avatar_url} size={28} />
              <Button
                label={mentionable ? `@${name}` : `${name}（当前不可用）`}
                variant="secondary"
                size="sm"
                onClick={() => mentionable && onPickHandle?.(expert.handle!)}
                isDisabled={!mentionable}
                aria-label={mentionable ? `@提及 ${name}` : `${name}当前不可用`}
              />
              {expert.role_title && <Text type="supporting">{expert.role_title}</Text>}
              {expert.available === false && <Text type="supporting">不可用</Text>}
              {expert.model && <Text type="supporting">{expert.model}</Text>}
            </HStack>
          );
        })}
      </HStack>
    </HStack>
  );
}
