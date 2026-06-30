/**
 * 设置页状态钩子（agent 本端 账号/偏好/安全）。
 *
 * - Account：派生自当前 session（whoami 投影，无独立端点）；tokenExp 只读展示。
 * - Preferences：客户端本地状态（localStorage），不上传控制面（本地优先 / D3）。
 * - Security：退出登录走 useApp().logout；无独立端点。
 */

import { useCallback, useState } from "react";
import { useApp } from "../../lib/app-context";
import type { AccountProfile, PreferencesState } from "./types";

const PREFS_KEY = "aiteam.agent.preferences";

export const DEFAULT_PREFERENCES: PreferencesState = {
  locale: "zh-CN",
  streamTypingEffect: true,
};

export function loadPreferences(): PreferencesState {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<PreferencesState>;
    return { ...DEFAULT_PREFERENCES, ...parsed };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(prefs: PreferencesState): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

/** 由当前 session 派生账号投影（无网络请求）。 */
export function useAccount(): { profile: AccountProfile | null } {
  const { session } = useApp();
  if (!session) return { profile: null };
  return {
    profile: {
      principal: session.principal,
      tokenExpiresAt: session.claims.exp,
    },
  };
}

/** 偏好受控钩子：状态 + 持久化写入（写入即同步 i18n locale）。 */
export function usePreferences(): {
  preferences: PreferencesState;
  setPreferences: (next: PreferencesState) => void;
} {
  const { i18n } = useApp();
  const [preferences, setPreferencesState] = useState<PreferencesState>(() => {
    const initial = loadPreferences();
    return { ...initial, locale: i18n.currentLocale };
  });

  const setPreferences = useCallback(
    (next: PreferencesState) => {
      savePreferences(next);
      i18n.setLocale(next.locale);
      setPreferencesState(next);
    },
    [i18n],
  );

  return { preferences, setPreferences };
}

/** 退出登录。 */
export function useLogout(): { logout: () => void } {
  const { logout } = useApp();
  return { logout: useCallback(() => logout(), [logout]) };
}
