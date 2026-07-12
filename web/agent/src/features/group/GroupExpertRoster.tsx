/**
 * W-A.3 群聊专家 roster 展示（#68 / 06 §7.6）。
 *
 * 黑金玻璃质感。演示用途：本会话已装载专家的 handle 列表，点击 handle 自动填入输入框。
 * 真实来源是 pull 装载的 employee 快照（留详设），本卡按演示用 mock roster 持有。
 *
 * 不调任何端点（roster 是前端持有的演示态，不落库、不上传）。展示态不入持久化主状态（D6）。
 */

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
        <Text type="supporting">本会话暂无已装载专家</Text>
      </HStack>
    );
  }

  return (
    <HStack gap={1} align="center" wrap="wrap" role="group" aria-label="本会话专家">
      <Text type="label">专家（{experts.length}）· @提及触发</Text>
      <HStack gap={1} wrap="wrap">
        {experts.map((expert) => (
          <HStack key={expert.handle} gap={1} align="center">
            <Button
              label={`@${expert.display_name || expert.handle}`}
              variant="secondary"
              size="sm"
              onClick={() => onPickHandle?.(expert.handle)}
              aria-label={`@提及 ${expert.display_name || expert.handle}`}
            />
            {expert.model && <Text type="supporting">{expert.model}</Text>}
          </HStack>
        ))}
      </HStack>
    </HStack>
  );
}
