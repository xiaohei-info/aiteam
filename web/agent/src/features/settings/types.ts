/** 设置页契约类型。 */

import type { UserPrincipal } from "@aiteam/shared/contracts";

export type SettingsTabId = "account" | "preferences" | "security";

/** 账号投影：从 whoami 派生的只读账号信息。 */
export interface AccountProfile {
  principal: UserPrincipal;
  tokenExpiresAt: number;
}

/** 偏好设置（客户端本地状态，持久化到 localStorage）。 */
export interface PreferencesState {
  locale: string;
  /** 启用流式传输的「打字机」效果（默认开）。 */
  streamTypingEffect: boolean;
}
