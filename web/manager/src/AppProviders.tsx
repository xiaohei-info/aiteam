/**
 * 全局上下文装配：i18n + 会话（token / AuthSession）。
 *
 * 会话态只持本会话 token 与解出的 claims（03 §9.5），不持密钥；
 * token 来源为本端 /api/auth/* login（企业成员账号·认证，Manager 为企业租户身份源）。
 * 401 触发 onUnauthorized → 清会话跳登录。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  type AuthSession,
  type Problem,
  createI18n,
  sharedMessages,
} from "@aiteam/shared";
import { SessionContext, type SessionContextValue } from "./auth/session";
import { I18nContext } from "./i18n/context";
import { managerMessages } from "./i18n/messages";

const TOKEN_STORAGE_KEY = "aiteam.manager.token";

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // 无痕模式或禁用 localStorage：忽略，会话仅存活于内存。
  }
}

/**
 * 简易 JWT claims 解码（仅 base64 解 payload，验签由后端 shared/auth 完成）。
 * 前端只用于 UI 门控与过期判断，真正鉴权在后端（role-state 注释口径）。
 */
function decodeClaims(token: string): AuthSession["claims"] | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    );
    return {
      user_id: String(payload.user_id ?? payload.sub ?? ""),
      roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
      exp: Number(payload.exp ?? 0),
      ...(payload.tenant_id ? { tenant_id: String(payload.tenant_id) } : {}),
      ...(payload.enterprise_id
        ? { enterprise_id: String(payload.enterprise_id) }
        : {}),
    };
  } catch {
    return null;
  }
}

export function AppProviders({ children }: { children: ReactNode }): ReactNode {
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [session, setSession] = useState<AuthSession | null>(null);

  // token 变化时重建 session（claims 从 token 解出；过期视为未登录）。
  useEffect(() => {
    if (!token) {
      setSession(null);
      return;
    }
    const claims = decodeClaims(token);
    if (!claims || claims.exp * 1000 <= Date.now()) {
      setSession(null);
      return;
    }
    setSession({
      principal: {
        id: claims.user_id,
        ...(claims.tenant_id ? { tenant_id: claims.tenant_id } : {}),
        ...(claims.enterprise_id
          ? { enterprise_id: claims.enterprise_id }
          : {}),
        display_name: claims.user_id,
        status: "active",
        roles: claims.roles,
      },
      claims,
    });
  }, [token]);

  // 401 统一回调（api-client 基类收到 401 时调用）：清 token、上层路由跳登录。
  const onUnauthorized = useMemo(
    () => (_problem: Problem | undefined) => {
      writeStoredToken(null);
      setToken(null);
    },
    [],
  );

  const sessionValue = useMemo<SessionContextValue>(
    () => ({
      session,
      token,
      signIn: (newToken: string) => {
        writeStoredToken(newToken);
        setToken(newToken);
      },
      signOut: () => {
        writeStoredToken(null);
        setToken(null);
      },
      onUnauthorized,
    }),
    [session, token, onUnauthorized],
  );

  const i18n = useMemo(() => {
    const instance = createI18n({ locale: "zh-CN", catalog: sharedMessages });
    // 企业端文案合并进共享 catalog（i18n.extend 已做 locale 合并）。
    instance.extend("zh-CN", managerMessages["zh-CN"]!);
    return instance;
  }, []);

  return (
    <I18nContext.Provider value={i18n}>
      <SessionContext.Provider value={sessionValue}>
        {children}
      </SessionContext.Provider>
    </I18nContext.Provider>
  );
}
