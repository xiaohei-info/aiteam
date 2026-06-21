/**
 * W-A.3 群聊专家 roster 展示（#68 / 06 §7.6）。
 *
 * 演示用途：本会话已装载专家的 handle 列表，标注哪些可被 @提及（点击 handle 自动
 * 填入输入框）。真实来源是 pull 装载的 employee 快照（留详设），本卡按演示用
 * mock roster 持有——后端 group.py 注释明确"本卡按请求携带即可端到端验证"。
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
      <div className="group-roster" aria-label="本会话专家">
        <div className="group-roster__header">专家（0）</div>
        <div className="group-roster__empty">本会话暂无已装载专家</div>
      </div>
    );
  }

  return (
    <div className="group-roster" aria-label="本会话专家">
      <div className="group-roster__header">
        专家（{experts.length}）<span className="group-roster__hint">@提及触发</span>
      </div>
      <ul className="group-roster__items">
        {experts.map((expert) => (
          <li key={expert.handle} className="group-roster__item">
            <button
              type="button"
              className="group-roster__handle"
              onClick={() => onPickHandle?.(expert.handle)}
              aria-label={`@提及 ${expert.handle}`}
            >
              @{expert.handle}
            </button>
            {expert.model && <span className="group-roster__model">{expert.model}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
