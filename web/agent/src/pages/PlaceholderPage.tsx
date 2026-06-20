/**
 * 占位页：工作台 / 私聊 / 群聊（scaffold 阶段）。后续 W-A.2/W-A.3 填真实内容。
 */

import { useApp } from "../lib/app-context";

export function PlaceholderPage({ messageKey }: { messageKey: string }) {
  const { i18n } = useApp();
  return <div className="placeholder-page">{i18n.t(messageKey)}</div>;
}
