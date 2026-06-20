/**
 * 应用级会话上下文（08 §12.2）。
 *
 * 持有当前 AuthSession + 访问 token + AgentApiClient + I18n；未登录时 session=null。
 * 401 时清会话并回调（由路由层守卫触发跳登录，不在 client 内跳）。
 *
 * 取舍：AuthSession 类型（shared 契约）不含 token 字段；token 与 session 在本上下文
 * 内成对维护，避免给契约类型打补丁，也避免「session 在但 token 丢」的特殊情况。
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { AuthSession } from "@aiteam/shared/contracts";
import { ApiError } from "@aiteam/shared/api-client";

import { AgentApiClient } from "./api-client";
import { sessionFromClaims } from "./auth-session";
import { createAgentI18n, type I18nInstance } from "./i18n";
import { clearSession, loadSession, saveSession, type StoredSession } from "./token-store";

interface SessionState {
  token: string;
  session: AuthSession;
}

export interface AppContextValue {
  session: AuthSession | null;
  token: string | null;
  client: AgentApiClient;
  i18n: I18nInstance;
  /** 用登录返回的 token + claims 写入会话。 */
  applyLogin: (token: string, claims: AuthSession["claims"]) => void;
  logout: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState | null>(() => {
    const stored = loadSession();
    return stored ? { token: stored.token, session: sessionFromClaims(stored.claims) } : null;
  });
  const [i18n] = useState<I18nInstance>(() => createAgentI18n());

  const persist = useCallback((next: SessionState | null) => {
    if (next) {
      saveSession({ token: next.token, claims: next.session.claims });
    } else {
      clearSession();
    }
    setState(next);
  }, []);

  const applyLogin = useCallback(
    (token: string, claims: AuthSession["claims"]) => {
      persist({ token, session: sessionFromClaims(claims) });
    },
    [persist],
  );

  const logout = useCallback(() => persist(null), [persist]);

  const client = useMemo<AgentApiClient>(() => {
    return new AgentApiClient({
      getToken: () => state?.token ?? null,
      onUnauthorized: () => {
        // 401：清会话，路由守卫将重定向到 /login
        persist(null);
      },
    });
  }, [state, persist]);

  const value = useMemo<AppContextValue>(
    () => ({
      session: state?.session ?? null,
      token: state?.token ?? null,
      client,
      i18n,
      applyLogin,
      logout,
    }),
    [state, client, i18n, applyLogin, logout],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

/** 把任意错误归一为可展示文案（对齐 ApiError 的 status 分支）。 */
export function useApiError(): (err: unknown) => string {
  const { i18n } = useApp();
  return useCallback(
    (err: unknown) => {
      if (err instanceof ApiError) {
        if (err.status === 401) return i18n.t("error.unauthorized");
        if (err.status === 403) return i18n.t("error.forbidden");
        if (err.status === 404) return i18n.t("error.not_found");
        if (err.status === 409) return i18n.t("error.conflict");
        if (err.status === 0) return i18n.t("error.network");
        return i18n.t("agent.login.failed", { detail: err.message });
      }
      return i18n.t("error.unknown");
    },
    [i18n],
  );
}
