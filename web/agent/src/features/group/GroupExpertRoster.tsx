/**
 * W-A.3 群聊专家 roster 展示（#68 / 06 §7.6）。
 *
 * 黑金玻璃质感。演示用途：本会话已装载专家的 handle 列表，点击 handle 自动填入输入框。
 * 真实来源是 pull 装载的 employee 快照（留详设），本卡按演示用 mock roster 持有。
 *
 * 不调任何端点（roster 是前端持有的演示态，不落库、不上传）。展示态不入持久化主状态（D6）。
 */

import type { GroupExpert } from "./useGroupApi";

export interface GroupExpertRosterProps {
  experts: GroupExpert[];
  /** 点击某专家 handle 回调（父组件把 "@handle " 填入输入框）。 */
  onPickHandle?: (handle: string) => void;
}

export function GroupExpertRoster({ experts, onPickHandle }: GroupExpertRosterProps) {
  if (experts.length === 0) {
    return (
      <div className="flex items-center gap-sm" aria-label="本会话专家">
        <div className="text-xs font-semibold text-text-secondary">专家（0）</div>
        <div className="text-xs text-text-muted">本会话暂无已装载专家</div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-sm" aria-label="本会话专家">
      <div className="whitespace-nowrap text-xs font-semibold text-text-secondary">
        专家（{experts.length}）<span className="ml-xs font-normal text-text-muted">@提及触发</span>
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-xs p-0">
        {experts.map((expert) => (
          <li key={expert.handle} className="inline-flex items-center gap-xs">
            <button
              type="button"
              className="rounded-sm border border-gold/25 bg-surface px-sm py-0.5 text-xs text-gold transition hover:bg-surface-raised"
              onClick={() => onPickHandle?.(expert.handle)}
              aria-label={`@提及 ${expert.handle}`}
            >
              @{expert.handle}
            </button>
            {expert.model && <span className="text-[10px] text-text-muted">{expert.model}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
